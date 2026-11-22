import { RESTAURANT_SALES_ORDER_STATUSES } from './restaurant-orders.ts'

/**
 * Dish photo A/B tests (#192). Pure: Sites picks the variant, the region
 * counts, the App decides the winner; all three use these rules.
 *
 * - A visitor is assigned by a hash of an anonymous client id and the test id,
 *   so the same visitor keeps the same photo for the whole test. The id is
 *   never stored with a count.
 * - Search engines (and any client that cannot hold an id: the customer app's
 *   cached menu, delivery menus) always get photo A.
 * - The win measure is orders per view. A test names a winner only after
 *   `PHOTO_TEST_MIN_VIEWS` views of each photo AND `PHOTO_TEST_MIN_DAYS` days.
 * - Cancelled, refunded and unpaid orders never count as orders.
 */

export type PhotoVariant = 'A' | 'B'
export const PHOTO_VARIANTS: readonly PhotoVariant[] = ['A', 'B']

export const PHOTO_TEST_MIN_VIEWS = 200
export const PHOTO_TEST_MIN_DAYS = 7
export const PHOTO_TEST_MAX_ACTIVE = 20
/** A counter batch carries at most this many entries. */
export const PHOTO_TEST_MAX_BATCH = 50

const DAY_MS = 24 * 60 * 60 * 1000

export function isPhotoVariant(value: unknown): value is PhotoVariant {
	return value === 'A' || value === 'B'
}

/** FNV-1a, 32 bit: tiny, dependency free and identical in every runtime. */
export function hashString(value: string): number {
	let hash = 0x811c9dc5
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	// A final avalanche: FNV's low bit alone is weak for similar inputs.
	hash ^= hash >>> 16
	hash = Math.imul(hash, 0x85ebca6b) >>> 0
	hash ^= hash >>> 13
	hash = Math.imul(hash, 0xc2b2ae35) >>> 0
	hash ^= hash >>> 16
	return hash >>> 0
}

const CRAWLER_PATTERN =
	/bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|pinterest|whatsapp|telegram|discordbot|headlesschrome|lighthouse|pagespeed|gtmetrix|google-inspectiontool|apis-google|mediapartners|adsbot|duckduck|baidu|yandex|semrush|ahrefs|uptime|monitor|curl\/|wget\/|python-requests|node-fetch|undici|postmanruntime/i

/** Search engines, link previews and scripts. An empty agent counts as one. */
export function isCrawlerUserAgent(userAgent: string | null | undefined) {
	if (!userAgent || !userAgent.trim()) return true
	return CRAWLER_PATTERN.test(userAgent)
}

/** What Sites needs to decide: who is asking and how. */
export type PhotoVariantRequest = {
	testId: string
	/** The anonymous client id; empty when the client keeps none. */
	clientId: string | null | undefined
	userAgent?: string | null
	/** The customer app's cached menu and delivery menus pass `true`. */
	alwaysA?: boolean
}

/**
 * The variant one visitor sees. Crawlers, clients without an id and channels
 * that cannot test always get photo A.
 */
export function assignPhotoVariant(request: PhotoVariantRequest): PhotoVariant {
	if (request.alwaysA) return 'A'
	if (isCrawlerUserAgent(request.userAgent)) return 'A'
	const clientId = request.clientId?.trim()
	if (!clientId) return 'A'
	return hashString(`${request.testId}:${clientId}`) % 2 === 0 ? 'A' : 'B'
}

export type PhotoVariantCounts = {
	views: number
	adds: number
	orders: number
}

export type PhotoTestOutcome =
	| { status: 'not_enough_data'; reason: 'views' | 'days' | 'both' }
	| { status: 'tie' }
	| {
			status: 'winner'
			winner: PhotoVariant
			/** Orders per view of the winner compared with the other, in percent. */
			liftPercent: number | null
	  }

function orderRate(counts: PhotoVariantCounts) {
	return counts.views > 0 ? counts.orders / counts.views : 0
}

/** Whole days between two instants (a started test is day zero). */
export function photoTestDaysRunning(startedAt: Date, now: Date): number {
	return Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS))
}

/**
 * Decides a test. Adds to cart are shown but never pick the winner.
 */
export function evaluatePhotoTest(input: {
	startedAt: Date
	now: Date
	a: PhotoVariantCounts
	b: PhotoVariantCounts
}): PhotoTestOutcome {
	const enoughViews =
		input.a.views >= PHOTO_TEST_MIN_VIEWS &&
		input.b.views >= PHOTO_TEST_MIN_VIEWS
	const enoughDays =
		photoTestDaysRunning(input.startedAt, input.now) >= PHOTO_TEST_MIN_DAYS
	if (!enoughViews || !enoughDays) {
		return {
			status: 'not_enough_data',
			reason:
				!enoughViews && !enoughDays ? 'both' : !enoughViews ? 'views' : 'days',
		}
	}
	const rateA = orderRate(input.a)
	const rateB = orderRate(input.b)
	if (rateA === rateB) return { status: 'tie' }
	const winner: PhotoVariant = rateB > rateA ? 'B' : 'A'
	const winRate = Math.max(rateA, rateB)
	const loseRate = Math.min(rateA, rateB)
	return {
		status: 'winner',
		winner,
		liftPercent:
			loseRate > 0 ? Math.round(((winRate - loseRate) / loseRate) * 100) : null,
	}
}

/** UTC calendar day key used by the regional counters. */
export function photoTestDayKey(at: Date): string {
	return at.toISOString().slice(0, 10)
}

export type PhotoTestEvent = 'view' | 'add' | 'order'

/** Payment statuses that let an online order go ahead (the region's rule). */
const PHOTO_TEST_PAYABLE_PAYMENT_STATUSES: readonly string[] = [
	'paid',
	'not_required',
]

/**
 * One order counts for a photo test only while it is a counted sale (the one
 * rule reports and the region share): a sale status (`accepted`, `preparing`,
 * `ready`, `completed`; never `pending_acceptance`, `cancelled`, `rejected`,
 * `expired`, `payment_review` or `failed`), payable (pay at handoff, or an
 * online order that is `paid` or `not_required`), and not fully refunded. What
 * is really back is `refundedCents - refundReversedCents` (a refund the
 * provider reversed later is not back). A free order (total 0) is not "fully
 * refunded".
 */
export function orderCountsAsPhotoTestWin(order: {
	status: string
	paymentMethod: string
	paymentStatus: string
	totalCents: number
	refundedCents?: number | null
	refundReversedCents?: number | null
}): boolean {
	if (
		!(RESTAURANT_SALES_ORDER_STATUSES as readonly string[]).includes(
			order.status,
		)
	)
		return false
	const payable =
		order.paymentMethod === 'handoff' ||
		PHOTO_TEST_PAYABLE_PAYMENT_STATUSES.includes(order.paymentStatus)
	if (!payable) return false
	const back = Math.max(
		(order.refundedCents ?? 0) - (order.refundReversedCents ?? 0),
		0,
	)
	return !(order.totalCents > 0 && back >= order.totalCents)
}
