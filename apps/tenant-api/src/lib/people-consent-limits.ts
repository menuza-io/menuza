import {
	loyaltyRateCounters,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { hmacHash } from './secrets.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

/**
 * Durable limits for staff-recorded marketing consent (#302), counted in the
 * organization's own database (each tenant database is one organization), so
 * they hold across isolates, Durable Object evictions and restarts.
 *
 * The counters reuse the generic `loyalty_rate_counters` table (bucket,
 * subject hash, fixed window, count) under their own `people_consent.*`
 * buckets: no new table. The subject (a staff member's id, the organization)
 * is stored only as a keyed hash. An attempt is counted before the comparison,
 * so a refusal is not free and parallel requests cannot slip past one read.
 * Windows are fixed, so a burst across a boundary can reach twice the limit
 * once; that is acceptable for these ceilings. Rows of these buckets older
 * than two windows are pruned on every count (the loyalty tick prunes too).
 */
export const PEOPLE_CONSENT_LIMITS = {
	/** Consent writes (on or off) by one staff member (the token `sub`). */
	actorWrites: { max: 60, windowMs: 10 * 60_000 },
	/**
	 * "You're subscribed" confirmation texts for staff-recorded text opt-ins,
	 * per organization. Separate from the node-wide sign-in code cap: these
	 * never draw on it, so recording consent cannot lock guests out of sign-in.
	 */
	smsConfirmations: { max: 100, windowMs: 60 * 60_000 },
} as const

export type PeopleConsentBucket = keyof typeof PEOPLE_CONSENT_LIMITS

const BUCKET_NAMES: Record<PeopleConsentBucket, string> = {
	actorWrites: 'people_consent.write',
	smsConfirmations: 'people_consent.sms',
}

export type PeopleConsentLimitResult =
	{ ok: true } | { ok: false; retryAfterSeconds: number }

/** Counts one attempt in `bucket` for `subject` and says whether it fits. */
export async function countPeopleConsentAttempt(
	db: TenantDatabase | TenantTransaction,
	bucket: PeopleConsentBucket,
	subject: string,
	now = Date.now(),
): Promise<PeopleConsentLimitResult> {
	const { max, windowMs } = PEOPLE_CONSENT_LIMITS[bucket]
	const name = BUCKET_NAMES[bucket]
	const windowStart = Math.floor(now / windowMs) * windowMs
	const subjectHash = hmacHash(`people-consent-rate:${name}:${subject}`)
	const count = await retryOnSqliteBusy(async () => {
		await db
			.insert(loyaltyRateCounters)
			.values({ bucket: name, subjectHash, windowStart, count: 1 })
			.onConflictDoUpdate({
				target: [
					loyaltyRateCounters.bucket,
					loyaltyRateCounters.subjectHash,
					loyaltyRateCounters.windowStart,
				],
				set: { count: sql`${loyaltyRateCounters.count} + 1` },
			})
		const row = await db
			.select({ count: loyaltyRateCounters.count })
			.from(loyaltyRateCounters)
			.where(
				and(
					eq(loyaltyRateCounters.bucket, name),
					eq(loyaltyRateCounters.subjectHash, subjectHash),
					eq(loyaltyRateCounters.windowStart, windowStart),
				),
			)
			.get()
		return row?.count ?? 0
	})
	await pruneOld(db, now).catch(() => {})
	if (count > max) {
		return {
			ok: false,
			retryAfterSeconds: Math.max(
				1,
				Math.ceil((windowStart + windowMs - now) / 1000),
			),
		}
	}
	return { ok: true }
}

async function pruneOld(db: TenantDatabase | TenantTransaction, now: number) {
	const longest = Math.max(
		...Object.values(PEOPLE_CONSENT_LIMITS).map((limit) => limit.windowMs),
	)
	await db
		.delete(loyaltyRateCounters)
		.where(
			and(
				// bounded: two people_consent bucket names only
				inArray(loyaltyRateCounters.bucket, Object.values(BUCKET_NAMES)),
				lt(loyaltyRateCounters.windowStart, now - 2 * longest),
			),
		)
}
