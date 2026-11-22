import { requireUserId } from '@repo/auth'
import { checkHoneypot } from '@repo/security'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { removeOperatorDevice } from '#app/utils/alerts/push.server.ts'
import {
	loadAlertLog,
	loadAlertSettings,
	saveAlertSetting,
	saveAlertSettingSchema,
} from '#app/utils/alerts/settings.server.ts'
import { userHasOrgAccess } from '#app/utils/organization/organizations.server.ts'

/**
 * `/api/notifications/alerts`: the member's push choices, quiet hours, snooze,
 * thresholds, devices and alert log for one organization (#106, #366), for the
 * Notifications settings page. Session auth; the member must belong to the
 * organization. The same data the phone app reads at `/api/push/preferences`.
 */

const query = z.object({ organizationId: z.string().min(1).max(64) })

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const parsed = query.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success)
		return Response.json({ error: 'invalid_request' }, { status: 400 })
	await userHasOrgAccess(request, parsed.data.organizationId)
	const [settings, log] = await Promise.all([
		loadAlertSettings(userId, parsed.data.organizationId),
		loadAlertLog(userId, parsed.data.organizationId),
	])
	return Response.json({ settings, log })
}

const bodySchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('save'),
		organizationId: z.string().min(1).max(64),
		change: z.string().transform((value, ctx) => {
			try {
				return saveAlertSettingSchema.parse(JSON.parse(value))
			} catch {
				ctx.addIssue({ code: 'custom', message: 'invalid_change' })
				return z.NEVER
			}
		}),
	}),
	z.object({
		action: z.literal('remove_device'),
		organizationId: z.string().min(1).max(64),
		deviceId: z.string().min(1).max(64),
	}),
])

export async function action({ request }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const formData = await request.formData()
	await checkHoneypot(formData)
	const parsed = bodySchema.safeParse(Object.fromEntries(formData))
	if (!parsed.success) {
		return Response.json(
			{ success: false, error: 'Invalid input' },
			{ status: 400 },
		)
	}
	await userHasOrgAccess(request, parsed.data.organizationId)
	if (parsed.data.action === 'remove_device') {
		await removeOperatorDevice(userId, { deviceId: parsed.data.deviceId })
	} else {
		const result = await saveAlertSetting(
			userId,
			parsed.data.organizationId,
			parsed.data.change,
		)
		if (!result.ok) {
			return Response.json(
				{ success: false, error: result.error },
				{ status: result.status },
			)
		}
	}
	const [settings, log] = await Promise.all([
		loadAlertSettings(userId, parsed.data.organizationId),
		loadAlertLog(userId, parsed.data.organizationId),
	])
	return Response.json({ success: true, settings, log })
}
