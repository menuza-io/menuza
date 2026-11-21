import { z } from 'zod'

/**
 * Shared constants, error codes, consent text, and Zod schemas for Guest Dish
 * Photos (#148) across customer upload routes (`apps/tenant-api`), operator
 * moderation routes (`apps/tenant-api` + `apps/app`), and guest surfaces.
 */

export const GUEST_PHOTO_ELIGIBILITY_DAYS = 14
export const GUEST_PHOTO_MAX_PER_DISH_ORDER = 3
export const GUEST_PHOTO_MAX_PER_GUEST_DAY = 10
export const GUEST_PHOTO_MAX_BYTES = 10 * 1024 * 1024
export const GUEST_PHOTO_REJECTED_RETENTION_DAYS = 30
export const GUEST_PHOTO_STAGED_RETENTION_HOURS = 24
export const GUEST_PHOTO_TOKEN_AUDIENCE = 'tenant-api-guest-photos'

export const GUEST_PHOTO_ALLOWED_MIME_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/heic',
	'image/heif',
] as const
export type GuestPhotoMimeType = (typeof GUEST_PHOTO_ALLOWED_MIME_TYPES)[number]

export const GUEST_PHOTO_STATUSES = [
	'pending',
	'approved',
	'rejected',
	'added',
] as const
export type GuestPhotoStatus = (typeof GUEST_PHOTO_STATUSES)[number]

export const GUEST_PHOTO_ERROR_CODES = [
	'not_eligible',
	'already_decided',
	'not_approved',
	'dish_photos_full',
] as const
export type GuestPhotoErrorCode = (typeof GUEST_PHOTO_ERROR_CODES)[number]

export const GUEST_PHOTO_CONSENT_VERSION = '2026-11-v1'
export const GUEST_PHOTO_CONSENT_TEXT =
	'I confirm I took this photo and grant the restaurant permission to display it on its menu, website, and ordering channels.'

export const guestPhotoMimeTypeSchema = z.enum(GUEST_PHOTO_ALLOWED_MIME_TYPES)
export const guestPhotoStatusSchema = z.enum(GUEST_PHOTO_STATUSES)
export const guestPhotoErrorCodeSchema = z.enum(GUEST_PHOTO_ERROR_CODES)

const idSchema = z.string().trim().min(1).max(128)

// ---------------------------------------------------------------------------
// Customer routes (tenant-api)
// ---------------------------------------------------------------------------

export const guestPhotoEligibilityQuerySchema = z
	.object({
		orderId: idSchema,
		itemId: idSchema.optional(),
	})
	.strict()
export type GuestPhotoEligibilityQuery = z.infer<
	typeof guestPhotoEligibilityQuerySchema
>

export const guestPhotoUploadRequestSchema = z
	.object({
		orderId: idSchema,
		itemId: idSchema,
		contentType: guestPhotoMimeTypeSchema,
		byteSize: z.number().int().min(1).max(GUEST_PHOTO_MAX_BYTES),
	})
	.strict()
export type GuestPhotoUploadRequest = z.infer<
	typeof guestPhotoUploadRequestSchema
>

export const guestPhotoSubmitSchema = z
	.object({
		orderId: idSchema,
		itemId: idSchema,
		objectKey: z.string().trim().min(1).max(512),
		contentType: guestPhotoMimeTypeSchema,
		byteSize: z.number().int().min(1).max(GUEST_PHOTO_MAX_BYTES),
		consent: z.literal(true),
	})
	.strict()
export type GuestPhotoSubmitInput = z.infer<typeof guestPhotoSubmitSchema>

// ---------------------------------------------------------------------------
// Operator routes (tenant-api & app)
// ---------------------------------------------------------------------------

export const guestPhotoListQuerySchema = z
	.object({
		status: guestPhotoStatusSchema.optional(),
		itemId: idSchema.optional(),
		limit: z.coerce.number().int().min(1).max(100).default(50),
		cursor: z.string().trim().min(1).max(256).optional(),
	})
	.strict()
export type GuestPhotoListQuery = z.infer<typeof guestPhotoListQuerySchema>

export const guestPhotoDecisionSchema = z
	.object({
		decision: z.enum(['approve', 'reject']),
	})
	.strict()
export type GuestPhotoDecisionInput = z.infer<typeof guestPhotoDecisionSchema>

export const guestPhotoMarkAddedSchema = z
	.object({
		mediaAssetId: idSchema.optional(),
	})
	.strict()
export type GuestPhotoMarkAddedInput = z.infer<typeof guestPhotoMarkAddedSchema>

export const guestPhotoSubmissionSchema = z
	.object({
		id: idSchema,
		orgId: idSchema,
		orderId: idSchema,
		itemId: idSchema,
		objectKey: z.string().trim().min(1).max(512),
		contentType: z.string().trim().min(1).max(128),
		byteSize: z.number().int().min(1),
		status: guestPhotoStatusSchema,
		consentText: z.string(),
		consentVersion: z.string().nullable().optional(),
		consentedAt: z.string(),
		decidedAt: z.string().nullable(),
		decidedByUserId: z.string().nullable(),
		addedAt: z.string().nullable(),
		createdAt: z.string(),
	})
	.strict()
export type GuestPhotoSubmission = z.infer<typeof guestPhotoSubmissionSchema>
