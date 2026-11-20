/**
 * How an organization's guest email is sent (#103): the sender name, the
 * reply-to and a custom sending domain. Pure rules shared by the App (settings,
 * verification) and tenant-api (every send), so both agree on what is a valid
 * name, a valid local part and what the From line becomes.
 */

export const SENDER_NAME_MAX = 64

export type SenderFailure =
	| 'invalid_sender_name'
	| 'reply_to_unverified'
	| 'invalid_reply_to'
	| 'domain_in_use'
	| 'invalid_domain'
	| 'invalid_local_part'

/** Characters a display name may never carry: they end the name or the header. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[@<>"\\,;:\u0000-\u001f\u007f\u0085\u2028\u2029]/u

export type SenderNameResult =
	| { ok: true; value: string | null }
	| { ok: false; code: 'invalid_sender_name' }

/**
 * The sender name: at most 64 characters, no `@`, `<`, `>` or line breaks
 * (`invalid_sender_name`). Empty means "use the organization name".
 */
export function validateSenderName(
	input: string | null | undefined,
): SenderNameResult {
	const value = (input ?? '').trim().replace(/\s+/gu, ' ')
	if (!value) return { ok: true, value: null }
	if (value.length > SENDER_NAME_MAX)
		return { ok: false, code: 'invalid_sender_name' }
	if (FORBIDDEN_NAME_CHARS.test(value))
		return { ok: false, code: 'invalid_sender_name' }
	return { ok: true, value }
}

/**
 * A display name made safe for a header at send time: whatever the stored
 * value holds, a break, bracket, comma or quote never reaches the message.
 * Falls back to `fallback` when nothing is left.
 */
export function safeDisplayName(
	name: string | null | undefined,
	fallback = '',
): string {
	const cleaned = (name ?? '')
		.replace(new RegExp(FORBIDDEN_NAME_CHARS.source, 'gu'), ' ')
		.replace(/\s+/gu, ' ')
		.trim()
		.slice(0, SENDER_NAME_MAX)
	return cleaned || fallback
}

const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u

export function isValidSenderLocalPart(value: string): boolean {
	return LOCAL_PART_RE.test(value) && !value.includes('..')
}

const EMAIL_RE =
	/^[^\s@<>",;()[\]\\]{1,64}@[^\s@<>",;()[\]\\]+\.[^\s@<>",;()[\]\\]+$/u

/** A single plain address: no name part, list, comment or line break. */
export function isPlainEmailAddress(value: string): boolean {
	return value.length <= 254 && EMAIL_RE.test(value)
}

export type OrganizationEmailIdentity = {
	/** The sender name to show; null: the organization name. */
	senderName: string | null
	/** A reply-to the operator proved they own; null: none. */
	replyTo: string | null
	/** The address to send from once the custom domain is verified; null: platform address. */
	fromEmail: string | null
}

export type PlatformSender = { email: string; name: string }

export type ResolvedSender = {
	sender: { email: string; name: string }
	replyTo: { email: string } | null
	/** The message is signed by the organization's own domain. */
	customDomain: boolean
}

/**
 * What a message goes out as. The name is the organization's chosen name (or
 * its name) in every case; the address is the organization's own only after
 * its domain is verified, otherwise the platform's. Reply-to is used only when
 * it was verified (the settings only ever expose verified ones).
 */
export function resolveSender(input: {
	identity: OrganizationEmailIdentity | null
	organizationName: string | null
	platform: PlatformSender
}): ResolvedSender {
	const { identity, platform } = input
	const name = safeDisplayName(
		identity?.senderName ?? input.organizationName,
		platform.name,
	)
	const fromEmail =
		identity?.fromEmail && isPlainEmailAddress(identity.fromEmail)
			? identity.fromEmail
			: null
	const replyTo =
		identity?.replyTo && isPlainEmailAddress(identity.replyTo)
			? { email: identity.replyTo }
			: null
	return {
		sender: { email: fromEmail ?? platform.email, name },
		replyTo,
		customDomain: Boolean(fromEmail),
	}
}

/** A sending domain: a registrable domain, lower case, no subdomain trick. */
export function isValidSenderDomain(value: string): boolean {
	return (
		value.length <= 253 &&
		/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u.test(value)
	)
}
