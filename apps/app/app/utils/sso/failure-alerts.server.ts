import {
	and,
	db,
	eq,
	inArray,
	lt,
	lte,
	Notification,
	NotificationPreference,
	Organization,
	SsoFailureEvent,
	SsoFailureNotice,
	gte,
	count,
} from '@repo/database'
import { sendEmail, StaffingAlertEmail } from '@repo/email'
import { ENV } from 'varlock/env'
import { resolveDomainAlertRecipients } from '#app/utils/domains/recipients.server.ts'
import {
	SSO_EMAIL,
	SSO_FAILURE_NOTIFICATION_TYPE,
	SSO_FAILURE_RETENTION_MS,
	SSO_FAILURE_THRESHOLD,
	SSO_FAILURE_WINDOW_MS,
	SSO_FAILURE_WORKFLOW,
	SSO_NOTICE_INTERVAL_MS,
	isSsoReasonKind,
	ssoAlertPath,
	ssoFailureEmail,
	type SsoReasonKind,
} from './sso-alerts.ts'

/**
 * Telling organization admins that single sign-on is failing (#347).
 *
 * Every counted failure is one row (organization, error kind, time). Five in ten
 * minutes make an outage; the first notice goes to the admins as an in-app
 * notice and an email, then no further notice for that organization for an
 * hour. The claim is one compare-and-set write, so failures arriving together
 * cannot both send. An admin who muted the notice gets nothing on that channel.
 * Nothing about a person, a token or an assertion is ever stored or sent: the
 * text comes from the error kind alone.
 */

export type SsoFailureDeps = {
	now: () => Date
	sendEmail: typeof sendEmail
}
const defaultDeps: SsoFailureDeps = { now: () => new Date(), sendEmail }

export type SsoFailureResult =
	| { status: 'unknown_organization' }
	| { status: 'recorded'; failures: number }
	| { status: 'throttled'; failures: number }
	| {
			status: 'notified'
			failures: number
			inApp: number
			emailed: number
	  }

function appUrl(slug: string) {
	return `${String(ENV.BASE_URL ?? '').replace(/\/$/, '')}/${slug}${ssoAlertPath()}`
}

async function channelPreferences(organizationId: string, userIds: string[]) {
	const map = new Map<string, { inApp: boolean; email: boolean }>()
	if (userIds.length === 0) return map
	const rows = await db
		.select({
			userId: NotificationPreference.userId,
			inApp: NotificationPreference.inApp,
			email: NotificationPreference.email,
		})
		.from(NotificationPreference)
		.where(
			and(
				eq(NotificationPreference.organizationId, organizationId),
				eq(NotificationPreference.workflow, SSO_FAILURE_WORKFLOW),
				inArray(NotificationPreference.userId, userIds),
			),
		)
	for (const row of rows) map.set(row.userId, row)
	return map
}

/**
 * Claims the right to notify: true for the one caller that moves
 * `lastNotifiedAt` forward (or creates the row). Returns the previous value so
 * a total delivery failure can give the claim back.
 */
async function claimNotice(
	organizationId: string,
	reasonKind: SsoReasonKind,
	now: Date,
): Promise<{ claimed: false } | { claimed: true; previous: Date | null }> {
	const inserted = await db
		.insert(SsoFailureNotice)
		.values({ organizationId, lastNotifiedAt: now, lastErrorType: reasonKind })
		.onConflictDoNothing()
		.returning({ id: SsoFailureNotice.organizationId })
	if (inserted.length > 0) return { claimed: true, previous: null }
	const [existing] = await db
		.select({ lastNotifiedAt: SsoFailureNotice.lastNotifiedAt })
		.from(SsoFailureNotice)
		.where(eq(SsoFailureNotice.organizationId, organizationId))
		.limit(1)
	const cutoff = new Date(now.getTime() - SSO_NOTICE_INTERVAL_MS)
	const moved = await db
		.update(SsoFailureNotice)
		.set({ lastNotifiedAt: now, lastErrorType: reasonKind })
		.where(
			and(
				eq(SsoFailureNotice.organizationId, organizationId),
				lte(SsoFailureNotice.lastNotifiedAt, cutoff),
			),
		)
		.returning({ id: SsoFailureNotice.organizationId })
	return moved.length > 0
		? { claimed: true, previous: existing?.lastNotifiedAt ?? null }
		: { claimed: false }
}

