import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	loadAlertSettings,
	saveAlertSetting,
	saveAlertSettingSchema,
} from '#app/utils/alerts/settings.server.ts'
import { isAuthenticationError, requireAuth } from '#app/utils/jwt.server.ts'
import { checkUserOrganizationAccess } from '#app/utils/organization/organizations.server.ts'
import { checkRateLimit } from '#app/utils/rate-limit.server.ts'

/**
 * Notification settings for the operator phone app (#106, #366): which alerts
 * arrive as a push, quiet hours, snooze and thresholds, per organization, with
 * the operator token. Same data and rules as Settings, Notifications on the
 * web (`utils/alerts/settings.server.ts`); the member must belong to the
 * organization.
 *
 * GET `?organizationId=` the member's settings.
 * PUT `{ organizationId, change }` one change (`saveAlertSettingSchema`).
 */

const ID = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)

function failure(status: number, error: string, message: string) {
	return Response.json({ success: false, error, message }, { status })
}

async function authenticate(request: Request): Promise<string | Response> {
	try {
		const userId = (await requireAuth(request)).sub
		const limit = await checkRateLimit(
			{ type: 'user', value: userId },
			{
				scope: 'operator-push-preferences',
				maxRequests: 120,
				windowMs: 60_000,
			},
		)
		if (!limit.allowed)
			return failure(429, 'rate_limited', 'Too many requests.')
		return userId
	} catch (error) {
		if (isAuthenticationError(error)) {
			return failure(401, 'unauthorized', 'Authentication required')
		}
		throw error
	}
}

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await authenticate(request)
	if (typeof userId !== 'string') return userId
	const parsed = z
		.object({ organizationId: ID })
		.safeParse(Object.fromEntries(new URL(request.url).searchParams))
	if (!parsed.success)
		return failure(400, 'validation_error', 'Invalid request')
	// Not a member and no such organization look the same.
	if (
		!(await checkUserOrganizationAccess(userId, parsed.data.organizationId))
	) {
		return failure(404, 'not_found', 'Not found')
	}
	return Response.json({
		success: true,
		data: {
			settings: await loadAlertSettings(userId, parsed.data.organizationId),
		},
	})
}

export async function action({ request }: ActionFunctionArgs) {
	const userId = await authenticate(request)
	if (typeof userId !== 'string') return userId
	if (request.method !== 'PUT') {
		return failure(405, 'method_not_allowed', 'Method not allowed')
	}
	const parsed = z
		.object({ organizationId: ID, change: saveAlertSettingSchema })
		.safeParse(await request.json().catch(() => null))
	if (!parsed.success)
		return failure(400, 'validation_error', 'Invalid request')
	if (
		!(await checkUserOrganizationAccess(userId, parsed.data.organizationId))
	) {
		return failure(404, 'not_found', 'Not found')
	}
	const result = await saveAlertSetting(
		userId,
		parsed.data.organizationId,
		parsed.data.change,
	)
	if (!result.ok) return failure(result.status, result.error, 'Not saved')
	return Response.json({
		success: true,
		data: {
			settings: await loadAlertSettings(userId, parsed.data.organizationId),
		},
	})
}
