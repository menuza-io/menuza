import { and, count, eq, gte, lt } from 'drizzle-orm'
import { smsSendEvents, type TenantDatabase } from '@repo/tenant-db'
import { hmacHash } from '../lib/secrets.ts'

/**
 * Durable send-code limits, counted from `sms_send_events` in the
 * organization's own database so they hold across isolates and restarts.
 *
 * The customer app has no Turnstile widget, so its requests skip the challenge
 * on a header any client can send. Those requests get much tighter ceilings
 * than browser requests that passed Turnstile.
 */
export type SmsSendKind = 'browser' | 'native'

const HOUR_MS = 60 * 60 * 1000
const RETENTION_MS = 24 * HOUR_MS

export const NATIVE_SEND_LIMITS = {
	perPhonePerHour: 3,
	perIpPerHour: 10,
	perOrganizationPerHour: 100,
} as const

function phoneHash(phone: string) {
	return hmacHash(`sms-send-phone:${phone}`)
}

function ipHash(ip: string | null | undefined) {
	return hmacHash(`sms-send-ip:${ip || 'unknown'}`)
}

async function countSince(
	db: TenantDatabase,
	since: Date,
	condition: ReturnType<typeof eq>,
) {
	const [row] = await db
		.select({ total: count() })
		.from(smsSendEvents)
		.where(
			and(
				condition,
				eq(smsSendEvents.kind, 'native'),
				gte(smsSendEvents.at, since),
			),
		)
	return row?.total ?? 0
}

/**
 * For a header-only (native) request: the number of seconds to wait when an
 * hourly ceiling is reached, or null when the code may be sent. Browser
 * requests are not limited here.
 */
export async function nativeSendRetryAfter(
	db: TenantDatabase,
	params: { phone: string; ip: string | null | undefined; now?: number },
): Promise<number | null> {
	const now = params.now ?? Date.now()
	const since = new Date(now - HOUR_MS)
	const [perPhone, perIp, perOrg] = await Promise.all([
		countSince(db, since, eq(smsSendEvents.phoneHash, phoneHash(params.phone))),
		countSince(db, since, eq(smsSendEvents.ipHash, ipHash(params.ip))),
		countSince(db, since, eq(smsSendEvents.kind, 'native')),
	])
	if (
		perPhone >= NATIVE_SEND_LIMITS.perPhonePerHour ||
		perIp >= NATIVE_SEND_LIMITS.perIpPerHour ||
		perOrg >= NATIVE_SEND_LIMITS.perOrganizationPerHour
	) {
		// The oldest counted send leaves the window within the hour.
		return Math.ceil(HOUR_MS / 1000)
	}
	return null
}

/** Records one send and drops rows older than a day. */
export async function recordSmsSend(
	db: TenantDatabase,
	params: {
		kind: SmsSendKind
		phone: string
		ip: string | null | undefined
		now?: number
	},
) {
	const now = params.now ?? Date.now()
	await db
		.insert(smsSendEvents)
		.values({
			at: new Date(now),
			kind: params.kind,
			phoneHash: phoneHash(params.phone),
			ipHash: ipHash(params.ip),
		})
		.run()
	await db
		.delete(smsSendEvents)
		.where(lt(smsSendEvents.at, new Date(now - RETENTION_MS)))
		.run()
}
