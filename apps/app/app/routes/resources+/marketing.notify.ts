import {
	marketingNotifyEventSchema,
	marketingNotifyResultSchema,
	type MarketingNotifyResult,
} from '@repo/common/marketing-notify'
import { and, db, eq, Notification, Organization } from '@repo/database'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { resolveCampaignAlertRecipients } from '#app/utils/marketing/campaign-alerts.server.ts'
import {
	CAMPAIGN_ALERT_TYPE,
	campaignAlertEmailCopy,
	campaignAlertPath,
} from '#app/utils/marketing/campaign-alerts.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function answer(result: MarketingNotifyResult) {
	return Response.json(marketingNotifyResultSchema.parse(result), {
		headers: NO_STORE,
	})
}

/**
 * `POST /resources/marketing/notify`: where the regional broadcast tick tells
 * the people who manage broadcasts that a scheduled one could not start in time
 * and was not sent (#232).
 *
 * The event is an organization id, a kind and a campaign id (strict schema: a
 * field that could carry a name, a subject or a count is a 400 and a rejected
 * value is never echoed). Recipients are the members holding
 * `update:campaign:any`. They get an in-app notification and an email, once per
 * broadcast: the notification row is also the claim, so a retried delivery
 * tells nobody twice. Authenticated with `INTERNAL_COMMAND_TOKEN` only.
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

	const parsed = marketingNotifyEventSchema.safeParse(
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

	const recipients = await resolveCampaignAlertRecipients({
		organizationId: organization.id,
	})
	if (recipients.length === 0)
		return answer({ inApp: 0, skipped: 'no_recipients' })

	const copy = campaignAlertEmailCopy(event.kind)
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	const actionUrl = `${baseUrl}/${organization.slug}${campaignAlertPath(event.campaignId)}`

	let inApp = 0
	for (const recipient of recipients) {
		// The row is the claim for this broadcast and member. The email is
		// at-most-once by design: a failed send is logged and not retried, because
		// retrying on a redelivery could tell the same member twice. The in-app
		// notification (the row itself) is the delivery that is always kept.
		const claimed = await db
			.insert(Notification)
			.values({
				userId: recipient.userId,
				organizationId: organization.id,
				type: CAMPAIGN_ALERT_TYPE,
				entityId: event.campaignId,
				payload: JSON.stringify({
					orgSlug: organization.slug,
					campaignId: event.campaignId,
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
					eyebrow: copy.eyebrow,
					headline: copy.headline,
					detail: copy.detail,
					actionLabel: copy.actionLabel,
					actionUrl,
					settingsNote: '',
				}),
			})
			if (result.status === 'error') {
				console.error('Failed to send broadcast alert email')
			}
		} catch {
			console.error('Failed to send broadcast alert email')
		}
	}

	return answer({ inApp })
}
