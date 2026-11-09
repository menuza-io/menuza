import {
	createRecipeStore,
	inventoryValueMinor,
	MAX_ENTRY_QUANTITY,
	recipeInForce,
	type RecipeVersion,
} from '@repo/inventory'
import { invItems, invMovements } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	badRequest,
	loadItemUnits,
	locationBusinessDate,
	markUnitsUsed,
	newId,
	notFound,
	typedToBase,
} from './inventory-common.ts'
import { type RecordBatchInput } from './inventory-contract-types.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { loadItemCosts, loadVersionsAt } from './inventory-recipe-store.ts'

/**
 * Recording a batch of a made item ("Record a batch" in the item sheet, and
 * later Prep): the made item goes into stock and its ingredients come out, as
 * one idempotent write at one location.
 *
 * - The recipe in force NOW is used (`recipe_empty` when there is none).
 * - Ingredients come out at their raw quantity (usable yield applied). There
 *   is NO recursion: an ingredient that is itself a made item is taken out as
 *   itself, whether or not it is counted in batches.
 * - Each movement is valued at the item's weighted average cost when it has
 *   one. The made item's `batch_made` value is the sum of the ingredient
 *   values taken out, so the batch adds no value out of nothing (when some
 *   ingredient has no cost, the made value is that of the priced ones; with
 *   none priced it is left out). The made item's own average cost is not
 *   updated here.
 */

/** `numerator / denominator` rounded half up, for positive BigInts. */
function divRound(numerator: bigint, denominator: bigint): bigint {
	return (numerator + denominator / 2n) / denominator
}

export type RecordBatchResult = {
	id: string
	madeQuantity: number
	used: { itemId: string; quantity: number; valueMinor?: number }[]
	valueMinor?: number
	currency?: string
}

export async function recordBatch(
	caller: InventoryCaller,
	input: {
		itemId: string
		body: RecordBatchInput
		idempotency: InventoryIdempotency
	},
): Promise<RecordBatchResult> {
	const { body } = input
	assertLocationAllowed(caller.locationIds, body.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const item = await tx
				.select()
				.from(invItems)
				.where(eq(invItems.id, input.itemId))
				.get()
			if (!item || item.archivedAt !== null) throw notFound()
			if (item.kind !== 'made') throw new InventoryError('not_a_made_item', 400)

			const versions = await loadVersionsAt(tx, 'made_item', [item.id], ctx.now)
			const recipe: RecipeVersion | null = recipeInForce(
				createRecipeStore({ recipes: versions }),
				'made_item',
				item.id,
				ctx.now,
			)
			if (!recipe || recipe.lines.length === 0 || !recipe.makesQuantity) {
				throw new InventoryError('recipe_empty', 409)
			}
			const makes = recipe.makesQuantity

			// What came out, in base thousandths of the made item.
			let madeQuantity: number
			if (body.made.kind === 'batches') {
				madeQuantity = Math.round(makes * body.made.count)
			} else {
				const units = (await loadItemUnits(tx, [item.id])).get(item.id) ?? []
				const converted = typedToBase(
					body.made.amount,
					body.made.unit,
					item.baseUnit,
					units,
				)
				madeQuantity = converted.quantity
				if (converted.named)
					await markUnitsUsed(tx, [converted.named.id], ctx.now)
			}
			if (madeQuantity < 1 || madeQuantity > MAX_ENTRY_QUANTITY) {
				throw badRequest('amount_out_of_range')
			}

			// Raw quantity of each ingredient for that many thousandths.
			const used = recipe.lines.flatMap((line) => {
				const raw = Number(
					divRound(
						BigInt(line.quantity) * 10_000n * BigInt(madeQuantity),
						BigInt(line.usableBp) * BigInt(makes),
					),
				)
				if (raw > MAX_ENTRY_QUANTITY) throw badRequest('amount_out_of_range')
				return raw > 0 ? [{ itemId: line.itemId, quantity: raw }] : []
			})
			if (used.length === 0) throw badRequest('amount_out_of_range')

			const eventPrefix = `batch:${item.id}:${body.clientId}`
			const existing = await tx
				.select({ id: invMovements.id })
				.from(invMovements)
				.where(eq(invMovements.eventKey, `${eventPrefix}:made`))
				.get()
			// A durable replay answered before this ran; this is a reused id
			// after the replay record expired.
			if (existing) throw new InventoryError('idempotency_conflict', 409)

			const costs = await loadItemCosts(tx)
			const businessDate = await locationBusinessDate(
				tx,
				body.locationId,
				ctx.now,
			)
			const batchId = newId()
			const note = body.note?.length ? body.note : null
			const base = {
				locationId: body.locationId,
				sourceType: 'batch',
				sourceId: batchId,
				businessDate,
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				note,
				createdAt: ctx.now,
			} as const

			const usedOut: RecordBatchResult['used'] = []
			let valueMinor = 0
			let priced = 0
			for (const line of used) {
				const average = costs.average.get(line.itemId) ?? null
				const value =
					average === null ? null : inventoryValueMinor(line.quantity, average)
				await tx.insert(invMovements).values({
					...base,
					id: newId(),
					itemId: line.itemId,
					quantity: -line.quantity,
					valueMinor: value === null ? null : -value,
					currency: value === null ? null : costs.currency,
					kind: 'batch_used',
					eventKey: `${eventPrefix}:used:${line.itemId}`,
				})
				const out: RecordBatchResult['used'][number] = {
					itemId: line.itemId,
					quantity: line.quantity,
				}
				if (value !== null) {
					if (caller.cost) out.valueMinor = value
					valueMinor += value
					priced++
				}
				usedOut.push(out)
			}
			const madeId = newId()
			await tx.insert(invMovements).values({
				...base,
				id: madeId,
				itemId: item.id,
				quantity: madeQuantity,
				valueMinor: priced > 0 ? valueMinor : null,
				currency: priced > 0 ? costs.currency : null,
				kind: 'batch_made',
				eventKey: `${eventPrefix}:made`,
			})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'batch.record',
				resourceType: 'item',
				resourceId: item.id,
				locationId: body.locationId,
				detail: { madeQuantity, ingredients: used.length },
				at: ctx.now,
			})
			const result: RecordBatchResult = {
				id: madeId,
				madeQuantity,
				used: usedOut,
			}
			if (caller.cost && priced > 0) {
				result.valueMinor = valueMinor
				if (costs.currency) result.currency = costs.currency
			}
			return result
		},
	)
}
