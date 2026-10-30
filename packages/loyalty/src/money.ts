import { z } from 'zod'

/**
 * Integer money and point arithmetic. Money is always integer minor units
 * (cents, halalas) with an explicit ISO currency; percentages are basis points
 * (1% = 100 bp). Products go through BigInt so large carts never lose
 * precision, and every rounding direction is explicit.
 */

/** Largest money amount accepted anywhere in loyalty (10 billion major units). */
export const LOYALTY_MAX_MINOR = 1_000_000_000_000
/** Largest point amount on a single entry or reward. */
export const LOYALTY_MAX_POINTS = 100_000_000

export const minorSchema = z.number().int().min(0).max(LOYALTY_MAX_MINOR)
export const positiveMinorSchema = minorSchema.min(1)
export const currencySchema = z
	.string()
	.regex(/^[A-Z]{3}$/, 'currency must be a 3-letter uppercase ISO code')

export {
	allocateProportionally,
	BASIS_POINTS,
	inclusiveTaxMinor,
	mulDiv,
	normalizeCurrency,
	sameCurrency,
	sumMinor,
	type Rounding,
} from '@repo/discounts'
