import {
	expandDish,
	expandLines,
	inventoryValueMinor,
	PICKABLE_WASTE_REASONS,
	WASTE_UNDO_WINDOW_MS,
	type LogWasteDish,
	type LogWasteDishResult,
	type SaleLine,
	type StationDishWasteResult,
	type TypedPart,
	type WasteReason,
} from '@repo/inventory'
import {
	invMovements,
	invWaste,
	invWasteCorrections,
	invWasteDishes,
} from '@repo/tenant-db'
import { eq, inArray } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryTx,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	badRequest,
	type InventoryActor,
	locationBusinessDate,
	newId,
	notFound,
} from './inventory-common.ts'
import { loadUnitChanges } from './inventory-history.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { buildRecipeStore, loadItemCosts } from './inventory-recipe-store.ts'
import { ownersOf } from './inventory-sales-service.ts'

/**
 * A whole dish as waste: Kitchen's "Log it as waste?" for a cancelled ticket
 * and the general Log waste picker (App and Station) both come here. The recipe
 * in force now, with the size and options chosen, says which ingredients went
 * to waste; each becomes an `inv_waste` row (and its `waste` movement) grouped
 * under one `inv_waste_dishes` header, so the log reads "2 x Chicken shawarma"
 * and an undo takes the whole group back (#517).
 *
 * - A dish with no recipe but a typed cost is logged at that cost (one row
 *   with a `dish_ref`, no stock). One with neither adds nothing from the
 *   Kitchen path (the cook cannot fix a recipe) and is refused from the picker
 *   (409 `recipe_missing`: "Add a recipe first").
 * - A made item counted in batches is wasted as itself, like a sale uses it.
 * - The same `clientId` answers the first result, so a repeated tap never
 *   doubles it.
 */

type CostMap = Awaited<ReturnType<typeof loadItemCosts>>

type DishWritten = {
	groupId: string
	entries: number
	basis: 'recipe' | 'typed'
	valueMinor: number | null
	currency: string | null
}

const PICKABLE = new Set<string>(PICKABLE_WASTE_REASONS)

const typedValue = (parts: readonly TypedPart[], dishes: number): number =>
	parts.reduce(
		(sum, part) =>
			sum +
			Math.round(
				(part.minor * Number(part.factor.n) * dishes) / Number(part.factor.d),
			),
		0,
	)

/**
 * Writes one dish line as a group. Returns null when the dish has no recipe
 * and no typed cost (the caller decides: skip, or refuse).
 */
