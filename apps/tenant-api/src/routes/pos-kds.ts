import { Hono } from 'hono'
import { kdsCommandSchema, kdsConfigRequestSchema } from '@repo/common/kds'
import { authenticatePosDevice, posError } from '../lib/pos-auth.ts'
import { verifyPosStaffSession } from '../lib/pos-staff-session.ts'
import { HttpError, json, readJsonBody } from '../lib/http.ts'
import { touchDevice } from '../services/pos-service.ts'
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
			if (pos.device.signInRequired) {
				const verified = await verifyPosStaffSession(c, pos)
				if ('error' in verified) return verified.error
				staffId = verified.session.staffId
				if (method === 'put' && verified.session.role !== 'manager')
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
				await kitchenCommand(pos.db, actor, body.data)
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
