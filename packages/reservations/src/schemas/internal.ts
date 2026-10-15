import { z } from 'zod'
import { ianaTimeZoneStringSchema } from './common.ts'
import { paymentProviderSchema } from './payments.ts'

/**
 * Schemas for US control-plane <-> regional `tenant-api` internal endpoints
 * (`/internal/reservations/*`). Zero guest PII crosses this boundary.
 */
export const internalLocationFactSchema = z.strictObject({
	id: z.string().trim().min(1),
	slug: z.string().trim().min(1),
	name: z.string().trim().min(1),
	timeZone: ianaTimeZoneStringSchema,
	active: z.boolean(),
})

export const internalLocationFactsResponseSchema = z.strictObject({
	organizationId: z.string().trim().min(1),
	locations: z.array(internalLocationFactSchema),
})

export const internalSyncPaymentConfigSchema = z.strictObject({
	organizationId: z.string().trim().min(1),
	provider: paymentProviderSchema,
	connectedAccountId: z.string().trim().min(1),
	publishableKey: z.string().trim().min(1).optional().nullable(),
	webhookSecretRef: z.string().trim().min(1).optional().nullable(),
	platformFeeBp: z.number().int().min(0).max(10_000).default(0),
	chargesEnabled: z.boolean().default(true),
	currency: z
		.string()
		.trim()
		.regex(/^[A-Z]{3}$/)
		.default('USD'),
})

export const internalTickRequestSchema = z.strictObject({
	organizationId: z.string().trim().min(1).optional(),
	nowMs: z.number().int().positive().optional(),
})

export const internalTickResultSchema = z.strictObject({
	organizationId: z.string(),
	expiredHolds: z.number().int().min(0),
	expiredPaymentSessions: z.number().int().min(0),
	expiredWaitlistOffers: z.number().int().min(0),
	autoNoShows: z.number().int().min(0),
	messagesDispatched: z.number().int().min(0),
})