async function writeDishGroup(
	tx: InventoryTx,
	input: {
		now: number
		actor: InventoryActor
		locationId: string
		line: SaleLine
		reason: WasteReason
		note: string | null
		groupClientId: string
		/** Client id of ingredient row number `n` of this group. */
		rowClientId: (index: number) => string
		source: 'operator' | 'station'
		deviceId: string | null
		madeAt: number
		costs: CostMap | null
	},
): Promise<DishWritten | null> {
	const { line } = input
	const { store } = await buildRecipeStore(tx, {
		at: input.now,
		owners: ownersOf([line], []),
	})
	const expanded = expandLines(store, [line], input.now)
	if (expanded.errors.length > 0) {
		throw badRequest(expanded.errors[0]!.code)
	}
	const dish = expandDish(store, line, input.now)
	if (!dish.ok) throw badRequest(dish.error.code)
	const typedParts: TypedPart[] = [
		...(dish.typed.dish ? [dish.typed.dish] : []),
		...dish.typed.options,
	]
	if (expanded.usage.length === 0 && typedParts.length === 0) return null

	const costs = input.costs ?? (await loadItemCosts(tx))
	const businessDate = await locationBusinessDate(
		tx,
		input.locationId,
		input.madeAt,
	)
	const groupId = newId()
	await tx.insert(invWasteDishes).values({
		id: groupId,
		clientId: input.groupClientId,
		locationId: input.locationId,
		menuItemId: line.itemId,
		variantId: line.variantId ?? null,
		options:
			line.options && line.options.length > 0
				? JSON.stringify(
						line.options.map((option) => ({
							optionId: option.optionId,
							...(option.quantity ? { quantity: option.quantity } : {}),
							...(option.half ? { half: option.half } : {}),
						})),
					)
				: null,
		quantity: line.quantity,
		basis: expanded.usage.length > 0 ? 'recipe' : 'typed',
		reason: input.reason,
		note: input.note,
		actorKind: input.actor.kind,
		actorId: input.actor.id,
		businessDate,
		source: input.source,
		deviceId: input.deviceId,
		createdAt: input.madeAt,
	})

	let index = 0
	let total = 0
	let currency: string | null = null
	let priced = false
	for (const usage of expanded.usage) {
		const average = costs.average.get(usage.itemId) ?? null
		const itemCurrency =
			costs.currencyByItem.get(usage.itemId) ?? costs.currency
		const value =
			average !== null && itemCurrency
				? inventoryValueMinor(usage.quantity, average)
				: null
		if (value !== null) {
			total += value
			priced = true
			currency ??= itemCurrency
		}
		const id = newId()
		await tx.insert(invWaste).values({
			id,
			locationId: input.locationId,
			itemId: usage.itemId,
			dishRef: line.itemId,
			quantity: usage.quantity,
			reason: input.reason,
			valueMinor: value,
			currency: value === null ? null : itemCurrency,
			actorKind: input.actor.kind,
			actorId: input.actor.id,
			clientId: input.rowClientId(index),
			businessDate,
			source: input.source,
			deviceId: input.deviceId,
			groupId,
			createdAt: input.madeAt,
		})
		await tx.insert(invMovements).values({
			locationId: input.locationId,
			itemId: usage.itemId,
			quantity: -usage.quantity,
			valueMinor: value === null ? null : -value,
			currency: value === null ? null : itemCurrency,
			kind: 'waste',
			reason: input.reason,
			sourceType: 'waste',
			sourceId: id,
			eventKey: `waste:${id}`,
			businessDate,
			actorKind: input.actor.kind,
			actorId: input.actor.id,
			createdAt: input.madeAt,
		})
		index += 1
	}
	if (typedParts.length > 0) {
		// The dish's typed cost: money only, no ingredient and so no stock.
		const minor = typedValue(typedParts, line.quantity)
		const typedCurrency = typedParts[0]!.currency
		await tx.insert(invWaste).values({
			id: newId(),
			locationId: input.locationId,
			itemId: null,
			dishRef: line.itemId,
			quantity: line.quantity * 1000,
			reason: input.reason,
			valueMinor: minor,
			currency: typedCurrency,
			actorKind: input.actor.kind,
			actorId: input.actor.id,
			clientId: input.rowClientId(index),
			businessDate,
			source: input.source,
			deviceId: input.deviceId,
			groupId,
			createdAt: input.madeAt,
		})
		total += minor
		priced = true
		currency ??= typedCurrency
		index += 1
	}
	return {
		groupId,
		entries: index,
		basis: expanded.usage.length > 0 ? 'recipe' : 'typed',
		valueMinor: priced ? total : null,
		currency,
	}
}

/**
 * Kitchen "Log it as waste?": dishes a cook had already started when the
 * ticket was cancelled, voided or refunded, written as waste of their
 * ingredients with the reason "Cancelled after cooking". A dish with no recipe
 * adds nothing (the cook cannot add one).
 */
export async function logDishWaste(
	caller: InventoryCaller,
	input: {
		clientId: string
		locationId: string
		lines: readonly SaleLine[]
		/** The terminal that logged it (waste from a Station is logged against it). */
		deviceId: string
		idempotency: InventoryIdempotency
	},
): Promise<StationDishWasteResult> {
	assertLocationAllowed(caller.locationIds, input.locationId)
	let duplicate = false
	const result = await withInventoryWrite(
		{
			orgId: caller.orgId,
			idempotency: input.idempotency,
			onReplay: () => {
				duplicate = true
			},
		},
		async (tx, ctx) => {
			// A reused client id after the durable replay record expired.
			const prior = await tx
				.select({ id: invWaste.id })
				.from(invWaste)
				.where(eq(invWaste.clientId, `${input.clientId}:0`))
				.get()
			if (prior) return { logged: 0, withoutRecipe: 0, duplicate: true }
			const costs = await loadItemCosts(tx)
			let logged = 0
			let withoutRecipe = 0
			for (const [lineIndex, line] of input.lines.entries()) {
				const written = await writeDishGroup(tx, {
					now: ctx.now,
					actor: caller.actor,
					locationId: input.locationId,
					line,
					reason: 'cancelled_after_cooking',
					note: null,
					groupClientId: `${input.clientId}:dish${lineIndex}`,
					// Ingredient rows keep counting across the lines of the request.
					rowClientId: (index) => `${input.clientId}:${logged + index}`,
					source: 'station',
					deviceId: input.deviceId,
					madeAt: ctx.now,
					costs,
				})
				if (!written) {
					withoutRecipe += 1
					continue
				}
				logged += written.entries
			}
			if (logged > 0) {
				await recordInventoryAudit(tx, {
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					action: 'waste.dish',
					resourceType: 'waste',
					resourceId: input.clientId,
					locationId: input.locationId,
					detail: { ingredients: logged, dishes: input.lines.length },
					at: ctx.now,
				})
			}
			return { logged, withoutRecipe, duplicate: false }
		},
	)
	return duplicate ? { ...result, duplicate: true } : result
}

