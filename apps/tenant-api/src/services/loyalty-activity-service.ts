import {
	LoyaltyDomainError,
	type LoyaltyOperatorLedgerEntry,
	type LoyaltyOperatorParkedSource,
	type LoyaltyOperatorPurchase,
	type LoyaltyOperatorRedemption,
} from '@repo/loyalty'
import {
	loyaltyLedger,
	loyaltyMembers,
	loyaltyOutbox,
	loyaltyPurchases,
	loyaltyRedemptions,
} from '@repo/tenant-db'
import {
	and,
	asc,
	desc,
	eq,
	isNull,
	ne,
	notExists,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from 'drizzle-orm'
import { inJsonList } from '../lib/chunked-in.ts'
import { type LoyaltyReader } from '../lib/loyalty-write.ts'
import {
	beforeCursor,
	decodeLoyaltyCursor,
	encodeLoyaltyCursor,
	LOYALTY_PAGE_LIMIT,
	toOperatorLedgerEntry,
	toOperatorPurchase,
	toOperatorRedemption,
} from './loyalty-member-service.ts'

/**
 * Operator reads across members: the activity feed and the review queue.
 * Both honor the token's location scope. Rows with no location (member-level
 * events such as manual adjustments) are visible to every scope; a row tied
 * to a location outside the token's list is never returned.
 */

function pageLimit(limit: number | undefined): number {
	return Math.min(Math.max(limit ?? LOYALTY_PAGE_LIMIT, 1), LOYALTY_PAGE_LIMIT)
}

/** Scope condition: org-wide rows plus the token's locations. */
export function scopeCondition(
	column: SQLWrapper,
	locationIds: readonly string[] | null,
): SQL | undefined {
	if (locationIds === null) return undefined
	if (locationIds.length === 0) return isNull(column)
	// A token may name up to 200 locations: one JSON parameter, not 200.
	return or(isNull(column), inJsonList(column, locationIds))
}

export async function listLoyaltyActivity(
	db: LoyaltyReader,
	input: {
		locationIds: readonly string[] | null
		/** Optional single-location filter; must be inside the token's scope. */
		locationId?: string | null
		cursor?: string | null
		limit?: number
	},
): Promise<{
	entries: LoyaltyOperatorLedgerEntry[]
	nextCursor: string | null
}> {
	const limit = pageLimit(input.limit)
	const cursor = decodeLoyaltyCursor(input.cursor)
	const conditions: Array<SQL | undefined> = [
		beforeCursor(loyaltyLedger.at, loyaltyLedger.id, cursor),
	]
	if (input.locationId) {
		if (
			input.locationIds !== null &&
			!input.locationIds.includes(input.locationId)
		) {
			throw new LoyaltyDomainError('location_forbidden')
		}
		conditions.push(eq(loyaltyLedger.locationId, input.locationId))
	} else {
		conditions.push(scopeCondition(loyaltyLedger.locationId, input.locationIds))
	}
	// The customer link (null once erased) lets the App open the customer page.
	const rows = await db
		.select({ entry: loyaltyLedger, customerId: loyaltyMembers.customerId })
		.from(loyaltyLedger)
		.innerJoin(loyaltyMembers, eq(loyaltyMembers.id, loyaltyLedger.memberId))
		.where(and(...conditions))
		.orderBy(desc(loyaltyLedger.at), desc(loyaltyLedger.id))
		.limit(limit + 1)
		.all()
	const page = rows.slice(0, limit)
	const last = page[page.length - 1]?.entry
	return {
		entries: page.map((row) =>
			toOperatorLedgerEntry(row.entry, row.customerId),
		),
		nextCursor:
			rows.length > limit && last
				? encodeLoyaltyCursor(last.at, last.id)
				: null,
	}
}

/**
 * A column of the parked source's redemption: the open one, else the last it
 * released (as `latestRedemptionForSourceInTx` picks it).
 */
function parkedRedemption(column: SQLWrapper): SQL {
	return sql`(select ${column} from ${loyaltyRedemptions} where ${loyaltyRedemptions.sourceType} = ${loyaltyOutbox.sourceType} and ${loyaltyRedemptions.sourceId} = ${loyaltyOutbox.sourceId} order by (${loyaltyRedemptions.state} = 'released'), ${loyaltyRedemptions.updatedAt} desc, ${loyaltyRedemptions.id} desc limit 1)`
}

/**
 * Parked sources with nothing in review. A parked source with a purchase or
 * redemption in review is not listed: answering those closes it.
 */
async function listParkedWithoutReview(
	db: LoyaltyReader,
	locationIds: readonly string[] | null,
): Promise<LoyaltyOperatorParkedSource[]> {
	// Same rule as the requeue route: the purchase's location, else the hold's.
	const locationId = sql<
		string | null
	>`coalesce(${loyaltyPurchases.locationId}, ${parkedRedemption(loyaltyRedemptions.locationId)})`
	const memberId = sql<
		string | null
	>`coalesce(${loyaltyPurchases.memberId}, ${parkedRedemption(loyaltyRedemptions.memberId)})`
	const rows = await db
		.select({
			sourceType: loyaltyOutbox.sourceType,
			sourceId: loyaltyOutbox.sourceId,
			memberId,
			locationId,
			attempts: loyaltyOutbox.attempts,
			lastError: loyaltyOutbox.lastError,
			parkedAt: loyaltyOutbox.updatedAt,
		})
		.from(loyaltyOutbox)
		.leftJoin(
			loyaltyPurchases,
			and(
				eq(loyaltyPurchases.sourceType, loyaltyOutbox.sourceType),
				eq(loyaltyPurchases.sourceId, loyaltyOutbox.sourceId),
			),
		)
		.where(
			and(
				eq(loyaltyOutbox.status, 'failed'),
				or(isNull(loyaltyPurchases.id), ne(loyaltyPurchases.state, 'review')),
				notExists(
					db
						.select({ id: loyaltyRedemptions.id })
						.from(loyaltyRedemptions)
						.where(
							and(
								eq(loyaltyRedemptions.sourceType, loyaltyOutbox.sourceType),
								eq(loyaltyRedemptions.sourceId, loyaltyOutbox.sourceId),
								eq(loyaltyRedemptions.state, 'review'),
							),
						),
				),
				scopeCondition(locationId, locationIds),
			),
		)
		.orderBy(
			asc(loyaltyOutbox.updatedAt),
			asc(loyaltyOutbox.sourceType),
			asc(loyaltyOutbox.sourceId),
		)
		.limit(LOYALTY_PAGE_LIMIT)
		.all()
	return rows.map((row) => ({
		sourceType: row.sourceType,
		sourceId: row.sourceId,
		memberId: row.memberId ?? null,
		locationId: row.locationId ?? null,
		attempts: row.attempts,
		lastError: row.lastError,
		parkedAt: row.parkedAt,
	}))
}

/**
 * What waits on an operator: redemptions and purchases in review, and parked
 * sources with neither.
 */
export async function getLoyaltyReviewQueue(
	db: LoyaltyReader,
	input: { locationIds: readonly string[] | null },
): Promise<{
	redemptions: LoyaltyOperatorRedemption[]
	purchases: LoyaltyOperatorPurchase[]
	parked: LoyaltyOperatorParkedSource[]
}> {
	const redemptions = await db
		.select()
		.from(loyaltyRedemptions)
		.where(
			and(
				eq(loyaltyRedemptions.state, 'review'),
				scopeCondition(loyaltyRedemptions.locationId, input.locationIds),
			),
		)
		.orderBy(asc(loyaltyRedemptions.reviewAt), asc(loyaltyRedemptions.id))
		.limit(LOYALTY_PAGE_LIMIT)
		.all()
	const purchases = await db
		.select()
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.state, 'review'),
				scopeCondition(loyaltyPurchases.locationId, input.locationIds),
			),
		)
		.orderBy(asc(loyaltyPurchases.updatedAt), asc(loyaltyPurchases.id))
		.limit(LOYALTY_PAGE_LIMIT)
		.all()
	return {
		redemptions: redemptions.map(toOperatorRedemption),
		purchases: purchases.map(toOperatorPurchase),
		parked: await listParkedWithoutReview(db, input.locationIds),
	}
}
