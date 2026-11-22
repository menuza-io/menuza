import { type UnitChangeRecord } from '@repo/inventory'
import { invUnitChanges } from '@repo/tenant-db'
import { inArray, isNotNull, asc } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'

/**
 * Unit changes (#494) per item, oldest first, for the readers that show or sum
 * old quantities: the ledger is never rewritten, so a row written before a
 * change is in the unit the item had then and `quantityInCurrentUnit` brings
 * it to today's.
 */
export async function loadUnitChanges(
	db: InventoryReader,
	itemIds?: readonly string[],
): Promise<Map<string, UnitChangeRecord[]>> {
	const rows =
		itemIds === undefined
			? await db
					.select()
					.from(invUnitChanges)
					.where(isNotNull(invUnitChanges.completedAt))
					.orderBy(asc(invUnitChanges.completedAt))
			: (
					await queryInChunks([...new Set(itemIds)], (chunk) =>
						db
							.select()
							.from(invUnitChanges)
							.where(inArray(invUnitChanges.itemId, chunk)),
					)
				)
					.filter((row) => row.completedAt !== null)
					.sort((a, b) => a.completedAt! - b.completedAt!)
	const byItem = new Map<string, UnitChangeRecord[]>()
	for (const row of rows) {
		const list = byItem.get(row.itemId) ?? []
		list.push({
			at: row.completedAt!,
			factor: { num: row.factorNum, den: row.factorDen },
		})
		byItem.set(row.itemId, list)
	}
	return byItem
}
