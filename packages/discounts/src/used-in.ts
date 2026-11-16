import { z } from 'zod'
import { discountUsageIdSchema } from './token.ts'

/**
 * Where a discount is promised (#236): the broadcasts waiting to go out or
 * sending, and the automations that are running, whose coupon is this discount.
 * It is read from the customer's region by ids and operator-written names only:
 * no recipient, no address, no code, never a customer. A paused or archived
 * discount (or a shorter end date) would break these messages, so the discounts
 * screens show them first.
 */

export const DISCOUNT_USED_IN_MAX = 200

export const discountUsedInQuerySchema = z
	.object({ discountId: discountUsageIdSchema })
	.strict()

export const discountUsedInBroadcastSchema = z
	.object({
		id: z.string().min(1).max(100),
		name: z.string().max(200),
		/** Only broadcasts that can still go out: waiting, or sending now. */
		status: z.enum(['Scheduled', 'Processing']),
		/** Epoch milliseconds of the scheduled start; null while sending. */
		scheduledAt: z.number().int().nullable(),
	})
	.strict()

export const discountUsedInAutomationSchema = z
	.object({
		id: z.string().min(1).max(100),
		name: z.string().max(200),
	})
	.strict()

export const discountUsedInResponseSchema = z
	.object({
		broadcasts: z
			.array(discountUsedInBroadcastSchema)
			.max(DISCOUNT_USED_IN_MAX),
		automations: z
			.array(discountUsedInAutomationSchema)
			.max(DISCOUNT_USED_IN_MAX),
		/**
		 * Single-use codes already sent that still work (a count). They keep
		 * working until they expire, whatever happens to the discount.
		 */
		issuedCodes: z.number().int().min(0),
	})
	.strict()

export type DiscountUsedIn = z.infer<typeof discountUsedInResponseSchema>
