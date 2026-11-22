import { and, eq, gte, lte, sql } from 'drizzle-orm'
import {
	foldPhotoTestEvents,
	PHOTO_TEST_MAX_DAILY_ROWS,
	PHOTO_TEST_MAX_ROW_COUNT,
	type PhotoTestCounterEvent,
} from '@repo/common/photo-test-events'
import {
	type PhotoTestResult,
	type PhotoTestResultsRequest,
} from '@repo/common/photo-test-results'
import {
	type PhotoVariantCounts,
	photoTestDayKey,
} from '@repo/common/photo-test'
import {
	dishPhotoDaily,
	dishPhotoOrderLines,
	getTenantDb,
	restaurantOrders,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { verifyPhotoTestBeaconKey } from '@repo/common/photo-test-key'
import { insertRowsInChunks } from '../lib/chunked-in.ts'
import { getOperatorToken } from '../lib/secrets.ts'
import { countedOrderCondition } from './report-records.ts'

/**
 * Dish photo A/B test counters (#192). The region holds numbers only:
 * views and adds per UTC day, test, dish and photo (`dish_photo_daily`: no
 * visitor id, address or user agent), and which photo a guest saw for a dish in
 * test when they ordered (`dish_photo_order_lines`: ids only, deleted with the
 * order). The control plane owns the tests; this node only counts.
 */

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

/**
 * Kill switch for this node (`DISH_PHOTO_TESTS_ENABLED`; unset or `true` is
 * on): the beacon answers 204 and counts nothing, so Sites never errors.
 */
export function dishPhotoTestsDisabled(): boolean {
	const raw = process.env.DISH_PHOTO_TESTS_ENABLED
	if (!raw) return false
	return DISABLED_VALUES.has(raw.trim().toLowerCase())
}

/**
 * Keeps the events whose key the App signed for exactly this (organization,
 * test, dish) with the secret it shares with this node. The beacon is public,
 * so without this anyone could invent test ids and fill the day's rows. A node
 * without the secret counts nothing.
 */
export async function verifiedDishPhotoEvents(
	orgId: string,
	events: readonly PhotoTestCounterEvent[],
	options: { secret?: string } = {},
): Promise<PhotoTestCounterEvent[]> {
	const secret = options.secret ?? getOperatorToken()
	if (secret.length < 16) return []
	const verdicts = new Map<string, Promise<boolean>>()
	const kept: PhotoTestCounterEvent[] = []
	for (const event of events) {
		const cacheKey = `${event.testId}\u0000${event.itemId}\u0000${event.key}`
		let verdict = verdicts.get(cacheKey)
		if (!verdict) {
			verdict = verifyPhotoTestBeaconKey(
				secret,
				{ organizationId: orgId, testId: event.testId, itemId: event.itemId },
				event.key,
			)
			verdicts.set(cacheKey, verdict)
		}
		if (await verdict) kept.push(event)
	}
	return kept
}

/**
 * Adds a batch of views and adds. One statement per (test, dish, photo): a
 * key already counted today always counts on; a new key is dropped silently
 * once the organization already holds `PHOTO_TEST_MAX_DAILY_ROWS` rows for the
 * day (the condition and the write are one statement, so a burst cannot step
 * over the cap).
 */
export async function countDishPhotoEvents(
	orgId: string,
	events: readonly PhotoTestCounterEvent[],
	options: { now?: number; db?: TenantDatabase } = {},
): Promise<void> {
	const db = options.db ?? (await getTenantDb(orgId))
	const day = photoTestDayKey(new Date(options.now ?? Date.now()))
	for (const delta of foldPhotoTestEvents(events)) {
		await db.run(sql`
			INSERT INTO dish_photo_daily (day, test_id, item_id, variant, views, adds)
			SELECT ${day}, ${delta.testId}, ${delta.itemId}, ${delta.variant}, ${delta.views}, ${delta.adds}
			WHERE EXISTS (
				SELECT 1 FROM dish_photo_daily
				WHERE day = ${day} AND test_id = ${delta.testId}
					AND item_id = ${delta.itemId} AND variant = ${delta.variant}
			) OR (SELECT count(*) FROM dish_photo_daily WHERE day = ${day}) < ${PHOTO_TEST_MAX_DAILY_ROWS}
			ON CONFLICT (day, test_id, item_id, variant) DO UPDATE SET
				views = views + excluded.views,
				adds = adds + excluded.adds
			WHERE views + adds < ${PHOTO_TEST_MAX_ROW_COUNT}
		`)
	}
}

/**
 * Keeps the order's photo-test entries whose key the App signed for exactly
 * this (organization, test, dish): a guest cannot credit an order to a test
 * that does not exist, or to a dish of another test. Returns entries without
 * the key. A node without the shared secret keeps none.
 */
export async function verifiedPhotoTestEntries(
	orgId: string,
	entries:
		| ReadonlyArray<{
				testId: string
				itemId: string
				variant: 'A' | 'B'
				key: string
		  }>
		| undefined,
	options: { secret?: string } = {},
): Promise<Array<{ testId: string; itemId: string; variant: 'A' | 'B' }>> {
	if (!entries || entries.length === 0) return []
	const secret = options.secret ?? getOperatorToken()
	if (secret.length < 16) return []
	const kept: Array<{ testId: string; itemId: string; variant: 'A' | 'B' }> = []
	for (const entry of entries) {
		if (
			await verifyPhotoTestBeaconKey(
				secret,
				{ organizationId: orgId, testId: entry.testId, itemId: entry.itemId },
				entry.key,
			)
		) {
			kept.push({
				testId: entry.testId,
				itemId: entry.itemId,
				variant: entry.variant,
			})
		}
	}
	return kept
}

/**
 * Stores which photo each dish in test showed this guest, inside the order's
 * own transaction. Only entries whose `itemId` is a dish on the order's lines
 * are kept (the rest is ignored), one row per (test, dish); the first entry
 * for a pair wins.
 */
export async function recordDishPhotoOrderLines(
	tx: TenantTransaction,
	input: {
		orderId: string
		photoTests:
			| ReadonlyArray<{
					testId: string
					itemId: string
					variant: 'A' | 'B'
			  }>
			| undefined
		lines: ReadonlyArray<{ itemId: string }>
	},
): Promise<void> {
	if (!input.photoTests || input.photoTests.length === 0) return
	const dishes = new Set(input.lines.map((line) => line.itemId))
	const seen = new Set<string>()
	const rows: Array<typeof dishPhotoOrderLines.$inferInsert> = []
	for (const entry of input.photoTests) {
		if (!dishes.has(entry.itemId)) continue
		const key = `${entry.testId}\u0000${entry.itemId}`
		if (seen.has(key)) continue
		seen.add(key)
		rows.push({
			orderId: input.orderId,
			testId: entry.testId,
			itemId: entry.itemId,
			variant: entry.variant,
		})
	}
	if (rows.length === 0) return
	await insertRowsInChunks(dishPhotoOrderLines, rows, (chunk) =>
		tx.insert(dishPhotoOrderLines).values(chunk),
	)
}

const EMPTY: PhotoVariantCounts = { views: 0, adds: 0, orders: 0 }

/**
 * Counters of the tests the App names. Views and adds: the UTC days from the
 * start day to the end day (or today) inclusive. Orders: distinct orders that
 * carry the test and the dish, were placed between the start and the end (or
 * now), count as a sale (the one rule reports use) and are not fully refunded.
 */
export async function readPhotoTestResults(
	db: TenantDatabase,
	tests: PhotoTestResultsRequest['tests'],
	options: { now?: number } = {},
): Promise<PhotoTestResult[]> {
	const now = options.now ?? Date.now()
	const results: PhotoTestResult[] = []
	for (const test of tests) {
		const end = test.endedAt ?? now
		const counts = { A: { ...EMPTY }, B: { ...EMPTY } }
		const daily = await db
			.select({
				variant: dishPhotoDaily.variant,
				views: sql<number>`coalesce(sum(${dishPhotoDaily.views}), 0)`,
				adds: sql<number>`coalesce(sum(${dishPhotoDaily.adds}), 0)`,
			})
			.from(dishPhotoDaily)
			.where(
				and(
					eq(dishPhotoDaily.testId, test.testId),
					eq(dishPhotoDaily.itemId, test.itemId),
					gte(dishPhotoDaily.day, photoTestDayKey(new Date(test.startedAt))),
					lte(dishPhotoDaily.day, photoTestDayKey(new Date(end))),
				),
			)
			.groupBy(dishPhotoDaily.variant)
		for (const row of daily) {
			counts[row.variant].views = Number(row.views) || 0
			counts[row.variant].adds = Number(row.adds) || 0
		}
		const orders = await db
			.select({
				variant: dishPhotoOrderLines.variant,
				orders: sql<number>`count(distinct ${dishPhotoOrderLines.orderId})`,
			})
			.from(dishPhotoOrderLines)
			.innerJoin(
				restaurantOrders,
				eq(restaurantOrders.id, dishPhotoOrderLines.orderId),
			)
			.where(
				and(
					eq(dishPhotoOrderLines.testId, test.testId),
					eq(dishPhotoOrderLines.itemId, test.itemId),
					gte(restaurantOrders.createdAt, new Date(test.startedAt)),
					lte(restaurantOrders.createdAt, new Date(end)),
					countedOrderCondition(),
					// Fully refunded (net of refunds the provider reversed): not a
					// sale any more. A free order (total 0) is not "fully refunded".
					sql`NOT (${restaurantOrders.totalCents} > 0 AND max(${restaurantOrders.refundedCents} - ${restaurantOrders.refundReversedCents}, 0) >= ${restaurantOrders.totalCents})`,
				),
			)
			.groupBy(dishPhotoOrderLines.variant)
		for (const row of orders) {
			counts[row.variant].orders = Number(row.orders) || 0
		}
		results.push({
			testId: test.testId,
			itemId: test.itemId,
			A: counts.A,
			B: counts.B,
		})
	}
	return results
}
