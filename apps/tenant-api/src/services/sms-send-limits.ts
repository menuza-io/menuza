import { and, count, eq, gte, lt, lte, min } from 'drizzle-orm'
import { smsSendEvents, type TenantDatabase } from '@repo/tenant-db'
import { addressBucket } from '../lib/client-ip.ts'
import { hmacHash } from '../lib/secrets.ts'

/**
 * Durable send-code limits, counted from `sms_send_events` in the
 * organization's own database so they hold across isolates and restarts.
 *
 * The customer app has no Turnstile widget, so its requests skip the challenge
 * on a header any client can send. Those requests get much tighter ceilings
 * than browser requests that passed Turnstile.
 *
 * The organization-wide ceiling is shared by everyone, so anyone sending the
 * header could fill it and lock the app's sign-in for the hour. It therefore
 * applies only to numbers that have not verified with this organization: a
 * returning customer still gets a code (within the per-phone and per-IP
 * ceilings), while an attacker can only fill it for new sign-ups. Codes to
 * known numbers cannot be used for SMS pumping to numbers the attacker picks.
 */
export type SmsSendKind = 'browser' | 'native'

const HOUR_MS = 60 * 60 * 1000
const RETENTION_MS = 24 * HOUR_MS
/** Old rows are pruned on roughly one write in this many. */
const PRUNE_EVERY = 25

export const NATIVE_SEND_LIMITS = {
	perPhonePerHour: 3,
	perIpPerHour: 10,
	perOrganizationPerHour: 100,
} as const

function phoneHash(phone: string) {
	return hmacHash(`sms-send-phone:${phone}`)
}

/** IPv6 counts by its /64, as every other limiter here does. */
function ipHash(ip: string) {
	return hmacHash(`sms-send-ip:${addressBucket(ip)}`)
}

/**
 * Count and oldest send of native sends matching `condition` in the window,
 * up to and including row `upToId`: in a parallel burst each request counts
 * only the rows written before it, so the first ones within the ceiling pass.
 */
async function windowUsage(
	db: TenantDatabase,
	since: Date,
	upToId: number,
	condition?: ReturnType<typeof eq>,
) {
	const [row] = await db
		.select({ total: count(), oldest: min(smsSendEvents.at) })
		.from(smsSendEvents)
		.where(
			and(
				eq(smsSendEvents.kind, 'native'),
				gte(smsSendEvents.at, since),
				lte(smsSendEvents.id, upToId),
				...(condition ? [condition] : []),
			),
		)
	return { total: row?.total ?? 0, oldest: row?.oldest ?? null }
}

export type SmsSendReservation =
	{ ok: true } | { ok: false; retryAfter: number }

/**
 * Records one send and, for native requests, enforces the hourly ceilings.
 * The row is written first and the window counted after it, so a parallel
 * burst cannot all pass a count taken before any of them was written: the
 * requests that land over a ceiling remove their own row and are refused.
 * An unknown client IP skips the per-IP ceiling instead of sharing one bucket.
 * `knownCustomer` (the phone already verified with this organization) skips
 * the organization-wide ceiling; the send is still counted toward it.
 */
export async function reserveSmsSend(
	db: TenantDatabase,
	params: {
		kind: SmsSendKind
		phone: string
		ip: string | null | undefined
		/** The phone already verified with this organization. */
		knownCustomer?: boolean
		now?: number
	},
): Promise<SmsSendReservation> {
	const now = params.now ?? Date.now()
	const phone = phoneHash(params.phone)
	const ip = params.ip ? ipHash(params.ip) : ''
	const [row] = await db
		.insert(smsSendEvents)
		.values({
			at: new Date(now),
			kind: params.kind,
			phoneHash: phone,
			ipHash: ip,
		})
		.returning({ id: smsSendEvents.id })

	if (row && row.id % PRUNE_EVERY === 0) {
		await db
			.delete(smsSendEvents)
			.where(lt(smsSendEvents.at, new Date(now - RETENTION_MS)))
			.run()
	}

	if (params.kind !== 'native' || !row) return { ok: true }

	const since = new Date(now - HOUR_MS)
	const buckets = [
		{
			usage: await windowUsage(
				db,
				since,
				row.id,
				eq(smsSendEvents.phoneHash, phone),
			),
			limit: NATIVE_SEND_LIMITS.perPhonePerHour,
		},
		...(ip
			? [
					{
						usage: await windowUsage(
							db,
							since,
							row.id,
							eq(smsSendEvents.ipHash, ip),
						),
						limit: NATIVE_SEND_LIMITS.perIpPerHour,
					},
				]
			: []),
		...(params.knownCustomer
			? []
			: [
					{
						usage: await windowUsage(db, since, row.id),
						limit: NATIVE_SEND_LIMITS.perOrganizationPerHour,
					},
				]),
	]
	const exceeded = buckets.filter(({ usage, limit }) => usage.total > limit)
	if (exceeded.length === 0) return { ok: true }

	await db.delete(smsSendEvents).where(eq(smsSendEvents.id, row.id)).run()
	// Wait until the oldest counted send of every full bucket leaves the hour.
	const retryAfterMs = Math.max(
		...exceeded.map(({ usage }) =>
			usage.oldest ? usage.oldest.getTime() + HOUR_MS - now : HOUR_MS,
		),
	)
	return { ok: false, retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
}
