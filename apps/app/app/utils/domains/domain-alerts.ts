import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

/**
 * What the people who run the website are told about their domains (#139,
 * #183, #276, #103): the in-app notification carries the kind, the
 * organization slug and a host name (the operator's own domain), and the words
 * are written here. The email for the same event is in `notify.server.ts`.
 */

export const DOMAIN_ALERT_KINDS = [
	'live',
	'pending_reminder',
	'expired',
	'renewal_reminder',
	'renewal_failed',
	'registered',
	'registration_failed',
	'forwarding_failing',
	'sender_fallback',
	'registrant_confirmation',
] as const

export type DomainAlertKind = (typeof DOMAIN_ALERT_KINDS)[number]

export const DOMAIN_ALERT_TYPES: Record<DomainAlertKind, string> = {
	live: 'domain-live',
	pending_reminder: 'domain-pending-reminder',
	expired: 'domain-expired',
	renewal_reminder: 'domain-renewal-reminder',
	renewal_failed: 'domain-renewal-failed',
	registered: 'domain-registered',
	registration_failed: 'domain-registration-failed',
	forwarding_failing: 'domain-forwarding-failing',
	sender_fallback: 'domain-sender-fallback',
	registrant_confirmation: 'domain-registrant-confirmation',
}

const KINDS = new Map(
	(Object.entries(DOMAIN_ALERT_TYPES) as Array<[DomainAlertKind, string]>).map(
		([kind, type]) => [type, kind],
	),
)

export function domainAlertKindFromNotificationType(
	type: unknown,
): DomainAlertKind | null {
	return typeof type === 'string' ? (KINDS.get(type) ?? null) : null
}

/** Where an alert leads: the Domain screen, or Settings for the sender. */
export function domainAlertPath(kind: DomainAlertKind): string {
	return kind === 'sender_fallback' ? '/settings' : '/website/domain'
}

export function domainAlertCopy(
	kind: DomainAlertKind,
	host: string | null,
	_: (descriptor: MessageDescriptor) => string,
): { subject: string; body: string } {
	const name = host?.trim() || ''
	switch (kind) {
		case 'live':
			return {
				subject: name
					? _(msg`**${name}** is live`)
					: _(msg`Your domain is live`),
				body: _(
					msg`Your site now loads on this domain, with a secure connection.`,
				),
			}
		case 'pending_reminder':
			return {
				subject: name
					? _(msg`**${name}** is still not connected`)
					: _(msg`Your domain is still not connected`),
				body: _(
					msg`It has been a week. Open the checklist to see which records are missing.`,
				),
			}
		case 'expired':
			return {
				subject: name
					? _(msg`**${name}** was disconnected`)
					: _(msg`A domain setup timed out`),
				body: _(
					msg`It stayed unconnected for 30 days, so we released it. You can connect it again any time.`,
				),
			}
		case 'renewal_reminder':
			return {
				subject: name
					? _(msg`**${name}** renews soon`)
					: _(msg`Your domain renews soon`),
				body: _(
					msg`The card on file is charged at renewal. Turn off auto-renew on the Domain screen if you do not want to keep it.`,
				),
			}
		case 'renewal_failed':
			return {
				subject: name
					? _(msg`**${name}** could not be renewed`)
					: _(msg`A domain could not be renewed`),
				body: _(
					msg`The card on file was declined. Update your card now so you do not lose the domain.`,
				),
			}
		case 'registered':
			return {
				subject: name
					? _(msg`**${name}** is yours`)
					: _(msg`Your new domain is ready`),
				body: _(
					msg`It is registered and your site is being set up on it. Confirm the email from the registry to keep it.`,
				),
			}
		case 'registration_failed':
			return {
				subject: name
					? _(msg`**${name}** could not be registered`)
					: _(msg`A domain could not be registered`),
				body: _(msg`You were not charged, or the charge was refunded in full.`),
			}
		case 'forwarding_failing':
			return {
				subject: name
					? _(msg`Email forwarding for **${name}** is failing`)
					: _(msg`Email forwarding is failing`),
				body: _(
					msg`Mail to this domain may not be arriving. Open the domain to see which address.`,
				),
			}
		case 'sender_fallback':
			return {
				subject: name
					? _(msg`Email from **${name}** is back on our address`)
					: _(msg`Your sending domain stopped verifying`),
				body: _(
					msg`We could not verify its records, so guest emails go out from our address until you fix them.`,
				),
			}
		case 'registrant_confirmation':
			return {
				subject: name
					? _(msg`Confirm the owner email for **${name}**`)
					: _(msg`Confirm your domain owner email`),
				body: _(
					msg`The registry sent you an email. Click its link within 15 days or the domain can be suspended.`,
				),
			}
	}
}
