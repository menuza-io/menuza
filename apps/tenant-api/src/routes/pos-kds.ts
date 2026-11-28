import { Hono } from 'hono'
import { z } from 'zod'
import { kdsCommandSchema, kdsConfigRequestSchema } from '@repo/common/kds'
import { testPrintAnswerSchema } from '@repo/common/test-orders'
import { authenticatePosDevice, posError } from '../lib/pos-auth.ts'
import { verifyPosStaffSession } from '../lib/pos-staff-session.ts'
import { HttpError, json, readJsonBody } from '../lib/http.ts'
import { runInBackground } from '../lib/background.ts'
import { sendReadyTextIfDue } from '../services/pos-ready-text-service.ts'
import { touchDevice } from '../services/pos-service.ts'
import { recordTestPrintAnswer } from '../services/test-orders-service.ts'
import {
	configureKitchen,
	kitchenCommand,
	kitchenFeed,
} from '../services/kds-service.ts'

/** A kitchen is a paired terminal at ONE server-bound location. It never
 * receives customer contacts, delivery addresses, payment or fiscal records.
 */
export const posKdsRoutes = new Hono()

posKdsRoutes.onError((error) => {
	if (error instanceof HttpError) return error.toResponse()
	// Do not log source lines or rejected values: what failed, not with what.
	console.error(
		'Kitchen display failed',
		error instanceof Error ? error.name : 'unknown',
	)
	return posError(500, 'kitchen_unavailable')
})

/**
 * "Did the ticket print?" for a free test order (#119), answered on the
 * kitchen screen. Bound to this screen's location like every kitchen call.
 */
posKdsRoutes.post('/test-print', async (c) => {
	const auth = await authenticatePosDevice(c)
	if ('error' in auth) return auth.error
	const { pos } = auth
	const locationId = pos.device.locationId
	if (!locationId) return posError(403, 'kitchen_needs_location')
	if (pos.device.signInRequired) {
		const verified = await verifyPosStaffSession(c, pos)
		if ('error' in verified) return verified.error
	}
	const body = await readJsonBody(
		c,
		testPrintAnswerSchema.extend({ orderId: z.string().min(1).max(100) }),
	)
	if ('error' in body) return body.error
	const recorded = await recordTestPrintAnswer(
		pos.orgId,
		pos.db,
		body.data.orderId,
		body.data.answer,
		{ locationIds: [locationId] },
	)
	if (!recorded.ok) return posError(recorded.status, recorded.code)
	return json(await kitchenFeed(pos.db, pos.orgId, locationId))
})

for (const method of ['get', 'post', 'put'] as const) {
	posKdsRoutes[method](
		method === 'get' ? '/' : method === 'put' ? '/settings' : '/command',
		async (c) => {
			const auth = await authenticatePosDevice(c)
			if ('error' in auth) return auth.error
			const { pos } = auth
			const locationId = pos.device.locationId
			if (!locationId) return posError(403, 'kitchen_needs_location')
			// A kitchen screen on the pass shows as in use on the Terminals page.
			await touchDevice(pos.db, pos.device).catch(() => {})
			let staffId: string | null = null
			let manager = true
			if (pos.device.signInRequired) {
				const verified = await verifyPosStaffSession(c, pos)
				if ('error' in verified) return verified.error
				staffId = verified.session.staffId
				manager = verified.session.role === 'manager'
				if (method === 'put' && !manager)
					return posError(403, 'manager_required')
			}
			const actor = {
				orgId: pos.orgId,
				locationId,
				deviceId: pos.device.id,
				staffId,
			}
			if (method === 'post') {
				const body = await readJsonBody(c, kdsCommandSchema)
				if ('error' in body) return body.error
				// Pushing a guest's promised time back is a manager's call when
				// staff sign in on this terminal (like kitchen settings).
				if (body.data.action === 'delay' && !manager)
					return posError(403, 'manager_required')
				const result = await kitchenCommand(pos.db, actor, body.data)
				// The till order's one ready text, after the stage is recorded. It
				// never holds up or fails the kitchen's answer.
				if (result.tillBecameReady)
					runInBackground(
						sendReadyTextIfDue(pos.db, {
							orgId: pos.orgId,
							orderId: body.data.orderId,
						}),
					)
			} else if (method === 'put') {
				const body = await readJsonBody(c, kdsConfigRequestSchema)
				if ('error' in body) return body.error
				await configureKitchen(
					pos.db,
					actor,
					body.data.expectedVersion,
					body.data.config,
				)
			}
			return json(await kitchenFeed(pos.db, pos.orgId, locationId))
		},
	)
}
