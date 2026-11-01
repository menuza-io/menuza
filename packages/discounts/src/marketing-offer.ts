import { z } from 'zod'
import { DISCOUNT_CODE_PATTERN, normalizeDiscountCode } from './definition.ts'

/**
 * A coupon attached to a marketing message (a broadcast, or an email or text
 * step of an automation). The message shows it through the `{{couponCode}}`
 * merge tag.
 *
 * - `shared`: every recipient gets the same code, one of the discount's own
 *   codes, picked by the operator.
 * - `unique`: the region mints one single-use code per recipient when the
 *   message goes out (`discount_issued_codes`). It is usable once, by anyone
 *   who has it, until it expires, and only while its discount is active.
 *
 * The App checks the discount (a code discount of the organization, active)
 * when the message is saved; the region checks it again at checkout, so a
 * discount paused or archived later stops its codes from applying.
 */

/** The merge tag a coupon fills in. */
export const COUPON_CODE_MERGE_TAG = 'couponCode'

/** Most characters a unique code's prefix may have (a code is at most 24). */
export const MARKETING_CODE_PREFIX_MAX = 12
/** Random characters after the prefix. 31^8 is about 8.5 × 10^11. */
export const MARKETING_CODE_RANDOM_LENGTH = 8
/** No 0/O, 1/I/L: the code is read off a phone screen and typed. */
export const MARKETING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const MARKETING_CODE_VALID_DAYS_DEFAULT = 30
export const MARKETING_CODE_VALID_DAYS_MAX = 365

const prefixSchema = z
	.string()
	.trim()
	.max(MARKETING_CODE_PREFIX_MAX)
	.regex(/^[A-Za-z0-9]*$/, 'Letters and digits only')
	.transform((value) => value.toUpperCase())

export const marketingOfferSchema = z.discriminatedUnion('mode', [
	z
		.object({
			mode: z.literal('shared'),
			discountId: z.string().min(1).max(100),
			/** The code as the operator typed it on the discount. */
			code: z.string().regex(DISCOUNT_CODE_PATTERN),
		})
		.strict(),
	z
		.object({
			mode: z.literal('unique'),
			discountId: z.string().min(1).max(100),
			prefix: prefixSchema.default(''),
			validDays: z
				.number()
				.int()
				.min(1)
				.max(MARKETING_CODE_VALID_DAYS_MAX)
				.default(MARKETING_CODE_VALID_DAYS_DEFAULT),
		})
		.strict(),
])

export type MarketingOffer = z.infer<typeof marketingOfferSchema>
export type MarketingOfferInput = z.input<typeof marketingOfferSchema>

/** Parses a stored or sent offer; anything else reads as no offer. */
export function parseMarketingOffer(value: unknown): MarketingOffer | null {
	if (value === null || value === undefined || value === '') return null
	let raw: unknown = value
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw) as unknown
		} catch {
			return null
		}
	}
	const parsed = marketingOfferSchema.safeParse(raw)
	return parsed.success ? parsed.data : null
}

/** Whether any of the texts uses `{{couponCode}}` (with or without a fallback). */
export function usesCouponCodeTag(
	...texts: ReadonlyArray<string | null | undefined>
): boolean {
	const pattern = new RegExp(
		`\\{\\{\\s*${COUPON_CODE_MERGE_TAG}\\s*(?:\\|[^{}]*)?\\}\\}`,
	)
	return texts.some((text) => typeof text === 'string' && pattern.test(text))
}

/**
 * A new unique code: `PREFIX-XXXXXXXX`, or just the random part without a
 * prefix. `randomBytes` is injected so the function stays pure (tenant-api
 * passes `crypto.getRandomValues`). Rejection sampling keeps every character
 * equally likely.
 */
export function generateMarketingCode(
	prefix: string,
	randomBytes: (length: number) => Uint8Array,
): { code: string; normalizedCode: string } {
	const alphabet = MARKETING_CODE_ALPHABET
	const limit = 256 - (256 % alphabet.length)
	let random = ''
	while (random.length < MARKETING_CODE_RANDOM_LENGTH) {
		for (const byte of randomBytes(MARKETING_CODE_RANDOM_LENGTH * 2)) {
			if (byte >= limit) continue
			random += alphabet[byte % alphabet.length]
			if (random.length === MARKETING_CODE_RANDOM_LENGTH) break
		}
	}
	const cleanPrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '')
	const code = cleanPrefix ? `${cleanPrefix}-${random}` : random
	return { code, normalizedCode: normalizeDiscountCode(code) }
}
