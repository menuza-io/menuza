import { z } from 'zod'
import { reservationsFeaturesSchema } from '../flags.ts'
import { ianaTimeZoneStringSchema } from './common.ts'
import { paymentProviderSchema } from './payments.ts'
import { parseSpecialHours, parseWeeklyHours } from '../rules/location-hours.ts'

/**
 * Schemas for US control-plane <-> regional `tenant-api` internal endpoints
 * (`/internal/reservations/*` and `/resources/reservations/*`).
 * Zero guest PII crosses this boundary.
 */
export const internalLocationFactSchema = z.strictObject({
	id: z.string().trim().min(1),
	slug: z.string().trim().min(1),
	name: z.string().trim().min(1),
	timeZone: ianaTimeZoneStringSchema,
	active: z.boolean(),
})

const hexColorSchema = z
	.string()
	.regex(/^#[0-9A-Fa-f]{6}$/, 'Expected 6-digit hex color')

export const reservationsEmailThemeSchema = z.strictObject({
	organizationName: z.string(),
	logoUrl: z.string().nullable(),
	appUrl: z.string().nullable(),
	background: hexColorSchema,
	card: hexColorSchema,
	foreground: hexColorSchema,
	muted: hexColorSchema,
	mutedForeground: hexColorSchema,
	border: hexColorSchema,
	primary: hexColorSchema,
	primaryForeground: hexColorSchema,
	accent: hexColorSchema,
	accentForeground: hexColorSchema,
	radius: z.number(),
	headingFont: z.string(),
	bodyFont: z.string(),
})

export const reservationsContextAddressSchema = z.strictObject({
	formattedAddress: z.string().nullable(),
	city: z.string().nullable(),
	lat: z.number().nullable(),
	lng: z.number().nullable(),
})

export const reservationsContextLocationSchema = z.strictObject({
	id: z.string().trim().min(1),
	name: z.string().trim().min(1),
	slug: z.string().trim().min(1),
	timeZone: ianaTimeZoneStringSchema,
	currency: z.enum(['USD', 'CAD', 'SAR']),
	phone: z.string().nullable(),
	address: reservationsContextAddressSchema.nullable(),
	// Tolerant: a malformed value (or the raw JSON string) fails open to `null`
	// for this location only, never rejecting the whole context.
	storeHours: z.unknown().transform((raw) => parseWeeklyHours(raw).value),
	specialHours: z.unknown().transform((raw) => parseSpecialHours(raw).value),
	isActive: z.boolean(),
})

export const reservationsContextOrganizationSchema = z.strictObject({
	name: z.string().trim().min(1),
	slug: z.string().trim().min(1),
	defaultLocale: z.string().trim().min(1),
	locales: z.array(z.string().trim().min(1)),
	siteOrigin: z.string().nullable(),
	sitePublished: z.boolean(),
	emailTheme: reservationsEmailThemeSchema,
	logoUrl: z.string().nullable(),
})

export const reservationsContextPaymentsSchema = z.strictObject({
	processor: z.enum(['connect', 'checkout']).nullable(),
	deposit: z.boolean(),
	guarantee: z.boolean(),
	platformFeeBp: z.number().int().min(0).max(10_000).optional(),
})

export const reservationsContextSchema = z.strictObject({
	orgId: z.string().trim().min(1),
	dataRegion: z.enum(['us', 'ksa']),
	features: reservationsFeaturesSchema,
	organization: reservationsContextOrganizationSchema,
	locations: z.array(reservationsContextLocationSchema),
	payments: reservationsContextPaymentsSchema,
	staffing: z.strictObject({
		enabled: z.boolean(),
	}),
	voice: z.strictObject({
		enabled: z.boolean(),
	}),
})

export type ReservationsContext = z.infer<typeof reservationsContextSchema>

export const internalContextChangedSchema = z.strictObject({
	orgId: z.string().trim().min(1),
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