/**
 * The general Log waste picker (#517): one dish, a quantity, a size and
 * options, and a reason. 409 `recipe_missing` when the dish has neither a
 * recipe nor a typed cost. `station` records the terminal and the device
 * clock (`madeAt`, already clamped by the route).
 */
export async function logWasteDish(
	caller: InventoryCaller,
	input: {
		body: LogWasteDish
		idempotency: InventoryIdempotency
		station?: {
			deviceId: string
			madeAt?: number
			actor?: InventoryActor
			syncedBy?: string
		}
	},
): Promise<LogWasteDishResult> {
	const { body, station } = input
	assertLocationAllowed(caller.locationIds, body.locationId)
	if (!PICKABLE.has(body.reason)) {
		throw new InventoryError('reason_not_allowed', 400)
	}
	let duplicate = false
	const result = await withInventoryWrite(
		{
			orgId: caller.orgId,
			idempotency: input.idempotency,
			onReplay: () => {
				duplicate = true
			},
		},
		async (tx, ctx) => {
			const known = await tx
				.select()
				.from(invWasteDishes)
				.where(eq(invWasteDishes.clientId, body.clientId))
				.get()
			if (known) {
				if (
					known.menuItemId !== body.menuItemId ||
					known.locationId !== body.locationId
				) {
					throw new InventoryError('idempotency_conflict', 409)
				}
				const rows = await tx
					.select({ id: invWaste.id })
					.from(invWaste)
					.where(eq(invWaste.groupId, known.id))
				return {
					id: known.id,
					entries: rows.length,
					basis: known.basis,
					duplicate: true,
					valueMinor: null as number | null,
					currency: null as string | null,
				}
			}
			const actor = station?.actor ?? caller.actor
			const written = await writeDishGroup(tx, {
				now: ctx.now,
				actor,
				locationId: body.locationId,
				line: {
					itemId: body.menuItemId,
					variantId: body.variantId ?? null,
					quantity: body.quantity,
					options: body.options?.map((option) => ({
						optionId: option.optionId,
						quantity: option.quantity,
						half: option.half ?? null,
					})),
				},
				reason: body.reason,
				note: body.note?.length ? body.note : null,
				groupClientId: body.clientId,
				rowClientId: (index) => `${body.clientId}:${index}`,
				source: station ? 'station' : 'operator',
				deviceId: station?.deviceId ?? null,
				madeAt: Math.min(station?.madeAt ?? ctx.now, ctx.now),
				costs: null,
			})
			// "Add a recipe first": nothing to take out and no typed cost to charge.
			if (!written) throw new InventoryError('recipe_missing', 409)
			await recordInventoryAudit(tx, {
				actorKind: actor.kind,
				actorId: actor.id,
				action: 'waste.dish',
				resourceType: 'waste',
				resourceId: written.groupId,
				locationId: body.locationId,
				detail:
					station?.syncedBy && actor.id !== station.syncedBy
						? {
								ingredients: written.entries,
								dishes: body.quantity,
								syncedBy: station.syncedBy,
							}
						: { ingredients: written.entries, dishes: body.quantity },
				at: ctx.now,
			})
			return {
				id: written.groupId,
				entries: written.entries,
				basis: written.basis,
				duplicate: false,
				valueMinor: written.valueMinor,
				currency: written.currency,
			}
		},
	)
	const out: LogWasteDishResult = {
		id: result.id,
		entries: result.entries,
		basis: result.basis,
		duplicate: duplicate || result.duplicate,
	}
	if (caller.cost && result.valueMinor !== null) {
		out.valueMinor = result.valueMinor
		if (result.currency) out.currency = result.currency
	}
	return out
}

