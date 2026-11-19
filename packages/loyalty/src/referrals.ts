import { z } from 'zod'
import { LOYALTY_CODE_ALPHABET } from './codes.ts'
import { minorSchema } from './money.ts'
import { loyaltyDiscountSchema } from './rewards.ts'

export const LOYALTY_REFERRAL_STATUSES = [
	'claimed',
	'pending_order',
	'holding',
	'credited',
	'cancelled',
	'reversed',
] as const
export type LoyaltyReferralStatus = (typeof LOYALTY_REFERRAL_STATUSES)[number]

/** Synthetic control-plane discount id passed into `@repo/discounts` evaluation for referral codes. */
export const LOYALTY_REFERRAL_DISCOUNT_ID = 'loyalty_referral'

export const LOYALTY_REFERRAL_CODE_PREFIX = 'REF-'
export const LOYALTY_REFERRAL_CODE_BODY_LENGTH = 8
export const LOYALTY_REFERRAL_DEFAULT_HOLD_DAYS = 14
export const LOYALTY_REFERRAL_DEFAULT_MAX_PER_MEMBER = 20
export const LOYALTY_REFERRAL_MAX_POINTS = 100_000

const CODE_REGEX = new RegExp(
	`^REF-[${LOYALTY_CODE_ALPHABET}]{${LOYALTY_REFERRAL_CODE_BODY_LENGTH}}$`,
)

export const loyaltyReferralConfigSchema = z
	.object({
		enabled: z.boolean().default(false),
		referrerPoints: z
			.number()
			.int()
			.min(0)
			.max(LOYALTY_REFERRAL_MAX_POINTS)
			.default(0),
		friendPoints: z
			.number()
			.int()
			.min(0)
			.max(LOYALTY_REFERRAL_MAX_POINTS)
			.default(0),
		friendDiscount: loyaltyDiscountSchema.nullable().default(null),
		minimumOrderMinor: minorSchema.default(0),
		holdDays: z
			.number()
			.int()
			.min(0)
			.max(60)
			.default(LOYALTY_REFERRAL_DEFAULT_HOLD_DAYS),
		maxReferralsPerMember: z
			.number()
			.int()
			.min(1)
			.max(500)
			.default(LOYALTY_REFERRAL_DEFAULT_MAX_PER_MEMBER),
		maxReferralsPerMonth: z
			.number()
			.int()
			.min(1)
			.max(200)
			.nullable()
			.default(null),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.enabled &&
			value.referrerPoints <= 0 &&
			value.friendPoints <= 0 &&
			value.friendDiscount === null
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['referrerPoints'],
				message:
					'Configure at least one referrer bonus or friend offer when referrals are enabled',
			})
		}
	})

export type LoyaltyReferralConfig = z.infer<typeof loyaltyReferralConfigSchema>

export const DEFAULT_LOYALTY_REFERRAL_CONFIG: Readonly<LoyaltyReferralConfig> =
	Object.freeze({
		enabled: false,
		referrerPoints: 0,
		friendPoints: 0,
		friendDiscount: null,
		minimumOrderMinor: 0,
		holdDays: LOYALTY_REFERRAL_DEFAULT_HOLD_DAYS,
		maxReferralsPerMember: LOYALTY_REFERRAL_DEFAULT_MAX_PER_MEMBER,
		maxReferralsPerMonth: null,
	})

/**
 * Generates an uppercase Crockford-base32 share code prefixed `REF-`.
 * Uses rejection sampling so every symbol in `LOYALTY_CODE_ALPHABET` is uniform.
 */
export function generateReferralCode(
	nextBytes: (count: number) => Uint8Array = (count) => {
		const buf = new Uint8Array(count)
		crypto.getRandomValues(buf)
		return buf
	},
): string {
	const modulo = LOYALTY_CODE_ALPHABET.length
	const limit = 256 - (256 % modulo)
	let out = ''
	while (out.length < LOYALTY_REFERRAL_CODE_BODY_LENGTH) {
		const chunk = nextBytes(
			(LOYALTY_REFERRAL_CODE_BODY_LENGTH - out.length) * 2,
		)
		for (const byte of chunk) {
			if (byte < limit) {
				out += LOYALTY_CODE_ALPHABET[byte % modulo]
				if (out.length === LOYALTY_REFERRAL_CODE_BODY_LENGTH) break
			}
		}
	}
	return `${LOYALTY_REFERRAL_CODE_PREFIX}${out}`
}

/**
 * Normalizes a candidate referral code (`REF-XXXX` or `XXXX`) for comparison.
 * Strips whitespace, accepts missing `REF-` dash variations, and maps ambiguous
 * I/L/O to Crockford 1/1/0. Returns `null` when malformed.
 */
export function normalizeReferralCode(raw: string): string | null {
	if (typeof raw !== 'string' || raw.length > 32) return null
	const stripped = raw
		.trim()
		.toUpperCase()
		.replace(/^REF[-\s]?/, '')
		.replace(/[\s-]/g, '')
		.replace(/O/g, '0')
		.replace(/[IL]/g, '1')
	if (stripped.length !== LOYALTY_REFERRAL_CODE_BODY_LENGTH) return null
	const formatted = `${LOYALTY_REFERRAL_CODE_PREFIX}${stripped}`
	return CODE_REGEX.test(formatted) ? formatted : null
}

export function isReferralCodeFormat(raw: string): boolean {
	return normalizeReferralCode(raw) !== null
}
