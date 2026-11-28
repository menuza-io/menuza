import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

/**
 * Signed one-click unsubscribe links for report emails (#121, #221). Server
 * only: it needs `node:crypto`, so it lives apart from `report-schedule.ts`,
 * which App route modules import and which must stay safe for the browser
 * bundle.
 */

export type ReportUnsubscribeTarget =
	| { kind: 'schedule'; scheduleId: string; userId: string }
	| { kind: 'monthly'; organizationId: string; userId: string }
	/** The setup reminder emails (#271): one owner, one organization. */
	| { kind: 'setup'; organizationId: string; userId: string }

const UNSUBSCRIBE_PURPOSE = 'report-unsubscribe:v1'

function unsubscribeKey(secret: string) {
	return createHmac('sha256', secret).update(UNSUBSCRIBE_PURPOSE).digest()
}

function b64(input: Buffer | string) {
	return Buffer.from(input).toString('base64url')
}

/**
 * A signed token for the unsubscribe link in a report email. It names one
 * recipient and one thing to switch off, carries no expiry (a link in an old
 * email must still work) and signs nothing else: an HMAC of the payload.
 */
export function signReportUnsubscribeToken(
	target: ReportUnsubscribeTarget,
	secret: string,
): string {
	if (secret.length < 16)
		throw new Error('Unsubscribe secret is not configured')
	const payload = b64(JSON.stringify(target))
	const mac = createHmac('sha256', unsubscribeKey(secret))
		.update(payload)
		.digest()
	return `${payload}.${b64(mac)}`
}

const targetSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('schedule'),
		scheduleId: z.string().min(1).max(64),
		userId: z.string().min(1).max(64),
	}),
	z.object({
		kind: z.literal('monthly'),
		organizationId: z.string().min(1).max(64),
		userId: z.string().min(1).max(64),
	}),
	z.object({
		kind: z.literal('setup'),
		organizationId: z.string().min(1).max(64),
		userId: z.string().min(1).max(64),
	}),
])

/** The target a token names, or null for anything forged, edited or malformed. */
export function verifyReportUnsubscribeToken(
	token: string,
	secret: string,
): ReportUnsubscribeTarget | null {
	if (secret.length < 16 || token.length > 600) return null
	const [payload, mac, extra] = token.split('.')
	if (!payload || !mac || extra !== undefined) return null
	const expected = createHmac('sha256', unsubscribeKey(secret))
		.update(payload)
		.digest()
	let given: Buffer
	try {
		given = Buffer.from(mac, 'base64url')
	} catch {
		return null
	}
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		return null
	}
	try {
		const parsed = targetSchema.safeParse(
			JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
		)
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}
