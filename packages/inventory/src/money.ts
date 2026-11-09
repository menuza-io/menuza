import { z } from 'zod'

/**
 * Money is integer minor units (cents, halalas) with an explicit ISO currency;
 * rates are basis points. Arithmetic is shared with discounts and loyalty.
 */

/** Largest money amount accepted on one inventory record (10 billion major). */
export const INVENTORY_MAX_MINOR = 1_000_000_000_000

export const inventoryMinorSchema = z
	.number()
	.int()
	.min(0)
	.max(INVENTORY_MAX_MINOR)
export const inventoryCurrencySchema = z
	.string()
	.regex(/^[A-Z]{3}$/, 'currency must be a 3-letter uppercase ISO code')

export {
	allocateProportionally,
	BASIS_POINTS,
	mulDiv,
	normalizeCurrency,
	sameCurrency,
	sumMinor,
	type Rounding,
} from '@repo/discounts'
