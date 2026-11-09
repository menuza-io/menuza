import { foodCostBp, type foodCostSchema } from '@repo/inventory'
import { addDays } from '@repo/reservations'
import { invCountEntries, invCounts, invMovements } from '@repo/tenant-db'
import { and, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm'
import { type z } from 'zod'
import { queryInChunks } from '../lib/chunked-in.ts'
import { type InventoryReader } from '../lib/inventory-write.ts'
import { locationBusinessDate } from './inventory-common.ts'
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
 * The instant a count is "as of": the time of its latest entry (the moment the
 * shelves were last measured), not the time it was approved. Approval stamps
 * each adjustment with its item's own entry time (see `approveCount`), so the
 * ledger up to this instant already holds the counted figures. Counts with no
 * entry are absent (callers fall back to `approvedAt`).
 */
export async function countInstants(
	db: InventoryReader,
	countIds: readonly string[],
): Promise<Map<string, number>> {
	const rows = await queryInChunks(countIds, (chunk) =>
		db
			.select({
				countId: invCountEntries.countId,
				at: sql<number>`max(${invCountEntries.createdAt})`,
			})
			.from(invCountEntries)
			.where(inArray(invCountEntries.countId, chunk))
			.groupBy(invCountEntries.countId),
	)
	return new Map(rows.map((row) => [row.countId, Number(row.at)]))
}

/**
 * Food cost between the two most recent approved full counts at a location:
 * (opening value + purchases - closing value) / net sales.
 *
 * The period is defined by ONE pair of instants, the counts' as-of instants
 * (`countInstants`, falling back to the approval time): opening value and
 * closing value are the ledger sums of valued movements up to each instant
 * (`created_at <= instant`), purchases are the delivery and transfer movements
 * in `(opening instant, closing instant]`, and sales are read from every
 * channel for the business days after the opening instant's business day
 * through the closing instant's business day (counts are taken after close, so
 * a count started at 23:30 and approved the next morning still belongs to the
 * day it was counted). `from` / `to` are those two business dates. The
 * approval time does not matter, so a late approval does not move the period.
 * Money: callers only use this for tokens with the cost grant.
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
	let closing = counts[0]
	let opening = counts[1]
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
	const instants = await countInstants(db, [opening.id, closing.id])
	let openingAt = instants.get(opening.id) ?? opening.approvedAt
	let closingAt = instants.get(closing.id) ?? closing.approvedAt
	// Counts approve independently, so the later approval can be the earlier
	// measurement: the period always runs from the earlier instant to the later.
	if (openingAt > closingAt) {
		;[opening, closing] = [closing, opening]
		;[openingAt, closingAt] = [closingAt, openingAt]
	}
	const [openingDate, closingDate] = await Promise.all([
		locationBusinessDate(db, input.locationId, openingAt),
		locationBusinessDate(db, input.locationId, closingAt),
	])
	const [openingMinor, closingMinor, purchasesMinor, currency] =
		await Promise.all([
			ledgerSum(db, input.locationId, lte(invMovements.createdAt, openingAt)),
			ledgerSum(db, input.locationId, lte(invMovements.createdAt, closingAt)),
			ledgerSum(
				db,
				input.locationId,
				and(
					// What came in over the period: deliveries and transfers in, less
					// transfers out (their values are negative, so the sum subtracts).
					inArray(invMovements.kind, [
						'delivery',
						'transfer_in',
						'transfer_out',
					]),
					gt(invMovements.createdAt, openingAt),
					lte(invMovements.createdAt, closingAt),
				),
			),
			inventoryCurrency(db, input.locationId),
		])
	const sales = await readItemSales(db, {
		locationId: input.locationId,
		fromDate: addDays(openingDate, 1),
		toDate: closingDate,
	})
	const wanted = currency ?? sales.items[0]?.currency ?? null
	const salesMinor = sales.items
		.filter((row) => row.currency === wanted)
		.reduce((sum, row) => sum + row.netSalesMinor, 0)
	const base: FoodCost = {
		state: 'ok',
		from: openingDate,
		to: closingDate,
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
