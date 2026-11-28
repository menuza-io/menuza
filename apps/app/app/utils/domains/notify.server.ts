import { db, eq, Notification, Organization } from '@repo/database'
import { sendEmail, StaffingAlertEmail } from '@repo/email'
import { createElement } from 'react'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { recordOrganizationEvent } from '#app/utils/organization-events.server.ts'
import {
	DOMAIN_ALERT_TYPES,
	domainAlertPath,
	type DomainAlertKind,
} from './domain-alerts.ts'

export {
	resolveDomainAlertRecipients,
	type DomainAlertRecipient,
} from './recipients.server.ts'
import { resolveDomainAlertRecipients } from './recipients.server.ts'

/** The email for each event, in plain English (a job has no request language). */
export function domainAlertEmail(
	kind: DomainAlertKind,
	host: string,
	extra: { detail?: string } = {},
): { subject: string; headline: string; detail: string } {
	const copy: Record<DomainAlertKind, { headline: string; detail: string }> = {
		live: {
			headline: `${host} is live`,
			detail: 'Your site now loads on this domain, with a secure connection.',
		},
		pending_reminder: {
			headline: `${host} is still not connected`,
			detail:
				extra.detail ??
				'It has been a week since you started. Open the domain checklist to see which DNS records are missing.',
		},
		expired: {
			headline: `${host} was disconnected`,
			detail:
				'It stayed unconnected for 30 days, so we released it. You can connect it again any time from the Domain screen.',
		},
		renewal_reminder: {
			headline: `${host} renews soon`,
			detail:
				extra.detail ??
				'The card on file is charged when it renews. Turn off auto-renew on the Domain screen if you do not want to keep it.',
		},
		renewal_failed: {
			headline: `${host} could not be renewed`,
			detail:
				extra.detail ??
				'The card on file was declined. Update your card now so you do not lose the domain.',
		},
		registered: {
			headline: `${host} is yours`,
			detail:
				'It is registered and your site is being set up on it. Click the confirmation link the registry emailed you to keep it.',
		},
		registration_failed: {
			headline: `${host} could not be registered`,
			detail: 'You were not charged, or the charge was refunded in full.',
		},
		forwarding_failing: {
			headline: `Email forwarding for ${host} is failing`,
			detail:
				'Mail to this domain may not be arriving in your inbox. Open the domain to see which address.',
		},
		sender_fallback: {
			headline: `Guest email from ${host} is back on our address`,
			detail:
				'We could not verify the sending records of your domain, so guest emails go out from our address until you fix them. Open Settings, Email sending to re-check.',
		},
		registrant_confirmation: {
			headline: `Confirm the owner email for ${host}`,
			detail:
				'The registry sent you an email. Click its link within 15 days or the domain can be suspended.',
		},
	}
	return { subject: copy[kind].headline, ...copy[kind] }
}

const DOMAIN_FAILING_STATES: Partial<Record<DomainAlertKind, string>> = {
	expired: 'expired',
	renewal_failed: 'renewal_failed',
	registration_failed: 'registration_failed',
	forwarding_failing: 'forwarding_failing',
	sender_fallback: 'sender_fallback',
}

const DOMAIN_REMINDERS = new Set<DomainAlertKind>([
	'pending_reminder',
	'renewal_reminder',
	'registrant_confirmation',
])

async function recordDomainTimelineEvent(input: {
	organizationId: string
	kind: DomainAlertKind
	entityId: string
	host: string
}) {
	const dedupeKey = `domain:${input.kind}:${input.entityId}`
	if (input.kind === 'live') {
		await recordOrganizationEvent({
			organizationId: input.organizationId,
			kind: 'domain_live',
			payload: { host: input.host },
			dedupeKey,
		})
	} else if (input.kind === 'registered') {
		await recordOrganizationEvent({
			organizationId: input.organizationId,
			kind: 'domain_registered',
			payload: { host: input.host },
			dedupeKey,
		})
	} else if (DOMAIN_FAILING_STATES[input.kind]) {
		await recordOrganizationEvent({
			organizationId: input.organizationId,
			kind: 'domain_failing',
			payload: { host: input.host, state: DOMAIN_FAILING_STATES[input.kind] },
			dedupeKey,
		})
	} else if (DOMAIN_REMINDERS.has(input.kind)) {
		await recordOrganizationEvent({
			organizationId: input.organizationId,
			kind: 'reminder_sent',
			payload: { reminderKind: `domain_${input.kind}` },
			dedupeKey,
		})
	}
}

/**
 * Tells the people who run the domain: an in-app notification and an email,
 * once per `entityId` and kind. Never throws: a notice must not undo the work
 * that triggered it. Returns how many people were told.
 */
export async function notifyDomainEvent(input: {
	organizationId: string
	kind: DomainAlertKind
	/** Makes the notice unique (the host id, or a date for repeating notices). */
	entityId: string
	host: string
	/** Tell these members; default: everyone who can change settings. */
	userIds?: string[]
	detail?: string
}): Promise<number> {
	// One place sees every domain event, so the Admin Timeline (#279) is written
	// here: host and state only, once per notice.
	await recordDomainTimelineEvent(input)
	try {
		const [organization] = await db
			.select({ slug: Organization.slug })
			.from(Organization)
			.where(eq(Organization.id, input.organizationId))
			.limit(1)
		if (!organization) return 0
		let recipients = await resolveDomainAlertRecipients(input.organizationId)
		if (input.userIds?.length) {
			const wanted = recipients.filter((r) => input.userIds!.includes(r.userId))
			if (wanted.length > 0) recipients = wanted
		}
		const email = domainAlertEmail(input.kind, input.host, {
			detail: input.detail,
		})
		const url = `${readLiveEnv('BASE_URL').replace(/\/$/u, '')}/${organization.slug}${domainAlertPath(input.kind)}`
		let told = 0
		for (const recipient of recipients) {
			const inserted = await db
				.insert(Notification)
				.values({
					userId: recipient.userId,
					organizationId: input.organizationId,
					type: DOMAIN_ALERT_TYPES[input.kind],
					entityId: input.entityId,
					payload: JSON.stringify({
						orgSlug: organization.slug,
						host: input.host,
						kind: input.kind,
					}),
				})
				.onConflictDoNothing()
				.returning({ id: Notification.id })
			// Already told for this event: no second email either.
			if (inserted.length === 0) continue
			told += 1
			try {
				await sendEmail({
					to: recipient.email,
					subject: email.subject,
					react: createElement(StaffingAlertEmail, {
						eyebrow: 'Website',
						headline: email.headline,
						detail: email.detail,
						actionLabel: 'Open domain settings',
						actionUrl: url,
					}),
				})
			} catch (error) {
				console.error(
					'Domain notice email failed:',
					error instanceof Error ? error.message : error,
				)
			}
		}
		return told
	} catch (error) {
		console.error(
			'Domain notice failed:',
			error instanceof Error ? error.message : error,
		)
		return 0
	}
}
