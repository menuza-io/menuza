import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { lookupNumber } from '../lib/phone-lookup.ts'
import { isValidPhone } from '../lib/phone.ts'
import { rateLimit } from '../lib/rate-limit.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../lib/secrets.ts'
import { smsRouteAvailable } from '../lib/sms-route.ts'

/**
 * `POST /api/phone-lookup`: is this number real, and what kind of line is it
 * (#246). Called by the US App with the internal token on behalf of Admin's
 * Sign-in help (the App has no provider credentials). The number is a staff
 * contact's, never a guest's; it is not logged.
 */
export const phoneLookupRoutes = new Hono()

const NO_STORE = { 'Cache-Control': 'private, no-store' }

phoneLookupRoutes.use(
	'*',
	rateLimit('phone-lookup', { windowMs: 60 * 1000, maxRequests: 30 }),
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

const bodySchema = z.object({ to: z.string().min(8).max(20) }).strict()

phoneLookupRoutes.post('/', async (c) => {
	const denied = unauthorized(c)
	if (denied) return denied
	if (!smsRouteAvailable()) {
		return c.json({ error: 'sms_unavailable_in_region' }, 409, NO_STORE)
	}
	const parsed = bodySchema.safeParse(await c.req.json().catch(() => null))
	if (!parsed.success)
		return c.json({ error: 'invalid_request' }, 400, NO_STORE)
	const { to } = parsed.data
	// A string that is not an E.164 number is simply not valid: no provider call.
	if (!isValidPhone(to)) {
		return c.json(
			{ valid: false, lineType: 'unknown', carrier: null },
			200,
			NO_STORE,
		)
	}
	const result = await lookupNumber(to)
	if (!result) return c.json({ error: 'lookup_failed' }, 502, NO_STORE)
	return c.json(result, 200, NO_STORE)
})
