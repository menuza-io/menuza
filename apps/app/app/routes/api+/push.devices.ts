import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	listOperatorDevices,
	registerOperatorDevice,
	registerOperatorDeviceSchema,
	removeOperatorDevice,
} from '#app/utils/alerts/push.server.ts'
import { isAuthenticationError, requireAuth } from '#app/utils/jwt.server.ts'
import { checkRateLimit } from '#app/utils/rate-limit.server.ts'

/**
 * The operator phone's push registration (#106), with the mobile operator token
 * (a bearer JWT, not a cookie). Nothing here is the guest customer-app push:
 * that lives in the region and carries guest messages.
 *
 * POST   `{ token, platform, locale?, deviceName?, appVersion? }` registers the
 *        phone for the signed-in member (re-registering is safe; the token is
 *        unique, so signing in as someone else on the phone moves it).
 * GET    lists the member's own devices.
 * DELETE `{ deviceId }` or `{ token }` removes one (sign out, or Devices).
 */

function unauthorized() {
	return Response.json(
		{
			success: false,
			error: 'unauthorized',
			message: 'Authentication required',
		},
		{ status: 401 },
	)
}

async function limited(userId: string) {
	const limit = await checkRateLimit(
		{ type: 'user', value: userId },
		{ scope: 'operator-push-devices', maxRequests: 60, windowMs: 60_000 },
	)
	if (limit.allowed) return null
	const retryAfter = Math.max(
		1,
		Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000),
	)
	return Response.json(
		{ success: false, error: 'rate_limited', message: 'Too many requests.' },
		{ status: 429, headers: { 'Retry-After': String(retryAfter) } },
	)
}

const removeSchema = z
	.object({
		deviceId: z.string().min(1).max(64).optional(),
		token: z.string().min(1).max(300).optional(),
	})
	.refine((value) => value.deviceId || value.token)

export async function loader({ request }: LoaderFunctionArgs) {
	let userId: string
	try {
		userId = (await requireAuth(request)).sub
	} catch (error) {
		if (isAuthenticationError(error)) return unauthorized()
		throw error
	}
	const tooMany = await limited(userId)
	if (tooMany) return tooMany
	const devices = await listOperatorDevices(userId)
	return Response.json({
		success: true,
		data: {
			devices: devices.map((device) => ({
				...device,
				createdAt: device.createdAt.getTime(),
				lastSeenAt: device.lastSeenAt.getTime(),
			})),
		},
	})
}

export async function action({ request }: ActionFunctionArgs) {
	let userId: string
	try {
		userId = (await requireAuth(request)).sub
	} catch (error) {
		if (isAuthenticationError(error)) return unauthorized()
		throw error
	}
	const tooMany = await limited(userId)
	if (tooMany) return tooMany
	const body: unknown = await request.json().catch(() => null)

	if (request.method === 'POST') {
		const parsed = registerOperatorDeviceSchema.safeParse(body)
		if (!parsed.success) {
			return Response.json(
				{
					success: false,
					error: 'validation_error',
					message: 'Invalid request',
				},
				{ status: 400 },
			)
		}
		const { id } = await registerOperatorDevice(userId, parsed.data)
		return Response.json({ success: true, data: { deviceId: id } })
	}
	if (request.method === 'DELETE') {
		const parsed = removeSchema.safeParse(body)
		if (!parsed.success) {
			return Response.json(
				{
					success: false,
					error: 'validation_error',
					message: 'Invalid request',
				},
				{ status: 400 },
			)
		}
		const removed = await removeOperatorDevice(userId, parsed.data)
		return Response.json({ success: true, data: { removed } })
	}
	return Response.json(
		{
			success: false,
			error: 'method_not_allowed',
			message: 'Method not allowed',
		},
		{ status: 405 },
	)
}
