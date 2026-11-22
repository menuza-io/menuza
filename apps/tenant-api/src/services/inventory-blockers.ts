import { type Blocker } from '@repo/inventory'
import {
	invCountEntries,
	invCountListItems,
	invCounts,
	invItemGroupMembers,
	invItemGroups,
	invOrderLines,
	invOrders,
	invTransferLines,
	invTransfers,
} from '@repo/tenant-db'
import { and, eq, inArray } from 'drizzle-orm'
import { type InventoryReader } from '../lib/inventory-write.ts'

/**
 * What stops a change that rewrites an item's identity or unit (#494, #493):
 * an open count the item is part of, an open transfer or request with a line
 * for it, an order that is not closed with a line for it. The dialog lists
 * them so the person knows what to finish first. Closed records never block.
 */
export async function itemBlockers(
	db: InventoryReader,
	itemId: string,
	options: { groups?: boolean } = {},
): Promise<Blocker[]> {
	const blockers: Blocker[] = []

	const openCounts = await db
		.select({
			id: invCounts.id,
			locationId: invCounts.locationId,
			listId: invCounts.listId,
			businessDate: invCounts.businessDate,
		})
		.from(invCounts)
		.where(inArray(invCounts.status, ['counting', 'in_review']))
	if (openCounts.length > 0) {
		const lists = await db
			.select({ listId: invCountListItems.listId })
			.from(invCountListItems)
			.where(eq(invCountListItems.itemId, itemId))
		const inList = new Set(lists.map((row) => row.listId))
		const entries = await db
			.selectDistinct({ countId: invCountEntries.countId })
			.from(invCountEntries)
			.where(eq(invCountEntries.itemId, itemId))
		const counted = new Set(entries.map((row) => row.countId))
		for (const count of openCounts) {
			if (
				count.listId === null ||
				inList.has(count.listId) ||
				counted.has(count.id)
			) {
				blockers.push({
					kind: 'open_count',
					id: count.id,
					locationId: count.locationId,
					reference: count.businessDate,
				})
			}
		}
	}

	const transfers = await db
		.select({
			id: invTransfers.id,
			status: invTransfers.status,
		})
		.from(invTransferLines)
		.innerJoin(invTransfers, eq(invTransfers.id, invTransferLines.transferId))
		.where(
			and(
				eq(invTransferLines.itemId, itemId),
				inArray(invTransfers.status, ['requested', 'draft', 'sent']),
			),
		)
	for (const transfer of transfers) {
		blockers.push({
			kind: 'open_transfer',
			id: transfer.id,
			locationId: null,
			reference: null,
		})
	}

	const orders = await db
		.select({ id: invOrders.id, number: invOrders.number })
		.from(invOrderLines)
		.innerJoin(invOrders, eq(invOrders.id, invOrderLines.orderId))
		.where(
			and(
				eq(invOrderLines.itemId, itemId),
				inArray(invOrders.status, ['draft', 'sent', 'partly_received']),
			),
		)
	for (const order of orders) {
		blockers.push({
			kind: 'open_order',
			id: order.id,
			locationId: null,
			reference: String(order.number),
		})
	}

	if (options.groups) {
		const member = await db
			.select({ groupItemId: invItemGroupMembers.groupItemId })
			.from(invItemGroupMembers)
			.where(eq(invItemGroupMembers.memberItemId, itemId))
			.get()
		if (member) {
			blockers.push({
				kind: 'in_group',
				id: member.groupItemId,
				locationId: null,
				reference: null,
			})
		}
		const group = await db
			.select({ itemId: invItemGroups.itemId })
			.from(invItemGroups)
			.where(eq(invItemGroups.itemId, itemId))
			.get()
		if (group) {
			blockers.push({
				kind: 'is_group',
				id: group.itemId,
				locationId: null,
				reference: null,
			})
		}
	}
	return blockers
}
