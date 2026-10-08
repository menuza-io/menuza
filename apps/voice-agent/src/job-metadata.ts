import {
	isUsOrCanadaNumber,
	type PriceFormatter,
	type TestCallMetadata,
} from '@repo/phone-agent'
import { z } from 'zod'

const TestCallMetadataSchema = z.object({
	channel: z.literal('web_test'),
	orgId: z.string().min(1).max(64),
	scopeId: z.string().min(1).max(64).nullable().default(null),
	flow: z.enum(['draft', 'published']),
})

export function parseTestMetadata(
	raw: string | undefined,
): TestCallMetadata | null {
	if (!raw) return null
	try {
		const parsed = TestCallMetadataSchema.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

const SPOKEN_DIGITS: Record<string, string> = {
	zero: '0',
	oh: '0',
	o: '0',
	one: '1',
	two: '2',
	three: '3',
	four: '4',
	five: '5',
	six: '6',
	seven: '7',
	eight: '8',
	nine: '9',
}

const NANP = /^([2-9]\d{2})([2-9]\d{2})(\d{4})$/

/**
 * A valid NANP (+1) number from what a caller says or the model writes:
 * "(555) 234-5678", "1 555 234 5678", "+1.555.234.5678", or digits spelled
 * out as words. Area codes and exchanges cannot start with 0 or 1, and N11
 * area codes (211, 911, ...) are service codes, not lines.
 */
export function normalizeUsPhone(value: string | null | undefined) {
	if (!value) return null
	const spelled = value
		.toLowerCase()
		.replace(/[a-z]+/g, (word) => SPOKEN_DIGITS[word] ?? word)
	if (/[a-z]/.test(spelled)) return null
	let digits = spelled.replace(/\D/g, '')
	if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
	const match = NANP.exec(digits)
	if (!match || match[1]!.endsWith('11')) return null
	return `+1${digits}`
}

/**
 * Caller ID and callback numbers may be international, so any E.164 number
 * is kept as is; anything else must be a US number.
 */
export function normalizeE164(value: string | null | undefined) {
	if (!value) return null
	const trimmed = value.trim()
	if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed
	return normalizeUsPhone(trimmed)
}

/**
 * Whether the number reaches this org's own agent. Dialing one, or answering
 * a call from one, means a transfer loop. `lines` can be missing on a config
 * cached before App sent it.
 */
export function isAgentLine(
	phone: string | null | undefined,
	lines: readonly string[] | null | undefined,
) {
	const number = normalizeE164(phone)
	if (!number || !lines?.length) return false
	return lines.some((line) => normalizeE164(line) === number)
}

export type DialRefusal = 'invalid' | 'agent_line' | 'not_us_or_canada'

/**
 * Why the worker must not ring or REFER a caller to this number, or null when
 * it may. Outbound legs are billed to us, so only US and Canadian numbers are
 * dialed, whatever App or the flow says (toll fraud protection).
 */
export function dialRefusal(
	phone: string | null | undefined,
	agentLines: readonly string[] | null | undefined,
): DialRefusal | null {
	const number = normalizeE164(phone)
	if (!number) return 'invalid'
	if (isAgentLine(number, agentLines)) return 'agent_line'
	if (!isUsOrCanadaNumber(number)) return 'not_us_or_canada'
	return null
}

/** The last four digits, for logs that must not carry whole phone numbers. */
export function phoneTail(phone: string | null | undefined) {
	const digits = phone?.replace(/\D/g, '') ?? ''
	return digits ? `***${digits.slice(-4)}` : null
}

export function priceFormatter(currency: string): PriceFormatter {
	const format = new Intl.NumberFormat('en-US', { style: 'currency', currency })
	return (amount) => format.format(amount)
}
