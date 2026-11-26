import { z } from 'zod'

/**
 * Shared contracts for operator order editing (#162) and tax-exempt orders (#166).
 *
 * Tax-exempt rule (#166):
 * - Allowed for non-SAR locations only (KSA/SAR uses ZATCA exemption codes).
 * - Certificate number is required (1..40 chars) plus organization name.
 * - Delivery fee tax decision: when an order is marked tax-exempt, all order
 *   sales tax is removed — including tax on items, service fee, packaging fee,
 *   and delivery fee — so qualifying exempt buyers receive a zero-tax receipt.
 */

export const ORDER_EDITS_FLAG_KEY = 'ordering.order_edits'
export const TAX_EXEMPT_REF_MAX_LENGTH = 40
export const TAX_EXEMPT_ORG_MAX_LENGTH = 120

/** KSA/SAR locations never show or allow the tax-exempt control (#166). */
export function isTaxExemptSupportedForCurrency(currency: string): boolean {
	return currency.trim().toUpperCase() !== 'SAR'
}

export const taxExemptInputSchema = z.strictObject({
	ref: z.string().trim().min(1).max(TAX_EXEMPT_REF_MAX_LENGTH),
	org: z.string().trim().min(1).max(TAX_EXEMPT_ORG_MAX_LENGTH),
})
export type TaxExemptInput = z.infer<typeof taxExemptInputSchema>

export const reviseOrderOptionSchema = z.strictObject({
	groupId: z.string().min(1).max(100),
	optionId: z.string().min(1).max(100),
	quantity: z.number().int().min(1).max(50).default(1),
})

export const reviseOrderLineSchema = z
	.strictObject({
		itemId: z.string().min(1).max(100),
		variantId: z.string().min(1).max(100).nullable().optional(),
		quantity: z.number().int().min(1).max(50),
		instructions: z.string().trim().max(280).nullable().optional(),
		options: z.array(reviseOrderOptionSchema).max(50).default([]),
		/** Comp this line (price -> 0). Requires `compReason` and refund permission. */
		comped: z.boolean().optional(),
		compReason: z.string().trim().min(1).max(200).optional(),
	})
	.superRefine((line, ctx) => {
		if (line.comped && !line.compReason) {
			ctx.addIssue({
				code: 'custom',
				path: ['compReason'],
				message: 'A reason is required when comping an item.',
			})
		}
	})
export type ReviseOrderLineInput = z.infer<typeof reviseOrderLineSchema>

export const reviseOrderRequestSchema = z.strictObject({
	expectedRevision: z.number().int().min(1),
	reason: z.string().trim().min(1).max(300).optional(),
	/** Preview the new totals and money difference without saving. */
	dryRun: z.boolean().optional(),
	lines: z.array(reviseOrderLineSchema).min(1).max(50).optional(),
	fulfillment: z.enum(['pickup', 'delivery']).optional(),
	/** Required when switching to delivery. */
	deliveryQuoteToken: z.string().min(1).max(2000).optional(),
	deliveryUnit: z.string().trim().max(80).nullable().optional(),
	deliveryNotes: z.string().trim().max(280).nullable().optional(),
	scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
	pickupWindowId: z.string().min(1).max(100).nullable().optional(),
	pickupDate: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.nullable()
		.optional(),
	pickupTime: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
		.nullable()
		.optional(),
	/** Allows more than one scheduled/ready time change per order. */
	managerOverride: z.boolean().optional(),
	/** Mark order tax-exempt (#166), or `null` to clear exemption. */
	taxExempt: taxExemptInputSchema.nullable().optional(),
})
export type ReviseOrderRequest = z.infer<typeof reviseOrderRequestSchema>

export type ReviseOrderSuggestedAction = 'refund' | 'pay_link' | 'none'

export type OrderRevisionSummary = {
	id: string
	revision: number
	reason: string | null
	actorId: string
	actorName: string | null
	createdAt: string
	totals: {
		subtotalCents: number
		taxCents: number
		deliveryFeeCents: number
		discountCents: number
		loyaltyDiscountCents: number
		serviceFeeCents: number
		packagingFeeCents: number
		tipCents: number
		totalCents: number
	}
	changes: Record<string, unknown> | null
}