/**
 * Takes a whole dish back (#517): every ingredient row gets its reversing row
 * and movement in one transaction, once. Within the undo window (24 hours from
 * the App, or `windowMs` from a tablet, which also needs the person's own
 * entry from this terminal). A dish already corrected later cannot be undone
 * (409 `already_corrected`), and an item whose unit changed since is too old.
 */
export async function undoWasteDish(
	caller: InventoryCaller,
	input: { id: string; clientId: string },
	options: { station?: { deviceId: string; windowMs: number } } = {},
): Promise<{ id: string; entries: number }> {
	const { station } = options
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const header = await tx
			.select()
			.from(invWasteDishes)
			.where(eq(invWasteDishes.id, input.id))
			.get()
		if (!header) throw notFound()
		assertLocationAllowed(caller.locationIds, header.locationId)
		if (
			station &&
			(header.source !== 'station' ||
				header.deviceId !== station.deviceId ||
				header.actorKind !== caller.actor.kind ||
				header.actorId !== caller.actor.id)
		) {
			throw notFound()
		}
		const rows = await tx
			.select()
			.from(invWaste)
			.where(eq(invWaste.groupId, header.id))
		const originals = rows
			.filter((row) => row.reversesId === null)
			.sort((a, b) => (a.id < b.id ? -1 : 1))
		const reversals = rows.filter((row) => row.reversesId !== null)
		// A repeat of the same undo answers the same.
		if (
			reversals.some((row) => row.clientId === `${input.clientId}:0`) &&
			reversals.length === originals.length
		) {
			return { id: header.id, entries: originals.length }
		}
		if (reversals.length > 0) throw new InventoryError('already_undone', 409)
		const corrected = await queryInChunks(
			originals.map((row) => row.id),
			(chunk) =>
				tx
					.select({ id: invWasteCorrections.id })
					.from(invWasteCorrections)
					.where(inArray(invWasteCorrections.wasteId, chunk)),
		)
		if (corrected.length > 0) throw new InventoryError('already_corrected', 409)
		if (
			ctx.now - header.createdAt >
			(station?.windowMs ?? WASTE_UNDO_WINDOW_MS)
		) {
			throw new InventoryError('undo_expired', 409)
		}
		const itemIds = originals.flatMap((row) => (row.itemId ? [row.itemId] : []))
		const changes = await loadUnitChanges(tx, itemIds)
		for (const row of originals) {
			if (
				row.itemId &&
				changes.get(row.itemId)?.some((change) => change.at > row.createdAt)
			) {
				throw new InventoryError('undo_expired', 409)
			}
		}
		const businessDate = await locationBusinessDate(
			tx,
			header.locationId,
			ctx.now,
		)
		for (const [index, original] of originals.entries()) {
			const id = newId()
			await tx.insert(invWaste).values({
				id,
				locationId: original.locationId,
				itemId: original.itemId,
				dishRef: original.dishRef,
				quantity: original.quantity,
				reason: original.reason,
				note: null,
				valueMinor: original.valueMinor,
				currency: original.currency,
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				clientId: `${input.clientId}:${index}`,
				reversesId: original.id,
				groupId: header.id,
				businessDate,
				source: station ? 'station' : 'operator',
				deviceId: station?.deviceId ?? null,
				createdAt: ctx.now,
			})
			if (original.itemId) {
				await tx.insert(invMovements).values({
					locationId: original.locationId,
					itemId: original.itemId,
					quantity: original.quantity,
					valueMinor: original.valueMinor,
					currency: original.currency,
					kind: 'waste',
					reason: original.reason,
					sourceType: 'waste',
					sourceId: id,
					eventKey: `waste-undo:${original.id}`,
					businessDate,
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					createdAt: ctx.now,
				})
			}
		}
		await recordInventoryAudit(tx, {
			actorKind: caller.actor.kind,
			actorId: caller.actor.id,
			action: 'waste.undo',
			resourceType: 'waste',
			resourceId: header.id,
			locationId: header.locationId,
			detail: { entries: originals.length },
			at: ctx.now,
		})
		return { id: header.id, entries: originals.length }
	})
}
