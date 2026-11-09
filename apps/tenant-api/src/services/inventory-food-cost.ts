import { foodCostBp, type foodCostSchema } from '@repo/inventory'
import { addDays } from '@repo/reservations'
import { invCounts, invMovements } from '@repo/tenant-db'
import { and, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm'
import { type z } from 'zod'
import { type InventoryReader } from '../lib/inventory-write.ts'
import { readItemSales } from './item-sales.ts'

export type FoodCost = z.infer<typeof foodCostSchema>

async function ledgerSum(
	db: InventoryReader,
	locationId: string,
	where: ReturnType<typeof and>,
): Promise<number> {
	const row = await db
		.select({
			total: sql<number>`coalesce(sum(${invMovements.valueMinor}), 0)`,
		})
		.from(invMovements)
		.where(and(eq(invMovements.locationId, locationId), where))
		.get()
	return Number(row?.total ?? 0)
}

/** The currency of the inventory's money (one per organization), if any value exists. */
export async function inventoryCurrency(
	db: InventoryReader,
	locationId: string,
): Promise<string | null> {
	const row = await db
		.select({ currency: invMovements.currency })
		.from(invMovements)
		.where(
			and(
				eq(invMovements.locationId, locationId),
				sql`${invMovements.currency} is not null`,
			),
		)
		.limit(1)
		.get()
	return row?.currency ?? null
}

/**
 * Food cost between the two most recent approved full counts at a location:
 * (opening value + purchases - closing value) / net sales. Values come from
 * the ledger (the sum of valued movements up to each approval), purchases
 * are the delivery movements between the two approvals, and sales are read
 * from every channel for the business days after the opening count through
 * the closing count's day (counts are taken after close). Money: callers
 * only use this for tokens with the cost grant.
 */
export async function computeFoodCost(
	db: InventoryReader,
	input: { locationId: string; targetBp: number },
): Promise<FoodCost> {
	const counts = await db
		.select()
		.from(invCounts)
		.where(
			and(
				eq(invCounts.locationId, input.locationId),
				eq(invCounts.status, 'approved'),
				isNull(invCounts.listId),
			),
		)
		.orderBy(desc(invCounts.approvedAt), desc(invCounts.id))
		.limit(2)
	const closing = counts[0]
	const opening = counts[1]
	if (
		!closing ||
		!opening ||
		closing.approvedAt === null ||
		opening.approvedAt === null
	) {
		return {
			state: 'need_two_counts',
			from: null,
			to: null,
			targetBp: input.targetBp,
		}
	}
	const [openingMinor, closingMinor, purchasesMinor, currency] =
		await Promise.all([
			ledgerSum(
				db,
				input.locationId,
				lte(invMovements.createdAt, opening.approvedAt),
			),
			ledgerSum(
				db,
				input.locationId,
				lte(invMovements.createdAt, closing.approvedAt),
			),
			ledgerSum(
				db,
				input.locationId,
				and(
					eq(invMovements.kind, 'delivery'),
					gt(invMovements.createdAt, opening.approvedAt),
					lte(invMovements.createdAt, closing.approvedAt),
				),
			),
			inventoryCurrency(db, input.locationId),
		])
	const sales = await readItemSales(db, {
		locationId: input.locationId,
		fromDate: addDays(opening.businessDate, 1),
		toDate: closing.businessDate,
	})
	const wanted = currency ?? sales.items[0]?.currency ?? null
	const salesMinor = sales.items
		.filter((row) => row.currency === wanted)
		.reduce((sum, row) => sum + row.netSalesMinor, 0)
	const base: FoodCost = {
		state: 'ok',
		from: opening.businessDate,
		to: closing.businessDate,
		targetBp: input.targetBp,
		openingMinor,
		purchasesMinor,
		closingMinor,
		salesMinor,
	}
	const bp = foodCostBp({
		openingMinor,
		purchasesMinor,
		closingMinor,
		salesMinor,
	})
	if (bp === null) return { ...base, state: 'no_sales' }
	return { ...base, bp }
}
