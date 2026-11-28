/**
 * What organization admins are told when single sign-on keeps failing (#347).
 * The words come only from the kind of error, never from the error's own text:
 * a message from the identity provider can hold a user, a token or an
 * assertion, and none of that may reach an email, a notice or a log line.
 */

/** Five failures inside ten minutes make an outage. */
export const SSO_FAILURE_THRESHOLD = 5
export const SSO_FAILURE_WINDOW_MS = 10 * 60 * 1000
/** One outage sends at most one email (and one notice) per hour. */
export const SSO_NOTICE_INTERVAL_MS = 60 * 60 * 1000
/** Failure rows older than this are pruned as new ones arrive. */
export const SSO_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000

/** The notification workflow an admin mutes to stop these notices. */
export const SSO_FAILURE_WORKFLOW = 'sso-failure-workflow'
export const SSO_FAILURE_NOTIFICATION_TYPE = 'sso-failure'

export const SSO_REASON_KINDS = [
	'configuration_not_found',
	'configuration_disabled',
	'configuration_invalid',
	'identity_provider_error',
	'token_exchange_failed',
	'invalid_callback',
	'user_provisioning_failed',
	'suspicious_activity',
	'unknown_error',
] as const
export type SsoReasonKind = (typeof SSO_REASON_KINDS)[number]

export function isSsoReasonKind(value: unknown): value is SsoReasonKind {
	return (SSO_REASON_KINDS as readonly string[]).includes(value as string)
}

/** Plain English, for the email (a failure has no request language). */
export const SSO_REASON_EMAIL: Record<SsoReasonKind, string> = {
	configuration_not_found:
		'Single sign-on is not set up for the organization, so nobody can sign in with it.',
	configuration_disabled:
		'Single sign-on is switched off for the organization, so sign-ins through it are refused.',
	configuration_invalid:
		'The single sign-on settings look wrong, for example an expired or mistyped client secret, or a wrong issuer address.',
	identity_provider_error:
		'The identity provider answered with an error or could not be reached. Check that it is up and that its certificate has not expired.',
	token_exchange_failed:
		'Sign-in reached the identity provider but the sign-in token could not be exchanged. The client secret or the redirect address is the usual cause.',
	invalid_callback:
		'The identity provider sent back a sign-in response that could not be read. The redirect address registered with it may be wrong.',
	user_provisioning_failed:
		'People signed in with the identity provider, but their accounts could not be created or linked.',
	suspicious_activity:
		'Many sign-in attempts were blocked as suspicious. Someone may be guessing, or a script is retrying.',
	unknown_error:
		'Sign-ins are failing for a reason we could not classify. Check the identity provider and the single sign-on settings.',
}

/** Where an alert leads: the organization's settings. */
export function ssoAlertPath(): string {
	return '/settings'
}

/** `/auth/sso/<slug>` and its sub-paths: the organization a failing request belongs to. */
export function organizationSlugFromSsoRequestUrl(
	url: string | undefined,
): string | null {
	if (!url) return null
	let pathname: string
	try {
		pathname = new URL(url, 'http://localhost').pathname
	} catch {
		return null
	}
	const match = /^\/auth\/sso\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(pathname)
	return match?.[1] ?? null
}

export const SSO_EMAIL = {
	eyebrow: 'Single sign-on',
	settingsNote:
		'You can mute these notices in Settings, Notifications. Single sign-on itself is set up with Menuza support.',
	actionLabel: 'Open settings',
}

export function ssoFailureEmail(input: {
	organizationName: string
	reasonKind: SsoReasonKind
	failures: number
}) {
	const headline = `Single sign-on is failing for ${input.organizationName}`
	return {
		subject: headline,
		headline,
		detail: `${input.failures} sign-in attempts failed in the last 10 minutes. ${SSO_REASON_EMAIL[input.reasonKind]}`,
	}
}
