import { cateringNotifyEventSchema } from '@repo/common/catering'
import { and, db, eq, Notification, Organization } from '@repo/database'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import {
	CATERING_ALERT_TYPE,
	cateringAlertCopy,
	resolveCateringAlertRecipients,
} from '#app/utils/catering/alerts.server.ts'
import { isCateringEnabled } from '#app/utils/catering/catering-context.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /resources/catering/notify` (#124, #361): where the region tells the
 * members a location chose that something needs them: a new quote request, a
 * catering order or paid quote or balance, an event tomorrow, a balance that
 * is overdue. The event is an organization id, a kind, a location id, the
 * request or order id and a count (strict schema: nothing that could carry a
 * name, phone, address, note or dish reaches the App). Recipients are the
 * members listed in the location's catering settings; each gets an in-app
 * notification and an email, once per event: the notification row is the
 * claim, so a retried delivery tells nobody twice. Authenticated with
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
	const parsed = cateringNotifyEventSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) {
		return Response.json(
			{
				error: 'invalid_request',
				issues: parsed.error.issues.slice(0, 10).map((issue) => ({
					path: issue.path.join('.'),
					code: issue.code,
				})),
			},
			{ status: 400, headers: NO_STORE },
		)
	}
	const event = parsed.data
	const organization = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, event.orgId),
			eq(Organization.active, true),
			eq(Organization.hasProvisionedDb, true),
		),
		columns: { id: true, slug: true },
	})
	if (!organization) {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	if (!(await isCateringEnabled(organization.id))) {
		return Response.json(
			{ inApp: 0, skipped: 'flag_off' },
			{ headers: NO_STORE },
		)
	}
	const recipients = await resolveCateringAlertRecipients({
		organizationId: organization.id,
		locationId: event.locationId,
	})
	if (recipients.length === 0) {
		return Response.json(
			{ inApp: 0, skipped: 'no_recipients' },
			{ headers: NO_STORE },
		)
	}
	const copy = cateringAlertCopy(event.kind, event.count)
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	const actionUrl = `${baseUrl}/${organization.slug}/orders/catering`
	// One notice per event: the request or order id and the kind are the claim.
	const entityId = `${event.kind}:${event.refId}`

	let inApp = 0
	for (const recipient of recipients) {
		const claimed = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: organization.id,
				type: CATERING_ALERT_TYPE,
				entityId,
				payload: JSON.stringify({
					orgSlug: organization.slug,
					kind: event.kind,
					locationId: event.locationId,
				}),
			})
			.onConflictDoNothing()
			.returning({ id: Notification.id })
		if (claimed.length === 0) continue
		inApp++
		try {
			const result = await sendEmail({
				to: recipient.email,
				subject: copy.subject,
				react: StaffingAlertEmail({
					eyebrow: 'Catering',
					headline: copy.headline,
					detail: copy.detail,
					actionLabel: 'Open catering',
					actionUrl,
					settingsNote: '',
				}),
			})
			if (result.status === 'error') {
				console.error('Failed to send catering alert email')
			}
		} catch {
			console.error('Failed to send catering alert email')
		}
	}
	return Response.json({ inApp }, { headers: NO_STORE })
}
