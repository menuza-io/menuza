import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { isEmailSwitchOn } from '@repo/staffing'
import { SMS_OPT_OUT_PHRASE } from '@repo/common/sms-compliance'
import { isUsOrCanadaNumber } from '@repo/phone-agent'
import { sendSms } from '@repo/sms'
import { ENV } from 'varlock/env'
import { rateLimit } from '../lib/rate-limit.ts'
import { smsRouteAvailable } from '../lib/sms-route.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	syncEnvFromProcess,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { isValidPhone } from '../lib/phone.ts'

/**
 * `POST /api/alert-texts`: the one texting route for the people a location
 * chose for order alerts (#241), called by the US App with the internal token
 * (the App has no SMS credentials, exactly like the phone-line verification).
 * Only this node can text: the KSA node has no in-kingdom provider yet (#78) and
 * answers 409, `@repo/sms` refuses there too.
 *
 * The text is composed by the App from an order number, a total and a time; it
 * must end with the opt-out phrase carriers expect, is capped at two segments,
 * and goes to a US or Canadian mobile number only (premium and Caribbean "+1"
 * numbers are a toll-fraud target). A reply of STOP is matched by the inbound
 * webhook, which forwards only a hash of the sender to the App. The body is never
 * logged.
 */
export const alertTextRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

alertTextRoutes.use(
	'*',
	rateLimit('alert-texts', { windowMs: 60 * 1000, maxRequests: 120 }),
)

function unauthorized(c: Context) {
	const internalToken = getInternalCommandToken()
	if (internalToken.length < 16) {
		return c.json({ error: 'service_unavailable' }, 503, NO_STORE)
	}
	const presented = getBearerToken(c.req.header('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return c.json({ error: 'unauthorized' }, 401, NO_STORE)
	}
	return null
}

/** `ORDER_ALERT_SMS_ENABLED=false` (also 0, off, no, disabled) drops these texts on this node. */
export function isAlertTextsEnabled(): boolean {
	syncEnvFromProcess()
	const live =
		typeof process !== 'undefined' && process.env
			? process.env.ORDER_ALERT_SMS_ENABLED
			: (ENV as Record<string, unknown>).ORDER_ALERT_SMS_ENABLED
	return isEmailSwitchOn(live)
}

const bodySchema = z
	.object({
		orgId: z.string().min(1).max(64),
		to: z.string().min(8).max(20),
		text: z.string().min(1).max(320),
	})
	.strict()

alertTextRoutes.post('/', async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied
	if (!smsRouteAvailable()) {
		return c.json({ error: 'sms_unavailable_in_region' }, 409, NO_STORE)
	}
	if (!isAlertTextsEnabled()) {
		return c.json({ error: 'alert_texts_disabled' }, 503, NO_STORE)
	}
	const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success)
		return c.json({ error: 'invalid_request' }, 400, NO_STORE)
	const { to, text } = parsed.data
	if (!isValidPhone(to) || !isUsOrCanadaNumber(to)) {
		return c.json({ error: 'not_allowed_number' }, 400, NO_STORE)
	}
	if (!text.trimEnd().endsWith(SMS_OPT_OUT_PHRASE)) {
		return c.json({ error: 'missing_opt_out' }, 400, NO_STORE)
	}
	try {
		await sendSms({ to, message: text })
	} catch {
		// The provider's message can quote the number or the text: neither is logged.
		console.error('Failed to send an order alert text')
		return c.json({ error: 'send_failed' }, 502, NO_STORE)
	}
	return c.json({ sent: true }, 200, NO_STORE)
})
