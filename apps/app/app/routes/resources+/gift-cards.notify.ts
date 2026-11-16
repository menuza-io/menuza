import {
	giftCardNotifyEventSchema,
} from '@repo/common/gift-cards'
import { and, db, eq, Notification, Organization } from '@repo/database'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import {
	GIFT_CARD_ALERT_TYPE,
	giftCardAlertCopy,
	resolveGiftCardAlertRecipients,
} from '#app/utils/gift-cards/alerts.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const HOUR_MS = 60 * 60_000

/**
 * `POST /resources/gift-cards/notify`: where the region tells the people who
 * review gift cards that something needs them (a burst of purchases from one
 * device, a purchase held for review, a card frozen by a dispute, a delivery
 * that keeps failing). The event is an organization id, a kind and a count
 * (strict schema: nothing that could carry a name or a code). Recipients are
 * the members holding `update:gift_card:any`, who get an in-app notification
 * and an email, once per kind and hour: the notification row is the claim, so
 * a retried delivery tells nobody twice. Authenticated with
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
	const parsed = giftCardNotifyEventSchema.safeParse(
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
		return Response.json({ error: 'org_not_found' }, { status: 404, headers: NO_STORE })
	}
	const recipients = await resolveGiftCardAlertRecipients({
		organizationId: organization.id,
	})
	if (recipients.length === 0) {
		return Response.json({ inApp: 0, skipped: 'no_recipients' }, { headers: NO_STORE })
	}
	const copy = giftCardAlertCopy(event.kind, event.count)
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	const needsReview = event.kind === 'needs_review' || event.kind === 'frozen'
	const actionUrl = `${baseUrl}/${organization.slug}/gift-cards${needsReview ? '?needsReview=true' : ''}`
	// One notice per kind and hour: the entity id is the claim.
	const entityId = `${event.kind}:${Math.floor(Date.now() / HOUR_MS)}`

	let inApp = 0
	for (const recipient of recipients) {
		const claimed = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: organization.id,
				type: GIFT_CARD_ALERT_TYPE,
				entityId,
				payload: JSON.stringify({ orgSlug: organization.slug, kind: event.kind }),
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
					eyebrow: 'Gift cards',
					headline: copy.headline,
					detail: copy.detail,
					actionLabel: 'Open gift cards',
					actionUrl,
					settingsNote: '',
				}),
			})
			if (result.status === 'error') console.error('Failed to send gift card alert email')
		} catch {
			console.error('Failed to send gift card alert email')
		}
	}
	return Response.json({ inApp }, { headers: NO_STORE })
}
