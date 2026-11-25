import {
	costMicroFromPackPrice,
	inventoryValueMinor,
	type PutTransferTerms,
	type TransferTerm,
	type TransfersOwed,
} from '@repo/inventory'
import {
	getTenantDb,
	invItems,
	invMovements,
	invTransferLines,
	invTransferTerms,
	invTransfers,
} from '@repo/tenant-db'
import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	assertVersion,
	badRequest,
	loadItemUnits,
	notFound,
	typedToBase,
} from './inventory-common.ts'
import {
	type InventoryCaller,
	loadLocationStock,
} from './inventory-items-service.ts'
import { loadItemCosts } from './inventory-recipe-store.ts'
import { transferPriceFor } from './inventory-transfers-service.ts'

/**
 * Transfer prices and "branches can request this" (#526), per item at the
 * SENDING location. A row exists only once an owner sets something: no row
 * means no price (the receiver is charged cost) and branches may ask for it.
 * The price in force is copied onto a transfer's lines when it is SENT
 * (`sendTransfer`), so changing it later never touches a sent transfer.
 * Prices are money: reading or setting one needs the cost grant.
 */

type TermsRow = typeof invTransferTerms.$inferSelect

function toTerm(
	item: Pick<typeof invItems.$inferSelect, 'id' | 'name' | 'baseUnit'>,
	row: TermsRow | null,
	caller: InventoryCaller,
	money: { costMicro: number | null; currency: string | null },
): TransferTerm {
	const term: TransferTerm = {
		itemId: item.id,
		itemName: item.name,
		baseUnit: item.baseUnit,
		branchRequestable: row?.branchRequestable ?? true,
		version: row?.version ?? 0,
	}
	if (!caller.cost) return term
	term.priceMode = row?.priceMode ?? 'none'
	term.fixedPriceMicro = row?.fixedPriceMicro ?? null
	term.markupBp = row?.markupBp ?? null
	term.currency = row?.currency ?? money.currency ?? undefined
	term.costMicro = money.costMicro
	const price = transferPriceFor(row, {
		averageMicro: money.costMicro,
		itemCurrency: money.currency,
		sendCurrency: null,
	})
	term.effectivePriceMicro = price?.micro ?? money.costMicro
	return term
}

/** The items the sending location keeps, with what an owner set for each. */
export async function listTransferTerms(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationId: string
		onlySet: boolean
		search?: string
	},
): Promise<{ terms: TransferTerm[] }> {
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const [stock, rows, costs] = await Promise.all([
		loadLocationStock(db, input.locationId),
		db
			.select()
			.from(invTransferTerms)
			.where(eq(invTransferTerms.locationId, input.locationId)),
		loadItemCosts(db),
	])
	const byItem = new Map(rows.map((row) => [row.itemId, row]))
	const search = input.search?.trim().toLowerCase()
	const terms: TransferTerm[] = []
	for (const entry of stock) {
		const row = byItem.get(entry.item.id) ?? null
		// What the place keeps, and anything an owner set terms for.
		if (!entry.place && row === null) continue
		if (input.onlySet) {
			const set =
				row !== null && (!row.branchRequestable || row.priceMode !== 'none')
			if (!set) continue
		}
		if (search && !entry.item.name.toLowerCase().includes(search)) continue
		terms.push(
			toTerm(entry.item, row, input.caller, {
				costMicro: costs.average.get(entry.item.id) ?? null,
				currency: costs.currencyByItem.get(entry.item.id) ?? null,
			}),
		)
	}
	terms.sort(
		(a, b) =>
			a.itemName.toLowerCase().localeCompare(b.itemName.toLowerCase()) ||
			(a.itemId < b.itemId ? -1 : 1),
	)
	return { terms: terms.slice(0, 500) }
}

/** Sets the terms of one item at the sending location. A price needs the cost grant. */
export async function putTransferTerms(
	caller: InventoryCaller,
	input: { itemId: string; body: PutTransferTerms },
): Promise<TransferTerm> {
	const { body } = input
	assertLocationAllowed(caller.locationIds, body.locationId)
	const touchesPrice =
		body.priceMode !== undefined ||
		body.fixedPrice !== undefined ||
		body.markupBp !== undefined
	if (touchesPrice && !caller.cost) throw new InventoryError('forbidden', 403)
	await withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const item = await tx
			.select()
			.from(invItems)
			.where(eq(invItems.id, input.itemId))
			.get()
		if (!item || item.archivedAt !== null) throw notFound()
		const existing = await tx
			.select()
			.from(invTransferTerms)
			.where(
				and(
					eq(invTransferTerms.itemId, item.id),
					eq(invTransferTerms.locationId, body.locationId),
				),
			)
			.get()
		assertVersion(existing?.version ?? 0, body.expectedVersion)
		const next = {
			branchRequestable:
				body.branchRequestable ?? existing?.branchRequestable ?? true,
			priceMode: existing?.priceMode ?? ('none' as const),
			fixedPriceMicro: existing?.fixedPriceMicro ?? null,
			currency: existing?.currency ?? null,
			markupBp: existing?.markupBp ?? null,
		}
		if (body.priceMode !== undefined) {
			next.priceMode = body.priceMode
			if (body.priceMode === 'none') {
				next.fixedPriceMicro = null
				next.currency = null
				next.markupBp = null
			}
			if (body.priceMode === 'fixed') {
				const fixed = body.fixedPrice!
				const units = await loadItemUnits(tx, [item.id])
				let pack: number
				try {
					pack = typedToBase(
						1,
						fixed.per,
						item.baseUnit,
						units.get(item.id) ?? [],
					).quantity
				} catch (error) {
					if (error instanceof InventoryError) throw error
					throw badRequest('unit')
				}
				if (pack <= 0) throw badRequest('unit')
				next.fixedPriceMicro = costMicroFromPackPrice(fixed.priceMinor, pack)
				next.currency = fixed.currency
				next.markupBp = null
			}
			if (body.priceMode === 'cost_plus') {
				next.markupBp = body.markupBp!
				next.fixedPriceMicro = null
				next.currency = null
			}
		}
		await tx
			.insert(invTransferTerms)
			.values({
				itemId: item.id,
				locationId: body.locationId,
				...next,
				version: 1,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			.onConflictDoUpdate({
				target: [invTransferTerms.itemId, invTransferTerms.locationId],
				set: {
					...next,
					version: (existing?.version ?? 0) + 1,
					updatedAt: ctx.now,
				},
			})
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'transfer.terms',
			resourceType: 'transfer_terms',
			resourceId: item.id,
			locationId: body.locationId,
			detail: {
				branchRequestable: next.branchRequestable,
				priceMode: next.priceMode,
			},
			at: ctx.now,
		})
	})
	// Read back the item's terms as they stand now.
	const db = await getTenantDb(caller.orgId)
	const [item, row, costs] = await Promise.all([
		db.select().from(invItems).where(eq(invItems.id, input.itemId)).get(),
		db
			.select()
			.from(invTransferTerms)
			.where(
				and(
					eq(invTransferTerms.itemId, input.itemId),
					eq(invTransferTerms.locationId, body.locationId),
				),
			)
			.get(),
		loadItemCosts(db),
	])
	if (!item) throw notFound()
	return toTerm(item, row ?? null, caller, {
		costMicro: costs.average.get(item.id) ?? null,
		currency: costs.currencyByItem.get(item.id) ?? null,
	})
}

