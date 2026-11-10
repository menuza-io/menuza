import {
	expandLines,
	inventoryValueMinor,
	type SaleLine,
	type StationDishWasteResult,
} from '@repo/inventory'
import { invMovements, invWaste } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import {
	type InventoryIdempotency,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import {
	assertLocationAllowed,
	locationBusinessDate,
	newId,
} from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { buildRecipeStore, loadItemCosts } from './inventory-recipe-store.ts'
import { ownersOf } from './inventory-sales-service.ts'

/**
 * Kitchen "Log it as waste?": dishes a cook had already started when the
 * ticket was cancelled, voided or refunded, written as waste of their
 * ingredients with the reason "Cancelled after cooking". The recipe in force
 * now decides what went to waste; a dish with no recipe adds nothing. The
 * same `clientId` answers the first result, so a repeated tap never doubles
 * it. A made item that is counted in batches is wasted as itself, like a sale
 * uses it.
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
			const { store } = await buildRecipeStore(tx, {
				at: ctx.now,
				owners: ownersOf(input.lines, []),
			})
			const expanded = expandLines(store, input.lines, ctx.now)
			const costs = expanded.usage.length > 0 ? await loadItemCosts(tx) : null
			const businessDate = await locationBusinessDate(
				tx,
				input.locationId,
				ctx.now,
			)
			let index = 0
			for (const line of expanded.usage) {
				const average = costs?.average.get(line.itemId) ?? null
				const value =
					average !== null && costs?.currency
						? inventoryValueMinor(line.quantity, average)
						: null
				const id = newId()
				await tx.insert(invWaste).values({
					id,
					locationId: input.locationId,
					itemId: line.itemId,
					quantity: line.quantity,
					reason: 'cancelled_after_cooking',
					valueMinor: value,
					currency: value === null ? null : costs!.currency,
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					clientId: `${input.clientId}:${index}`,
					businessDate,
					source: 'station',
					deviceId: input.deviceId,
					createdAt: ctx.now,
				})
				await tx.insert(invMovements).values({
					locationId: input.locationId,
					itemId: line.itemId,
					quantity: -line.quantity,
					valueMinor: value === null ? null : -value,
					currency: value === null ? null : costs!.currency,
					kind: 'waste',
					reason: 'cancelled_after_cooking',
					sourceType: 'waste',
					sourceId: id,
					eventKey: `waste:${id}`,
					businessDate,
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					createdAt: ctx.now,
				})
				index += 1
			}
			if (index > 0) {
				await recordInventoryAudit(tx, {
					actorKind: caller.actor.kind,
					actorId: caller.actor.id,
					action: 'waste.dish',
					resourceType: 'waste',
					resourceId: input.clientId,
					locationId: input.locationId,
					detail: { ingredients: index, dishes: input.lines.length },
					at: ctx.now,
				})
			}
			return {
				logged: index,
				withoutRecipe: expanded.unrecipedLines.length,
				duplicate: false,
			}
		},
	)
	return duplicate ? { ...result, duplicate: true } : result
}
