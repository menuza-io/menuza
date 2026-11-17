import { z } from 'zod'
import { DISCOUNT_MAX_MINOR } from './definition.ts'
import { DISCOUNT_USAGE_MAX_IDS, discountUsageIdSchema } from './token.ts'

/**
 * How a discount performed (#390): orders, the sales of those orders, what the
 * discount gave and the sales for each unit given. Read from the guest's
 * region by `GET /operator/discounts/performance`; ids and amounts only, so
 * names and labels come from the App. Money follows the reports' sales rule
 * (`salesBasis`, #331): `net` is items and fees after discounts and loyalty
 * rewards, without tax and tips; `gross` is the same before them.
 */

/**
 * A discount used on fewer orders than this in the period shows its figures
 * but no return per unit: a few orders say nothing about whether it pays.
 */
export const DISCOUNT_PERFORMANCE_MIN_ORDERS = 10

/** The longest period one request may ask about, in days. */
export const DISCOUNT_PERFORMANCE_MAX_DAYS = 366

export const DISCOUNT_PERFORMANCE_BASIS_VALUES = ['gross', 'net'] as const
export type DiscountPerformanceBasis =
	(typeof DISCOUNT_PERFORMANCE_BASIS_VALUES)[number]

const localDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const discountPerformanceQuerySchema = z
	.object({
		ids: z.array(discountUsageIdSchema).max(DISCOUNT_USAGE_MAX_IDS),
		from: localDaySchema,
		to: localDaySchema,
		/** An IANA zone: the period's days are read on this clock. Default UTC. */
		tz: z.string().max(64).optional(),
		basis: z.enum(DISCOUNT_PERFORMANCE_BASIS_VALUES).default('net'),
	})
	.strict()
export type DiscountPerformanceQuery = z.infer<
	typeof discountPerformanceQuerySchema
>

const minorSchema = z.number().int().min(0).max(DISCOUNT_MAX_MINOR)

export const discountPerformanceEntrySchema = z
	.object({
		discountId: z.string(),
		/** Orders that used it (web, table tab or till sale; reserved or consumed). */
		orders: z.number().int().min(0),
		/** Sales of those orders by the chosen basis, whole orders, not just the discounted part. */
		salesMinor: minorSchema,
		/** What it gave: items plus delivery. */
		discountMinor: minorSchema,
	})
	.strict()
export type DiscountPerformanceEntry = z.infer<
	typeof discountPerformanceEntrySchema
>

export const discountPerformanceResponseSchema = z
	.object({
		basis: z.enum(DISCOUNT_PERFORMANCE_BASIS_VALUES),
		entries: z.array(discountPerformanceEntrySchema),
		/** Every order that counts as a sale in the period, discounted or not. */
		ordersTotal: z.number().int().min(0),
		/** Of those, the orders that used at least one discount (till discounts included). */
		ordersWithDiscount: z.number().int().min(0),
	})
	.strict()
export type DiscountPerformanceResponse = z.infer<
	typeof discountPerformanceResponseSchema
>

export type DiscountPerformanceFigures =
	| { enough: false; orders: number }
	| {
			enough: true
			orders: number
			/** Minor units of sales for each minor unit of discount, or null when nothing was given. */
			returnPerUnit: number | null
	  }

/**
 * The derived figures of one entry. Below `DISCOUNT_PERFORMANCE_MIN_ORDERS`
 * orders the return is not worked out ("not enough data").
 */
export function discountPerformanceFigures(
	entry: Pick<
		DiscountPerformanceEntry,
		'orders' | 'salesMinor' | 'discountMinor'
	>,
): DiscountPerformanceFigures {
	if (entry.orders < DISCOUNT_PERFORMANCE_MIN_ORDERS) {
		return { enough: false, orders: entry.orders }
	}
	return {
		enough: true,
		orders: entry.orders,
		returnPerUnit:
			entry.discountMinor > 0 ? entry.salesMinor / entry.discountMinor : null,
	}
}
