import {
	and,
	db,
	eq,
	Feedback,
	FeedbackMessage,
	Notification,
	Organization,
	User,
	UserOrganization,
} from '@repo/database'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	SUPPORT_REPLY_EMAIL,
	SUPPORT_REPLY_NOTIFICATION_TYPE,
	supportRequestPath,
} from '#app/utils/support-alerts.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Ids only: the reply's words never travel in this call or in what it sends. */
const eventSchema = z
	.object({
		feedbackId: z.string().min(1).max(64),
		messageId: z.string().min(1).max(64),
	})
	.strict()

/**
 * `POST /resources/support/notify`: Admin tells the App that support replied
 * to a request (#406). The sender gets an in-app notification and an email
 * through the same pattern as the other alerts (`Notification` row, then
 * `StaffingAlertEmail`): a row per reply that is also the claim, so a retried
 * call tells nobody twice. Neither carries the reply text. Authenticated with
 * `INTERNAL_COMMAND_TOKEN` only.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}
	const parsed = eventSchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const { feedbackId, messageId } = parsed.data

	const [row] = await db
		.select({
			userId: Feedback.userId,
			organizationId: Feedback.organizationId,
			orgSlug: Organization.slug,
			email: User.email,
			active: UserOrganization.active,
		})
		.from(FeedbackMessage)
		.innerJoin(Feedback, eq(Feedback.id, FeedbackMessage.feedbackId))
		.innerJoin(Organization, eq(Organization.id, Feedback.organizationId))
		.innerJoin(User, eq(User.id, Feedback.userId))
		.leftJoin(
			UserOrganization,
			and(
				eq(UserOrganization.userId, Feedback.userId),
				eq(UserOrganization.organizationId, Feedback.organizationId),
			),
		)
		.where(
			and(
				eq(FeedbackMessage.id, messageId),
				eq(FeedbackMessage.feedbackId, feedbackId),
				eq(FeedbackMessage.side, 'support'),
			),
		)
		.limit(1)
	if (!row) {
		return Response.json(
			{ error: 'not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	// A sender who has left the restaurant is not told.
	if (!row.active)
		return Response.json({ inApp: 0, email: false }, { headers: NO_STORE })

	const claimed = await db
		.insert(Notification)
		.values({
			userId: row.userId,
			organizationId: row.organizationId,
			type: SUPPORT_REPLY_NOTIFICATION_TYPE,
			entityId: messageId,
			payload: JSON.stringify({ orgSlug: row.orgSlug, requestId: feedbackId }),
		})
		.onConflictDoNothing()
		.returning({ id: Notification.id })
	if (claimed.length === 0) {
		return Response.json({ inApp: 0, email: false }, { headers: NO_STORE })
	}

	let emailed = false
	try {
		const base = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
		const result = await sendEmail({
			to: row.email,
			subject: SUPPORT_REPLY_EMAIL.subject,
			react: StaffingAlertEmail({
				eyebrow: SUPPORT_REPLY_EMAIL.eyebrow,
				headline: SUPPORT_REPLY_EMAIL.headline,
				detail: SUPPORT_REPLY_EMAIL.detail,
				actionLabel: SUPPORT_REPLY_EMAIL.actionLabel,
				actionUrl: `${base}/${row.orgSlug}${supportRequestPath(feedbackId)}`,
				settingsNote: '',
			}),
		})
		emailed = result.status !== 'error'
	} catch {
		console.error('Failed to send the support reply email')
	}
	return Response.json({ inApp: 1, email: emailed }, { headers: NO_STORE })
}
