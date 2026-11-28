import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type SsoReasonKind } from './sso-alerts.ts'

/**
 * The words of the single sign-on notice in the notification bell (#347), in
 * the member's language. Kept apart from `sso-alerts.ts`, which the server
 * imports: a module with Lingui macros must only be loaded through the build.
 */

/** The same sentences in the notification bell, in the member's language. */
export const SSO_REASON_TEXT: Record<SsoReasonKind, MessageDescriptor> = {
	configuration_not_found: msg`Single sign-on is not set up, so nobody can sign in with it.`,
	configuration_disabled: msg`Single sign-on is switched off, so sign-ins through it are refused.`,
	configuration_invalid: msg`The single sign-on settings look wrong, such as an expired client secret.`,
	identity_provider_error: msg`The identity provider returned an error or could not be reached.`,
	token_exchange_failed: msg`The sign-in token could not be exchanged. Check the client secret and redirect address.`,
	invalid_callback: msg`The identity provider sent back a response that could not be read.`,
	user_provisioning_failed: msg`People signed in, but their accounts could not be created or linked.`,
	suspicious_activity: msg`Many sign-in attempts were blocked as suspicious.`,
	unknown_error: msg`Sign-ins are failing for a reason we could not classify.`,
}

export const SSO_NOTICE_SUBJECT = msg`**Single sign-on is failing**`
