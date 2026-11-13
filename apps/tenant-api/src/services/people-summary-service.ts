import { type TenantDatabase } from '@repo/tenant-db'
import { sql, type SQL } from 'drizzle-orm'
import {
	listFilters,
	PEOPLE_CHANGE_WINDOW_DAYS,
	peopleCte,
	requireCustomersFacet,
	type PeopleAccess,
} from './people-service.ts'
import {
	inScopePredicate,
	loadEmailConsentMatches,
	peopleStatsCtes,
	returningPredicate,
	subscribedPredicate,
	type PeopleLocationScope,
} from './people-stats.ts'

const DAY_MS = 86_400_000

export type PeopleSummary = {
	guests: { total: number; change30d: number }
	returningGuests: { total: number; change30d: number; share: number }
	emailSubscribers: { total: number; change30d: number }
	textSubscribers: { total: number; change30d: number }
	/** Whether the numbers are limited to the token's locations. */
	locationScoped: boolean
	asOf: string
}

/**
 * Counts for the Customers page tiles. Counts only: no names, contacts or ids.
 * Needs the customers facet (dining-only members get no marketing counts).
 *
 * Definitions (the list filters `returning` and `subscribed` use the same
 * predicates, see `people-stats.ts`, so tile == filtered list `total`):
 *  - Guests: the Customers list's default population for this token (one row
 *    per person, walk-ins without phone and email left out, consent shadows
 *    folded into their guest). Erased people are gone: their customer row and
 *    subscriptions are deleted and their guests carry `erased_at`.
 *    change30d = guests created in the last 30 days (people are only removed
 *    by erasure, which leaves nothing to count, so this is "now minus 30 days
 *    ago" as far as the data can tell).
 *  - Returning guests: more than one counted order and/or visit in total
 *    (counted restaurant orders, paid shop orders, finished reservations; see
 *    `peopleStatsCtes`). change30d = returning now minus people who already
 *    had two by 30 days ago. share = returning / guests (0 with no guests).
 *  - Email / text subscribers: an active `marketing` subscription on that
 *    channel deliverable under the `hasMarketingConsent` rules (texts: a
 *    verified phone; email: `confirmed_email_hash` matches the CURRENT
 *    address). change30d = gained - lost, where gained = active now and
 *    (re)subscribed in the last 30 days, and lost = subscribed before the
 *    window and unsubscribed inside it. Lost rows are judged by today's
 *    phone and address (a past address change cannot be seen).
 *  - Location scope (`locationIds` claim): only people with an order, or a
 *    reservation (dining facet only), at one of the locations, and only
 *    orders and visits there count toward "returning". `[]` is all zeros;
 *    no claim is organization-wide.
 */
export async function getPeopleSummary(
	db: TenantDatabase,
	access: PeopleAccess,
	opts: { locationIds: PeopleLocationScope; now?: number },
): Promise<PeopleSummary> {
	requireCustomersFacet(access)
	const now = opts.now ?? Date.now()
	const asOf = new Date(now).toISOString()
	const locationScoped = opts.locationIds !== null
	if (opts.locationIds && opts.locationIds.length === 0) {
		return {
			guests: { total: 0, change30d: 0 },
			returningGuests: { total: 0, change30d: 0, share: 0 },
			emailSubscribers: { total: 0, change30d: 0 },
			textSubscribers: { total: 0, change30d: 0 },
			locationScoped,
			asOf,
		}
	}
	const cutoffMs = now - PEOPLE_CHANGE_WINDOW_DAYS * DAY_MS
	const cutoffSec = Math.floor(cutoffMs / 1000)
	const stats = peopleStatsCtes(access, {
		locationIds: opts.locationIds,
		cutoffMs,
		emailMatches: await loadEmailConsentMatches(db),
	})
	const filters = listFilters(access, {}, now)
	const scoped = inScopePredicate(opts.locationIds)
	if (scoped) filters.push(scoped)
	const where =
		filters.length > 0 ? sql`WHERE ${sql.join(filters, sql` AND `)}` : sql``
	const countIf = (predicate: SQL) =>
		sql`COALESCE(SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END), 0)`

	const rows = await db.all<Record<string, number | null>>(sql`${peopleCte(
		access,
		now,
		stats,
	)}
		SELECT
			COUNT(*) AS guests,
			${countIf(sql`p.created_at > ${cutoffMs}`)} AS guests_new,
			${countIf(returningPredicate('now'))} AS returning_now,
			${countIf(returningPredicate('then'))} AS returning_then,
			${countIf(subscribedPredicate('email'))} AS email_now,
			${countIf(subscribedPredicate('email', 'gained', cutoffSec))} AS email_gained,
			${countIf(subscribedPredicate('email', 'lost', cutoffSec))} AS email_lost,
			${countIf(subscribedPredicate('sms'))} AS sms_now,
			${countIf(subscribedPredicate('sms', 'gained', cutoffSec))} AS sms_gained,
			${countIf(subscribedPredicate('sms', 'lost', cutoffSec))} AS sms_lost
		FROM p ${where}`)
	const row = rows[0] ?? {}
	const n = (key: string) => Number(row[key] ?? 0)
	const guests = n('guests')
	const returning = n('returning_now')
	return {
		guests: { total: guests, change30d: n('guests_new') },
		returningGuests: {
			total: returning,
			change30d: returning - n('returning_then'),
			share: guests > 0 ? returning / guests : 0,
		},
		emailSubscribers: {
			total: n('email_now'),
			change30d: n('email_gained') - n('email_lost'),
		},
		textSubscribers: {
			total: n('sms_now'),
			change30d: n('sms_gained') - n('sms_lost'),
		},
		locationScoped,
		asOf,
	}
}
