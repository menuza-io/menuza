import { type SoldOutList } from '@repo/inventory'
import { getTenantDb, invItems, invSoldOut } from '@repo/tenant-db'
import { and, asc, eq } from 'drizzle-orm'
import { postInventoryAvailability } from '../lib/inventory-availability.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { assertLocationAllowed, notFound } from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'

/**
 * What stock took off the menu, and the manager's undo. See
 * `inventory-auto-sold-out.ts` for how entries come and go.
 */

export async function listSoldOut(
	db: InventoryReader,
	input: { locationId: string },
): Promise<SoldOutList> {
	const rows = await db
		.select({
			id: invSoldOut.id,
			locationId: invSoldOut.locationId,
			entityType: invSoldOut.entityType,
			entityId: invSoldOut.entityId,
			causeItemId: invSoldOut.causeItemId,
			causeItemName: invItems.name,
			state: invSoldOut.state,
			soldAt: invSoldOut.soldAt,
		})
		.from(invSoldOut)
		.innerJoin(invItems, eq(invItems.id, invSoldOut.causeItemId))
		.where(eq(invSoldOut.locationId, input.locationId))
		.orderBy(asc(invSoldOut.soldAt), asc(invSoldOut.id))
		.limit(500)
	return { locationId: input.locationId, entries: rows }
}

/**
 * Puts a dish back on the menu although stock is still at zero. The App is
 * asked first; only when it confirms (or the dish was already back) is the
 * entry kept as `undone`, so the dish is not taken off again until the
 * ingredient has been in stock. A second undo answers the same.
 */
export async function undoSoldOut(
	caller: InventoryCaller,
	input: {
		id: string
		/** Posts to the App (tests replace it). */
		post?: typeof postInventoryAvailability
	},
): Promise<SoldOutList['entries'][number]> {
	const db = await getTenantDb(caller.orgId)
	const row = await db
		.select()
		.from(invSoldOut)
		.where(eq(invSoldOut.id, input.id))
		.get()
	if (!row) throw notFound()
	assertLocationAllowed(caller.locationIds, row.locationId)
	if (row.state === 'out') {
		const outcome = await (input.post ?? postInventoryAvailability)({
			orgId: caller.orgId,
			locationId: row.locationId,
			changes: [
				{
					entityType: row.entityType,
					entityId: row.entityId,
					available: true,
				},
			],
		})
		if (outcome.status !== 'applied') {
			throw new InventoryError('inventory_unavailable', 503)
		}
	}
	return withInventoryWrite({ orgId: caller.orgId }, async (tx, ctx) => {
		const current = await tx
			.select()
			.from(invSoldOut)
			.where(eq(invSoldOut.id, input.id))
			.get()
		if (!current) throw notFound()
		if (current.state === 'out') {
			await tx
				.update(invSoldOut)
				.set({
					state: 'undone',
					undoneAt: ctx.now,
					undoneByKind: caller.actor.kind,
					undoneById: caller.actor.id,
					updatedAt: ctx.now,
				})
				.where(and(eq(invSoldOut.id, current.id), eq(invSoldOut.state, 'out')))
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'sold_out.undo',
				resourceType: 'item',
				resourceId: current.causeItemId,
				locationId: current.locationId,
				detail: { entityType: current.entityType },
				at: ctx.now,
			})
		}
		const item = await tx
			.select({ name: invItems.name })
			.from(invItems)
			.where(eq(invItems.id, current.causeItemId))
			.get()
		return {
			id: current.id,
			locationId: current.locationId,
			entityType: current.entityType,
			entityId: current.entityId,
			causeItemId: current.causeItemId,
			causeItemName: item?.name ?? '',
			state: 'undone' as const,
			soldAt: current.soldAt,
		}
	})
}
