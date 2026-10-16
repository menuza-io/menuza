import { z } from 'zod'
import { isoTimestampSchema, policyModeSchema } from './common.ts'

export const PAYMENT_PROVIDERS = ['stripe', 'checkout'] as const
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number]
export const paymentProviderSchema = z.enum(PAYMENT_PROVIDERS)

export const PAYMENT_INTENT_STATUSES = [
	'pending',
	'Authorized',
	'card_saved',
	'succeeded',
	'partially_refunded',
	'refunded',
	'failed',
	'cancelled',
	'disputed',
] as const

export const createPaymentSessionRequestSchema = z.strictObject({
	reservationId: z.string().trim().min(1),
	returnUrl: z.string().url().max(1024),
	cancelUrl: z.string().url().max(1024).optional(),
})

export const operatorChargeNoShowRequestSchema = z.strictObject({
	reservationId: z.string().trim().min(1),
	amountMinor: z.number().int().min(1).max(10_000_000).optional(),
	reason: z.string().trim().max(500).optional().nullable(),
	idempotencyKey: z.string().trim().min(8).max(128),
})

export const operatorRefundPaymentRequestSchema = z.strictObject({
	reservationId: z.string().trim().min(1),
	amountMinor: z.number().int().min(1).max(10_000_000).optional(),
	reason: z.string().trim().max(500).optional().nullable(),
	overrideCutoff: z.boolean().default(false),
	idempotencyKey: z.string().trim().min(8).max(128),
})

export const operatorWaivePolicyRequestSchema = z.strictObject({
	reservationId: z.string().trim().min(1),
	reason: z.string().trim().min(1).max(500),
})

export const paymentConfigPublicSummarySchema = z.strictObject({
	provider: paymentProviderSchema.nullable(),
	mode: policyModeSchema,
	amountMinor: z.number().int().min(0),
	currency: z.string().regex(/^[A-Z]{3}$/),
})

export const paymentSessionResponseSchema = z.strictObject({
	reservationId: z.string().trim().min(1),
	provider: paymentProviderSchema.optional(),
	processor: z.enum(['stripe', 'checkout', 'connect', 'direct']).optional(),
	mode: policyModeSchema.optional(),
	kind: policyModeSchema.optional(),
	amountMinor: z.number().int().min(0),
	currency: z.string().regex(/^[A-Z]{3}$/),
	checkoutUrl: z.string().url().max(2048),
	expiresAt: isoTimestampSchema,
	now: isoTimestampSchema,
})