/**
 * Records one failed sign-in for an organization and, when it makes five in ten
 * minutes and no notice went out in the last hour, notifies the admins. Safe to
 * call from the error path: it never throws.
 */
export async function recordSsoFailure(
	input: { organizationSlug: string; errorType: string },
	deps: SsoFailureDeps = defaultDeps,
): Promise<SsoFailureResult> {
	try {
		const now = deps.now()
		const [organization] = await db
			.select({
				id: Organization.id,
				slug: Organization.slug,
				name: Organization.name,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.slug, input.organizationSlug),
					eq(Organization.active, true),
				),
			)
			.limit(1)
		if (!organization) return { status: 'unknown_organization' }
		const reasonKind: SsoReasonKind = isSsoReasonKind(input.errorType)
			? input.errorType
			: 'unknown_error'

		await db.insert(SsoFailureEvent).values({
			organizationId: organization.id,
			errorType: reasonKind,
			createdAt: now,
		})
		await db
			.delete(SsoFailureEvent)
			.where(
				and(
					eq(SsoFailureEvent.organizationId, organization.id),
					lt(
						SsoFailureEvent.createdAt,
						new Date(now.getTime() - SSO_FAILURE_RETENTION_MS),
					),
				),
			)
		const [row] = await db
			.select({ value: count() })
			.from(SsoFailureEvent)
			.where(
				and(
					eq(SsoFailureEvent.organizationId, organization.id),
					gte(
						SsoFailureEvent.createdAt,
						new Date(now.getTime() - SSO_FAILURE_WINDOW_MS),
					),
				),
			)
		const failures = row?.value ?? 0
		if (failures < SSO_FAILURE_THRESHOLD)
			return { status: 'recorded', failures }

		const claim = await claimNotice(organization.id, reasonKind, now)
		if (!claim.claimed) return { status: 'throttled', failures }

		const recipients = await resolveDomainAlertRecipients(organization.id, now)
		const preferences = await channelPreferences(
			organization.id,
			recipients.map((recipient) => recipient.userId),
		)
		const hourBucket = Math.floor(now.getTime() / SSO_NOTICE_INTERVAL_MS)
		const copy = ssoFailureEmail({
			organizationName: organization.name,
			reasonKind,
			failures,
		})
		let inApp = 0
		let emailed = 0
		let attempted = 0
		for (const recipient of recipients) {
			const channels = preferences.get(recipient.userId) ?? {
				inApp: true,
				email: true,
			}
			if (channels.inApp) {
				const created = await db
					.insert(Notification)
					.values({
						userId: recipient.userId,
						organizationId: organization.id,
						type: SSO_FAILURE_NOTIFICATION_TYPE,
						entityId: `sso:${organization.id}:${hourBucket}`,
						payload: JSON.stringify({
							orgSlug: organization.slug,
							reasonKind,
							failures,
						}),
					})
					.onConflictDoNothing()
					.returning({ id: Notification.id })
				if (created.length > 0) inApp++
			}
			if (channels.email) {
				attempted++
				try {
					const result = await deps.sendEmail({
						to: recipient.email,
						subject: copy.subject,
						react: StaffingAlertEmail({
							eyebrow: SSO_EMAIL.eyebrow,
							headline: copy.headline,
							detail: copy.detail,
							actionLabel: SSO_EMAIL.actionLabel,
							actionUrl: appUrl(organization.slug),
							settingsNote: SSO_EMAIL.settingsNote,
						}),
					})
					if (result.status !== 'error') emailed++
				} catch {
					// A failed send is retried by the next outage window.
				}
			}
		}
		// Every email failed and nothing reached the bell: give the claim back, so
		// the next failure tries again instead of waiting an hour in silence.
		if (attempted > 0 && emailed === 0 && inApp === 0) {
			if (claim.previous === null) {
				await db
					.delete(SsoFailureNotice)
					.where(eq(SsoFailureNotice.organizationId, organization.id))
			} else {
				await db
					.update(SsoFailureNotice)
					.set({ lastNotifiedAt: claim.previous })
					.where(eq(SsoFailureNotice.organizationId, organization.id))
			}
			return { status: 'throttled', failures }
		}
		return { status: 'notified', failures, inApp, emailed }
	} catch (error) {
		console.error('Could not record the SSO failure:', {
			error: error instanceof Error ? error.name : 'unknown',
		})
		return { status: 'unknown_organization' }
	}
}