/**
 * What each branch owes the sending place for transfers SENT in a period (the
 * sender's business dates): the amount sent times the price fixed on each
 * line (the cost where none was set), beside the same stock at cost. Counts
 * only without the cost grant.
 */
export async function transfersOwed(
	db: InventoryReader,
	input: {
		caller: InventoryCaller
		locationId: string
		from: string
		to: string
	},
): Promise<TransfersOwed> {
	assertLocationAllowed(input.caller.locationIds, input.locationId)
	const sentMovements = await db
		.select({ sourceId: invMovements.sourceId })
		.from(invMovements)
		.where(
			and(
				eq(invMovements.locationId, input.locationId),
				eq(invMovements.kind, 'transfer_out'),
				eq(invMovements.sourceType, 'transfer'),
				gte(invMovements.businessDate, input.from),
				lte(invMovements.businessDate, input.to),
			),
		)
	const transferIds = [...new Set(sentMovements.map((row) => row.sourceId))]
	const transfers = await queryInChunks(transferIds, (chunk) =>
		db.select().from(invTransfers).where(inArray(invTransfers.id, chunk)),
	)
	const lines = await queryInChunks(transferIds, (chunk) =>
		db
			.select()
			.from(invTransferLines)
			.where(inArray(invTransferLines.transferId, chunk)),
	)
	const money = input.caller.cost
	type Bucket = {
		transfers: Set<string>
		lines: number
		owed: number
		cost: number
		priced: boolean
	}
	const byBranch = new Map<string, Bucket>()
	const transferById = new Map(transfers.map((row) => [row.id, row]))
	let currency: string | undefined
	for (const line of lines) {
		const transfer = transferById.get(line.transferId)
		if (!transfer || transfer.fromLocationId !== input.locationId) continue
		const sent = line.sentQuantity ?? 0
		if (sent <= 0) continue
		const bucket = byBranch.get(transfer.toLocationId) ?? {
			transfers: new Set<string>(),
			lines: 0,
			owed: 0,
			cost: 0,
			priced: false,
		}
		bucket.transfers.add(transfer.id)
		bucket.lines += 1
		const unit = line.priceMicro ?? line.unitCostMicro
		if (unit !== null) {
			bucket.owed += inventoryValueMinor(sent, unit)
			bucket.priced = true
			currency ??= line.costCurrency ?? undefined
		}
		if (line.unitCostMicro !== null) {
			bucket.cost += inventoryValueMinor(sent, line.unitCostMicro)
		}
		byBranch.set(transfer.toLocationId, bucket)
	}
	const rows = [...byBranch.entries()]
		.sort(
			(a, b) =>
				(money ? b[1].owed - a[1].owed : 0) ||
				b[1].transfers.size - a[1].transfers.size ||
				(a[0] < b[0] ? -1 : 1),
		)
		.map(([toLocationId, bucket]) => ({
			toLocationId,
			transfers: bucket.transfers.size,
			lines: bucket.lines,
			...(money && bucket.priced
				? { owedMinor: bucket.owed, costMinor: bucket.cost }
				: {}),
			...(money && bucket.priced && currency ? { currency } : {}),
		}))
	const result: TransfersOwed = { from: input.from, to: input.to, rows }
	if (money && rows.some((row) => row.owedMinor !== undefined)) {
		result.owedMinor = rows.reduce((sum, row) => sum + (row.owedMinor ?? 0), 0)
		result.costMinor = rows.reduce((sum, row) => sum + (row.costMinor ?? 0), 0)
		if (currency) result.currency = currency
	}
	return result
}

/** The items a place does not offer to branches (ids only). */
export async function listNotOffered(
	db: InventoryReader,
	input: { fromLocationId: string },
): Promise<{ itemIds: string[] }> {
	const rows = await db
		.select({ itemId: invTransferTerms.itemId })
		.from(invTransferTerms)
		.where(
			and(
				eq(invTransferTerms.locationId, input.fromLocationId),
				eq(invTransferTerms.branchRequestable, false),
			),
		)
	return { itemIds: rows.map((row) => row.itemId).sort() }
}
