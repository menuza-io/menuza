import {
	and,
	db,
	eq,
	Notification,
	Organization,
	StaffingAlertEmail as StaffingAlertEmailSent,
} from '@repo/database'
import { StaffingAlertEmail, sendEmail } from '@repo/email'
import {
	MANAGER_ALERT_NOTIFICATION_TYPE,
	managerAlertEventSchema,
	managerAlertPath,
	type ManagerAlertResult,
} from '@repo/staffing'
import { type ActionFunctionArgs } from 'react-router'
import { ENV } from 'varlock/env'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getStaffingFeatureState } from '#app/utils/staffing/access.server.ts'
import { isStaffingEmailEnabled } from '#app/utils/staffing/email-switch.server.ts'
import { describeManagerAlert } from '#app/utils/staffing/manager-alert-copy.ts'
import {
	loadChannelPreferences,
	loadDeliveredTypes,
	resolveAlertRecipients,
} from '#app/utils/staffing/manager-alerts.server.ts'
import { loadOrganizationScope } from '#app/utils/staffing/scope.server.ts'

/** Recipients handled at once: bounds the time spent on a long list. */
const DELIVERY_CONCURRENCY = 8

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function answer(result: ManagerAlertResult, status = 200) {
	return Response.json(result, { status, headers: NO_STORE })
}

function skipped(reason: string) {
	return answer({ inApp: 0, emailed: 0, skipped: reason })
}

/**
 * `POST /resources/staffing/notify`: where the regional tick tells managers
 * something needs attention at a scope (someone has not clocked in, a
 * forgotten clock-out, overtime close).
 *
 * The request is the generic event from ADR 047, decision 4: an organization, a
 * kind, a scope id, a count and an event id. Nothing about a person crosses
 * (the schema is strict, so an extra field is a 400). This route resolves who
 * should hear about it from permissions and scope scope, applies each
 * member's notification preferences (defaults: in-app and email on), writes an
 * in-app notification carrying only the kind, the scope id and the count, and
 * sends the email. Details are read in the app, browser to the regional node,
 * after the manager opens the item.
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only. Idempotent per event id and
 * member: a retried delivery repeats neither the notification nor the email. A
 * flag that is off, an unknown scope, or nobody to tell answers 200 with a
 * `skipped` reason, so the node stops retrying something that cannot succeed.
 * Counts only in the response.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: the 401 from internal auth is the answer.
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const raw = await request.json().catch(() => null)
	const parsed = managerAlertEventSchema.safeParse(raw)
	if (!parsed.success) {
		// Codes and paths only: a rejected value is never echoed back.
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

	// The same flags that gate every staffing screen gate the alerts: a module
	// that is off tells nobody anything.
	const features = await getStaffingFeatureState(organization.id)
	const featureOn =
		event.kind === 'schedule_published'
			? features.scheduling
			: event.kind === 'new_applicant' ||
				  event.kind === 'onboarding_due' ||
				  event.kind === 'certificate_expiring'
				? features.hiring
				: features.timeclock
	if (!features.enabled || !featureOn) return skipped('feature_off')

	// An alert may name the organization's one scope. The name stays out of the
	// copy: with a single scope "at <name>" would only repeat the organization.
	if (event.scopeId) {
		const scope = await loadOrganizationScope(organization.id)
		if (event.scopeId !== scope.id) return skipped('unknown_scope')
	}

	// Whoever raised it (for a published schedule, the person who published) is
	// not told about their own action.
	const recipients = (
		await resolveAlertRecipients({
			organizationId: organization.id,
			kind: event.kind,
			scopeId: event.scopeId,
		})
	).filter((recipient) => recipient.userId !== event.actorUserId)
	if (recipients.length === 0) return skipped('no_recipients')

	const type = MANAGER_ALERT_NOTIFICATION_TYPE[event.kind]
	const userIds = recipients.map((r) => r.userId)
	const [preferences, alreadyDelivered] = await Promise.all([
		loadChannelPreferences({
			organizationId: organization.id,
			kind: event.kind,
			userIds,
		}),
		loadDeliveredTypes({
			organizationId: organization.id,
			types: [type],
			eventId: event.eventId,
			userIds,
		}),
	])

	const copy = describeManagerAlert({
		kind: event.kind,
		count: event.count,
		scopeName: null,
	})
	const baseUrl = String(ENV.BASE_URL ?? '').replace(/\/$/, '')
	const actionUrl = `${baseUrl}/${organization.slug}${managerAlertPath(event.kind, event.scopeId)}`
	const emailAllowed = isStaffingEmailEnabled()

	let inApp = 0
	let emailed = 0
	const deliver = async (recipient: (typeof recipients)[number]) => {
		const delivered = alreadyDelivered.get(recipient.userId)
		const channels = preferences.get(recipient.userId) ?? {
			inApp: true,
			email: true,
		}

		if (channels.inApp && !delivered?.has(type)) {
			// Ids and counts only. The scope name and the people are looked up in
			// the app when the manager opens it.
			const inserted = await db
				.insert(Notification)
				.values({
					userId: recipient.userId,
					organizationId: organization.id,
					type,
					entityId: event.eventId,
					payload: JSON.stringify({
						kind: event.kind,
						scopeId: event.scopeId,
						count: event.count,
						orgSlug: organization.slug,
					}),
				})
				.onConflictDoNothing()
				.returning({ id: Notification.id })
			if (inserted.length > 0) inApp++
		}

		if (channels.email && emailAllowed) {
			// Claimed before the send, whatever the member's in-app choice: a
			// redelivered or concurrent event finds the row and sends nothing.
			const claim = await db
				.insert(StaffingAlertEmailSent)
				.values({
					organizationId: organization.id,
					eventId: event.eventId,
					userId: recipient.userId,
				})
				.onConflictDoNothing()
				.returning({ id: StaffingAlertEmailSent.id })
			if (claim.length === 0) return
			const release = () =>
				db
					.delete(StaffingAlertEmailSent)
					.where(eq(StaffingAlertEmailSent.id, claim[0]!.id))
					.catch(() => {})
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
						settingsNote:
							'You can change these alerts in your notification settings.',
					}),
				})
				if (result.status === 'error') {
					// Not sent: a retried delivery may try again.
					await release()
					console.error('Failed to send staffing alert email')
				} else {
					emailed++
				}
			} catch {
				await release()
				console.error('Failed to send staffing alert email')
			}
		}
	}
	for (let i = 0; i < recipients.length; i += DELIVERY_CONCURRENCY) {
		await Promise.all(
			recipients.slice(i, i + DELIVERY_CONCURRENCY).map(deliver),
		)
	}

	return answer({ inApp, emailed })
}
