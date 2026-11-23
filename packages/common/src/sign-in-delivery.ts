/**
 * Sign-in code delivery (#246): the vocabulary and the pure rules shared by the
 * App (which writes the log and receives the providers' status callbacks) and
 * Admin (which reads it). Nothing here handles a code: the log has no column
 * for one.
 */

export const SIGN_IN_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const SIGN_IN_CODE_PURPOSES = [
	'signup',
	'reset_password',
	'change_email',
	'alert_recipient',
	'phone_line',
	'sign_in_help',
] as const
export type SignInCodePurpose = (typeof SIGN_IN_CODE_PURPOSES)[number]

export const SIGN_IN_CHANNELS = ['email', 'sms'] as const
export type SignInChannel = (typeof SIGN_IN_CHANNELS)[number]

export const SIGN_IN_PROVIDERS = ['resend', 'oci', 'twilio', 'mock'] as const
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number]

export const DELIVERY_STATUSES = [
	'sent',
	'delivered',
	'delayed',
	'failed',
	'bounced',
	'complained',
] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

/** A status that is final: a later, weaker event (for example "sent") must not undo it. */
const RANK: Record<DeliveryStatus, number> = {
	sent: 0,
	delayed: 1,
	delivered: 2,
	failed: 3,
	bounced: 3,
	complained: 4,
}

/** Providers send events out of order: keep the later stage. */
export function mergeDeliveryStatus(
	current: DeliveryStatus,
	incoming: DeliveryStatus,
): DeliveryStatus {
	return RANK[incoming] >= RANK[current] ? incoming : current
}

export function isFailureStatus(status: string): boolean {
	return status === 'failed' || status === 'bounced' || status === 'complained'
}

/** Resend webhook event types to a status. Anything else is not a delivery event. */
export function statusFromResendEvent(type: unknown): DeliveryStatus | null {
	switch (type) {
		case 'email.sent':
			return 'sent'
		case 'email.delivered':
			return 'delivered'
		case 'email.delivery_delayed':
			return 'delayed'
		case 'email.bounced':
			return 'bounced'
		case 'email.complained':
			return 'complained'
		case 'email.failed':
			return 'failed'
		default:
			return null
	}
}

/** Twilio message status to a status. */
export function statusFromTwilioStatus(value: unknown): DeliveryStatus | null {
	switch (value) {
		case 'queued':
		case 'accepted':
		case 'sending':
		case 'sent':
			return 'sent'
		case 'delivered':
			return 'delivered'
		case 'undelivered':
			return 'bounced'
		case 'failed':
			return 'failed'
		default:
			return null
	}
}

/** What a carrier error code means, in words support can use. Unknown codes are shown as the code. */
const TWILIO_ERRORS: Record<string, string> = {
	'30003': 'Phone is unreachable or switched off',
	'30004': 'Message blocked',
	'30005': 'Unknown or inactive number',
	'30006': 'Landline or unreachable carrier',
	'30007': 'Carrier filtered the message as spam',
	'30008': 'Unknown error from the carrier',
	'21211': 'Not a valid phone number',
	'21614': 'Not a mobile number',
	'21610': 'Number has opted out (STOP)',
}

export function describeFailureReason(
	channel: SignInChannel,
	reason: string | null | undefined,
): string | null {
	if (!reason) return null
	if (channel === 'sms') {
		const known = TWILIO_ERRORS[reason]
		return known ? `${known} (${reason})` : `Carrier error ${reason}`
	}
	return reason.replace(/_/g, ' ')
}

/** `j***@example.com`: enough to recognise, not enough to reuse. */
export function maskEmail(email: string): string {
	const [local = '', domain = ''] = email.trim().toLowerCase().split('@')
	if (!domain) return '***'
	return `${local.slice(0, 1)}***@${domain}`
}

/** `+1 ••• ••• 1234`. */
export function maskPhone(e164: string): string {
	const digits = e164.replace(/[^\d]/g, '')
	if (digits.length < 7) return '•••'
	const country = e164.startsWith('+')
		? `+${digits.slice(0, digits.length - 10 > 0 ? digits.length - 10 : 1)}`
		: ''
	return `${country} ••• ••• ${digits.slice(-4)}`.trim()
}

export type LineType = 'mobile' | 'landline' | 'voip' | 'unknown'

/** The text provider's line type, reduced to the four words support sees. */
export function classifyLineType(value: unknown): LineType {
	const type = typeof value === 'string' ? value.toLowerCase() : ''
	if (type === 'mobile') return 'mobile'
	if (type === 'landline' || type === 'fixedline' || type === 'fixed_line') {
		return 'landline'
	}
	if (
		type.includes('voip') ||
		type === 'nonfixedvoip' ||
		type === 'fixedvoip'
	) {
		return 'voip'
	}
	return 'unknown'
}

export type NumberCheck = {
	valid: boolean
	lineType: LineType
	carrier: string | null
}

export type NumberProblem = 'invalid' | 'landline' | 'voip' | null

/**
 * Whether a number cannot receive a text code: not a valid number, or a
 * landline. A virtual number is flagged as risky, not as impossible.
 */
export function numberProblem(
	check: Pick<NumberCheck, 'valid' | 'lineType'> | null,
): NumberProblem {
	if (!check) return null
	if (!check.valid) return 'invalid'
	if (check.lineType === 'landline') return 'landline'
	if (check.lineType === 'voip') return 'voip'
	return null
}

export const NUMBER_PROBLEM_TEXT: Record<
	Exclude<NumberProblem, null>,
	string
> = {
	invalid: 'This is not a valid phone number, so no text can reach it.',
	landline: 'This is a landline: it cannot receive a text code.',
	voip: 'This is a virtual (VoIP) number: texts to it are often blocked.',
}
