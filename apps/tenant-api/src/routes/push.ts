import { pushPreferencesSchema, registerDeviceSchema } from '@repo/common/push'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { HttpError, NO_STORE } from '../lib/http.ts'
import {
	getPushPreferences,
	markPushOpened,
	pushGate,
	registerPushDevice,
	removePushDevice,
	setPushPreferences,
} from '../services/push-service.ts'
import { authenticateCustomer } from './auth.ts'

/**
 * Guest push (#105), browser (the customer app) to region with the customer
 * token; the organization is the token's. A device belongs to the guest who
 * registered it. Errors: `push_not_enabled` (flag, kill switch, KSA, or the
 * app's credentials not set), `push_token_invalid`, `push_device_limit`.
 *
 *   POST   /push/devices          { token, platform, locale, appId? }
 *   DELETE /push/devices/:id      sign-out deletes the device
 *   GET    /push/preferences      { orders, bookings, rewards, marketing, hasDevice }
 *   PUT    /push/preferences      switches, and the marketing opt-in (source profile | app_prompt)
 *   POST   /push/opened           { messageId } the app reports a tap
 */
export const pushRoutes = new Hono()

type Auth = Awaited<ReturnType<typeof authenticateCustomer>>

async function authenticated(c: Context): Promise<Auth | Response> {
	try {
		return await authenticateCustomer(c)
	} catch (response) {
		if (response instanceof Response) return response
		throw response
	}
}

function failure(error: unknown): Response {
	if (error instanceof HttpError) return error.toResponse()
	throw error
}

async function body(c: Context): Promise<unknown> {
	return c.req.json().catch(() => null)
}

pushRoutes.post('/devices', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const parsed = registerDeviceSchema.safeParse(await body(c))
	if (!parsed.success) {
		// Never echo what was sent.
		return c.json({ error: 'push_token_invalid' }, 400, NO_STORE)
	}
	try {
		const result = await registerPushDevice(
			auth.db,
			auth.orgId,
			auth.customerId,
			parsed.data,
		)
		return c.json(result, 201, NO_STORE)
	} catch (error) {
		return failure(error)
	}
})

pushRoutes.delete('/devices/:id', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const id = z.string().min(1).max(64).safeParse(c.req.param('id'))
	if (!id.success) return c.json({ error: 'not_found' }, 404, NO_STORE)
	const removed = await removePushDevice(auth.db, auth.customerId, id.data)
	return removed
		? c.body(null, 204)
		: c.json({ error: 'not_found' }, 404, NO_STORE)
})

pushRoutes.get('/preferences', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const gate = await pushGate(auth.orgId)
	if (!gate.ok) return c.json({ error: gate.code }, 409, NO_STORE)
	const marketing = await pushGate(auth.orgId, { marketing: true })
	return c.json(
		{
			...(await getPushPreferences(auth.db, auth.customerId)),
			/** Whether Offers and news can be offered at all (`marketing.push`). */
			marketingAvailable: marketing.ok,
		},
		200,
		NO_STORE,
	)
})

pushRoutes.put('/preferences', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const parsed = pushPreferencesSchema.safeParse(await body(c))
	if (!parsed.success)
		return c.json({ error: 'invalid_request' }, 400, NO_STORE)
	try {
		return c.json(
			await setPushPreferences(
				auth.db,
				auth.orgId,
				auth.customerId,
				parsed.data,
			),
			200,
			NO_STORE,
		)
	} catch (error) {
		return failure(error)
	}
})

pushRoutes.post('/opened', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const parsed = z
		.strictObject({ messageId: z.string().min(1).max(64) })
		.safeParse(await body(c))
	if (!parsed.success)
		return c.json({ error: 'invalid_request' }, 400, NO_STORE)
	const ok = await markPushOpened(
		auth.db,
		auth.customerId,
		parsed.data.messageId,
	)
	return ok ? c.body(null, 204) : c.json({ error: 'not_found' }, 404, NO_STORE)
})
