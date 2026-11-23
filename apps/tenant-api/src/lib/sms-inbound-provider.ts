import crypto from 'node:crypto'
import { ENV } from 'varlock/env'
import { syncEnvFromProcess, timingSafeEqualString } from './secrets.ts'

/**
 * Inbound text replies (#75), behind a small adapter so tests and local runs
 * never call a live provider. `twilio` verifies Twilio's `X-Twilio-Signature`
 * with the node's auth token. `mock` verifies an HMAC of the raw body in
 * `X-Mock-Signature` with the same token and is accepted only in an explicit
 * local runtime (`NODE_ENV` development or test). Anything else is unknown.
 */

export type InboundSms = {
	/** The provider's id for the message: the dedupe key for a retry. */
	providerMessageId: string
	/** The sender, as the provider reports it (E.164 for Twilio). */
	from: string
	/** The reply body. Read only to match a keyword; never stored. */
	body: string
}

export type InboundSmsProviderName = 'twilio' | 'mock'

function isExplicitLocalRuntime() {
	syncEnvFromProcess()
	const env = ENV.NODE_ENV
	return env === 'development' || env === 'test'
}

export function isInboundProvider(
	value: string,
): value is InboundSmsProviderName {
	if (value === 'twilio') return true
	return value === 'mock' && isExplicitLocalRuntime()
}

function authToken(): string {
	syncEnvFromProcess()
	return (ENV.TWILIO_AUTH_TOKEN as string | undefined) ?? ''
}

/** Twilio's signature: base64 HMAC-SHA1 of the URL plus the sorted `key + value` pairs. */
export function twilioSignature(
	token: string,
	url: string,
	params: Record<string, string>,
): string {
	const data = Object.keys(params)
		.sort()
		.reduce((acc, key) => acc + key + params[key], url)
	return crypto.createHmac('sha1', token).update(data).digest('base64')
}

export function mockSignature(token: string, rawBody: string): string {
	return crypto.createHmac('sha256', token).update(rawBody).digest('hex')
}

export type VerifiedInbound =
	| { ok: true; message: InboundSms }
	| { ok: false; reason: 'unconfigured' | 'bad_signature' | 'bad_payload' }

/**
 * Verifies the signature first, then reads the message. A request whose
 * signature does not match is refused before its fields are looked at.
 * `publicUrl` is the exact URL the provider was configured to call.
 */
export function verifyInboundSms(
	provider: InboundSmsProviderName,
	input: {
		publicUrl: string
		rawBody: string
		signature: string | null | undefined
	},
): VerifiedInbound {
	const token = authToken()
	if (token.length < 8) return { ok: false, reason: 'unconfigured' }
	const presented = input.signature ?? ''
	const params = Object.fromEntries(
		new URLSearchParams(input.rawBody),
	) as Record<string, string>
	const expected =
		provider === 'twilio'
			? twilioSignature(token, input.publicUrl, params)
			: mockSignature(token, input.rawBody)
	if (!presented || !timingSafeEqualString(presented, expected)) {
		return { ok: false, reason: 'bad_signature' }
	}
	const providerMessageId = params.MessageSid ?? params.SmsSid ?? ''
	const from = params.From ?? ''
	if (
		!/^[A-Za-z0-9_-]{6,64}$/.test(providerMessageId) ||
		!/^\+?[0-9]{6,20}$/.test(from)
	) {
		return { ok: false, reason: 'bad_payload' }
	}
	return {
		ok: true,
		message: {
			providerMessageId,
			from,
			// Longer than any keyword is never one: the cap keeps a huge body
			// out of memory without changing the answer.
			body: (params.Body ?? '').slice(0, 64),
		},
	}
}

export type SmsStatusEvent = {
	/** The provider's id for the message that was sent. */
	providerMessageId: string
	/** The provider's own status word (`delivered`, `undelivered`, `failed`...). */
	status: string
	/** The carrier error code of a failure, or null. */
	errorCode: string | null
}

export type VerifiedStatus =
	| { ok: true; event: SmsStatusEvent }
	| { ok: false; reason: 'unconfigured' | 'bad_signature' | 'bad_payload' }

/**
 * A delivery status callback for a text this node sent (#246). The same
 * signature check as an inbound reply, then only the message id, the status word
 * and the error code are read: no number and no body ever reaches this path.
 */
export function verifySmsStatus(
	provider: InboundSmsProviderName,
	input: {
		publicUrl: string
		rawBody: string
		signature: string | null | undefined
	},
): VerifiedStatus {
	const token = authToken()
	if (token.length < 8) return { ok: false, reason: 'unconfigured' }
	const presented = input.signature ?? ''
	const params = Object.fromEntries(
		new URLSearchParams(input.rawBody),
	) as Record<string, string>
	const expected =
		provider === 'twilio'
			? twilioSignature(token, input.publicUrl, params)
			: mockSignature(token, input.rawBody)
	if (!presented || !timingSafeEqualString(presented, expected)) {
		return { ok: false, reason: 'bad_signature' }
	}
	const providerMessageId = params.MessageSid ?? params.SmsSid ?? ''
	const status = params.MessageStatus ?? params.SmsStatus ?? ''
	if (
		!/^[A-Za-z0-9_-]{6,64}$/.test(providerMessageId) ||
		!/^[a-z_]{3,20}$/.test(status)
	) {
		return { ok: false, reason: 'bad_payload' }
	}
	const errorCode = /^\d{3,6}$/.test(params.ErrorCode ?? '')
		? (params.ErrorCode ?? null)
		: null
	return { ok: true, event: { providerMessageId, status, errorCode } }
}

function escapeXml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

/** The TwiML answer: one reply text, or nothing. */
export function twimlReply(text: string | null): string {
	return text
		? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(text)}</Message></Response>`
		: '<?xml version="1.0" encoding="UTF-8"?><Response/>'
}
