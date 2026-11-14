import { z } from 'zod'

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const orderSummarySchema = z.object({
	id: z.string().min(1),
	number: z.string().min(1),
	status: z.string().min(1),
	paymentStatus: z.string().min(1),
	currency: z.string().length(3),
	subtotalCents: cents,
	taxCents: cents,
	deliveryFeeCents: cents,
	tipCents: cents,
	totalCents: cents,
	holdExpiresAt: z.string().datetime().nullable(),
	/** When the order should be ready / start arriving; absent on older nodes. */
	promisedAt: z.string().datetime().nullable().optional(),
	/** End of an ASAP delivery range; absent or null otherwise. */
	promisedUntil: z.string().datetime().nullable().optional(),
})
export const createdOrderSchema = z.object({
	order: orderSummarySchema,
	receiptToken: z.string().min(16),
	paymentToken: z.string().min(16).optional(),
})
export const orderCapabilitySchema = z.object({
	receiptToken: z.string().min(16),
	paymentToken: z.string().min(16).optional(),
})
export const orderPaymentRequestSchema = z
	.object({
		slug: z.string().min(1).max(150).optional(),
		host: z.string().min(1).max(253).optional(),
		orderId: z.string().min(1).max(150),
		paymentToken: z.string().min(16).max(500),
		locale: z.string().min(2).max(20).optional(),
	})
	.strict()
	.refine((value) => Boolean(value.slug || value.host))

export type CreatedOrder = z.infer<typeof createdOrderSchema>
export type OrderCapability = z.infer<typeof orderCapabilitySchema>
