import {
	customers,
	customerSubscriptions,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm'
import { chunkIds, inJsonList } from '../lib/chunked-in.ts'
import { OPAQUE_ID_PATTERN } from '../lib/http.ts'
import { BROADCAST_TOPIC, emailConsentHash } from './marketing-audience.ts'
import { type PeopleAccess } from './people-service.ts'
import { countedOrderCondition } from './report-records.ts'

/**
 * Shared building blocks for the Customers summary tiles
 * (`GET /operator/people/summary`) and the list filters the tiles link to
 * (`returning`, `subscribed`). Both read the SAME CTEs and predicates below,
 * so a tile's number and the filtered list's `total` always agree.
 *
 * The CTEs are appended to `peopleCte` (they reference nothing from it) and
 * the predicates are written against its `p` rows (`p.key`,
 * `p.consent_customer_id`).
 */

/** Locations a token reaches; `null` is every location (no claim). */
export type PeopleLocationScope = string[] | null

/** More locations than this in one claim is not a real member: fail closed. */
const MAX_LOCATION_IDS = 500

/**
 * Reads the `people` token's `locationIds` claim fail-closed, like the orders
 * token: absent or `null` reaches every location (a token from an App that
 * predates the claim, or a member scoped to all locations); anything present
 * but malformed (not an array, a non-string or over-long id, too many ids)
 * reaches none.
 */
export function readPeopleLocationIds(
	payload: Record<string, unknown>,
): PeopleLocationScope {
	if (!('locationIds' in payload) || payload.locationIds === null) return null
	const value = payload.locationIds
	if (!Array.isArray(value) || value.length > MAX_LOCATION_IDS) return []
	const ids: string[] = []
	for (const id of value) {
		if (typeof id !== 'string' || !OPAQUE_ID_PATTERN.test(id)) return []
		ids.push(id)
	}
	return [...new Set(ids)]
}

export type PeopleStatsOptions = {
	/** Location scope from the token; null is organization-wide. */
	locationIds: PeopleLocationScope
	/** `at <= cutoffMs` is "as of 30 days ago" for the returning count. */
	cutoffMs: number
	/**
	 * Customers whose marketing email row was confirmed for their CURRENT
	 * address (`loadEmailConsentMatches`). Only needed when an email predicate
	 * is used; otherwise pass `[]`.
	 */
	emailMatches: readonly string[]
}

/**
 * Customer ids whose `marketing` email subscription carries a
 * `confirmed_email_hash` that matches the customer's current address. The
 * hash is an HMAC (`emailConsentHash`, the rule `loadBroadcastAudience` and
 * `hasMarketingConsent` apply), which SQL cannot compute, so this one step
 * reads the narrow (id, email, hash) rows and checks them here. Whether the
 * row is active (and since when) is left to SQL. Rows without a hash (pending
 * double opt-in) are never read.
 */
export async function loadEmailConsentMatches(
	db: TenantDatabase,
): Promise<string[]> {
	const rows = await db
		.select({
			customerId: customerSubscriptions.customerId,
			email: customers.email,
			hash: customerSubscriptions.confirmedEmailHash,
		})
		.from(customerSubscriptions)
		.innerJoin(customers, eq(customers.id, customerSubscriptions.customerId))
		.where(
			and(
				eq(customerSubscriptions.topic, BROADCAST_TOPIC),
				eq(customerSubscriptions.channel, 'email'),
				isNotNull(customerSubscriptions.confirmedEmailHash),
			),
		)
		.all()
	const ids: string[] = []
	for (const row of rows) {
		const email = row.email?.trim()
		if (email && row.hash === emailConsentHash(email)) ids.push(row.customerId)
	}
	return ids
}

/**
 * One JSON array per bound parameter (DO SQLite allows 100 parameters and
 * 2 MB per string): `column IN (json_each(?) UNION ALL json_each(?) ...)`.
 */
const JSON_LIST_CHUNK = 20_000
const MAX_JSON_LIST_CHUNKS = 40

function inLargeJsonList(column: SQL, ids: readonly string[]): SQL {
	if (ids.length === 0) return sql`0`
	const chunks = chunkIds(ids, JSON_LIST_CHUNK)
	if (chunks.length > MAX_JSON_LIST_CHUNKS) {
		throw new Error('people_stats_too_many_subscribers')
	}
	const parts = chunks.map(
		(chunk) => sql`SELECT value FROM json_each(${JSON.stringify(chunk)})`,
	)
	return sql`${column} IN (${sql.join(parts, sql` UNION ALL `)})`
}

/**
 * The person key a reservation's live guest is listed under (the same rule
 * as `peopleCte`): a guest linked to a customer is part of that customer's
 * row, any other live guest is its own row.
 */
const RSV_PERSON_KEY = sql.raw(
	`CASE WHEN g.customer_id IS NOT NULL THEN 'c_' || g.customer_id ELSE 'g_' || g.id END`,
)
const RSV_LIVE_GUEST_JOIN = sql.raw(
	`JOIN rsv_guests g ON g.id = r.guest_id AND g.merged_into_id IS NULL AND g.erased_at IS NULL`,
)

/**
 * Extra CTEs (to append inside `peopleCte`'s WITH):
 *  - `ev`: one row per counted order or visit, keyed by person, with its time
 *    in ms. Counted orders: restaurant orders that count as sales
 *    (`countedOrderCondition`: open or completed and payable; cancelled,
 *    expired, payment-review and unpaid online ones do not) and paid shop
 *    orders. Visits: `finished` reservations of a live guest, read only when
 *    the caller holds the dining facet (a customers-only member learns
 *    nothing about reservations from these numbers). Under a location scope,
 *    only orders and visits at those locations count, and shop orders (which
 *    have no location) do not.
 *  - `evs`: per person, how many (`n`) and how many by the cutoff (`n_then`).
 *  - `inscope` (only with a location scope): people with any order, or any
 *    reservation (dining facet only), at one of the locations.
 *  - `sub`: marketing subscriptions that are deliverable under the
 *    `hasMarketingConsent` rules apart from "active", which the predicates
 *    check with the timestamps: texts need a verified phone, emails a
 *    confirmed hash of the current address.
 */
export function peopleStatsCtes(
	access: PeopleAccess,
	opts: PeopleStatsOptions,
): SQL {
	const dining = access.dining !== 'none'
	const scope = opts.locationIds
	const orderLoc = scope
		? sql`AND ${inJsonList(sql.raw('location_id'), scope)}`
		: sql``
	const rsvLoc = scope
		? sql`AND ${inJsonList(sql.raw('r.location_id'), scope)}`
		: sql``
	const events: SQL[] = [
		sql`SELECT 'c_' || customer_id AS key, created_at * 1000 AS at FROM restaurant_orders
			WHERE customer_id IS NOT NULL AND ${countedOrderCondition()} ${orderLoc}`,
	]
	if (!scope) {
		events.push(sql`SELECT 'c_' || customer_id AS key, created_at * 1000 AS at FROM shop_orders
			WHERE customer_id IS NOT NULL AND status = 'paid'`)
	}
	if (dining) {
		events.push(sql`SELECT ${RSV_PERSON_KEY} AS key, COALESCE(r.finished_at, r.end_at) AS at
			FROM rsv_reservations r ${RSV_LIVE_GUEST_JOIN}
			WHERE r.status = 'finished' ${rsvLoc}`)
	}
	const ctes: SQL[] = [
		sql`ev AS (${sql.join(events, sql` UNION ALL `)})`,
		sql`evs AS (
			SELECT key, COUNT(*) AS n,
				SUM(CASE WHEN at <= ${opts.cutoffMs} THEN 1 ELSE 0 END) AS n_then
			FROM ev GROUP BY key)`,
	]
	if (scope) {
		const present: SQL[] = [
			sql`SELECT 'c_' || customer_id AS key FROM restaurant_orders
				WHERE customer_id IS NOT NULL ${orderLoc}`,
		]
		if (dining) {
			present.push(sql`SELECT ${RSV_PERSON_KEY} AS key
				FROM rsv_reservations r ${RSV_LIVE_GUEST_JOIN}
				WHERE 1 = 1 ${rsvLoc}`)
		}
		ctes.push(sql`inscope AS (${sql.join(present, sql` UNION `)})`)
	}
	ctes.push(sql`sub AS (
		SELECT s.customer_id AS customer_id, s.channel AS channel,
			s.subscribed_at AS subscribed_at, s.unsubscribed_at AS unsubscribed_at
		FROM customer_subscriptions s JOIN customers c ON c.id = s.customer_id
		WHERE s.topic = ${BROADCAST_TOPIC} AND (
			(s.channel = 'sms' AND COALESCE(c.phone_verified, 0) = 1 AND COALESCE(c.phone, '') <> '')
			OR (s.channel = 'email' AND ${inLargeJsonList(sql.raw('s.customer_id'), opts.emailMatches)})
		))`)
	return sql.join(ctes, sql`, `)
}

/** In the token's location scope (always true without a scope). */
export function inScopePredicate(scope: PeopleLocationScope): SQL | null {
	return scope ? sql`p.key IN (SELECT key FROM inscope)` : null
}

/** Returning: more than one counted order and/or visit (now, or by the cutoff). */
export function returningPredicate(asOf: 'now' | 'then' = 'now'): SQL {
	return asOf === 'now'
		? sql`p.key IN (SELECT key FROM evs WHERE n >= 2)`
		: sql`p.key IN (SELECT key FROM evs WHERE n_then >= 2)`
}

export type SubscribedChannel = 'email' | 'sms'

/**
 * Subscriber on a channel. `now`: the subscription is active. `gained`:
 * active and (re)subscribed after the cutoff. `lost`: subscribed by the
 * cutoff and unsubscribed after it.
 */
export function subscribedPredicate(
	channel: SubscribedChannel,
	which: 'now' | 'gained' | 'lost' = 'now',
	cutoffSec = 0,
): SQL {
	const when =
		which === 'now'
			? sql`unsubscribed_at IS NULL`
			: which === 'gained'
				? sql`unsubscribed_at IS NULL AND subscribed_at > ${cutoffSec}`
				: sql`subscribed_at <= ${cutoffSec} AND unsubscribed_at > ${cutoffSec}`
	return sql`p.consent_customer_id IN (SELECT customer_id FROM sub WHERE channel = ${channel} AND ${when})`
}
