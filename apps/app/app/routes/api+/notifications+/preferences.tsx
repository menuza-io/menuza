import { requireUserId } from '@repo/auth'
import { and, db, eq, NotificationPreference } from '@repo/database'
import { checkHoneypot } from '@repo/security'
import { STAFFING_NOTIFICATION_WORKFLOWS } from '@repo/staffing'

import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { userHasOrgAccess } from '#app/utils/organization/organizations.server.ts'
import { RESERVATION_ALERT_WORKFLOWS } from '#app/utils/reservations/manager-alerts.ts'

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const url = new URL(request.url)
	const organizationId = url.searchParams.get('organizationId')

	if (!organizationId) {
		return Response.json({ preferences: [] }, { status: 400 })
	}

	const preferences = await db
		.select()
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.userId, userId),
				eq(NotificationPreference.organizationId, organizationId),
			),
		)

	return Response.json({ preferences })
}

const preferenceSchema = z.object({
	organizationId: z.string().min(1),
	workflow: z.enum([
		'comment-mention-workflow',
		'note-comment-workflow',
		...STAFFING_NOTIFICATION_WORKFLOWS,
		...RESERVATION_ALERT_WORKFLOWS,
	]),
	channel: z.enum(['email', 'inApp']),
	enabled: z.string().transform((val) => val === 'true'),
})

export async function action({ request }: ActionFunctionArgs) {
	const userId = await requireUserId(request)

	const formData = await request.formData()
	await checkHoneypot(formData)

	const result = preferenceSchema.safeParse(Object.fromEntries(formData))

	if (!result.success) {
		return Response.json(
			{ success: false, error: 'Invalid input' },
			{ status: 400 },
		)
	}

	const { organizationId, workflow, channel, enabled } = result.data

	// Verify org membership
	await userHasOrgAccess(request, organizationId)

	// upsert
	await db
		.insert(NotificationPreference)
		.values({
			userId,
			organizationId,
			workflow,
			[channel]: enabled,
		})
		.onConflictDoUpdate({
			target: [
				NotificationPreference.userId,
				NotificationPreference.organizationId,
				NotificationPreference.workflow,
			],
			set: { [channel]: enabled },
		})

	// Return updated preferences so the fetcher data stays populated
	const preferences = await db
		.select()
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.userId, userId),
				eq(NotificationPreference.organizationId, organizationId),
			),
		)

	return Response.json({ success: true, preferences })
}
