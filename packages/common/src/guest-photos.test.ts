import { describe, expect, it } from 'vitest'
import {
	GUEST_PHOTO_ALLOWED_MIME_TYPES,
	GUEST_PHOTO_CONSENT_TEXT,
	GUEST_PHOTO_CONSENT_VERSION,
	GUEST_PHOTO_ELIGIBILITY_DAYS,
	GUEST_PHOTO_ERROR_CODES,
	GUEST_PHOTO_MAX_BYTES,
	GUEST_PHOTO_MAX_PER_DISH_ORDER,
	GUEST_PHOTO_MAX_PER_GUEST_DAY,
	GUEST_PHOTO_STAGED_RETENTION_HOURS,
	GUEST_PHOTO_TOKEN_AUDIENCE,
	guestPhotoDecisionSchema,
	guestPhotoEligibilityQuerySchema,
	guestPhotoListQuerySchema,
	guestPhotoMarkAddedSchema,
	guestPhotoSubmissionSchema,
	guestPhotoSubmitSchema,
	guestPhotoUploadRequestSchema,
} from './guest-photos.ts'

describe('guest-photos', () => {
	it('exports required limits, mime types, error codes, and consent text', () => {
		expect(GUEST_PHOTO_ELIGIBILITY_DAYS).toBe(14)
		expect(GUEST_PHOTO_MAX_PER_DISH_ORDER).toBe(3)
		expect(GUEST_PHOTO_MAX_PER_GUEST_DAY).toBe(10)
		expect(GUEST_PHOTO_MAX_BYTES).toBe(10 * 1024 * 1024)
		expect(GUEST_PHOTO_STAGED_RETENTION_HOURS).toBe(24)
		expect(GUEST_PHOTO_TOKEN_AUDIENCE).toBe('tenant-api-guest-photos')
		expect(GUEST_PHOTO_CONSENT_VERSION).toBe('2026-11-v1')
		expect(GUEST_PHOTO_ALLOWED_MIME_TYPES).toEqual([
			'image/jpeg',
			'image/png',
			'image/webp',
			'image/heic',
			'image/heif',
		])
		expect(GUEST_PHOTO_ERROR_CODES).toEqual([
			'not_eligible',
			'already_decided',
			'not_approved',
			'dish_photos_full',
		])
		expect(GUEST_PHOTO_CONSENT_TEXT.length).toBeGreaterThan(20)
	})

	it('validates customer eligibility, upload, and submit schemas', () => {
		expect(
			guestPhotoEligibilityQuerySchema.parse({
				orderId: 'ord-1',
				itemId: 'item-1',
			}),
		).toEqual({ orderId: 'ord-1', itemId: 'item-1' })

		expect(
			guestPhotoUploadRequestSchema.parse({
				orderId: 'ord-1',
				itemId: 'item-1',
				contentType: 'image/heic',
				byteSize: 1024,
			}),
		).toBeDefined()

		expect(
			guestPhotoUploadRequestSchema.safeParse({
				orderId: 'ord-1',
				itemId: 'item-1',
				contentType: 'image/gif',
				byteSize: 1024,
			}).success,
		).toBe(false)

		expect(
			guestPhotoUploadRequestSchema.safeParse({
				orderId: 'ord-1',
				itemId: 'item-1',
				contentType: 'image/jpeg',
				byteSize: GUEST_PHOTO_MAX_BYTES + 1,
			}).success,
		).toBe(false)

		expect(
			guestPhotoSubmitSchema.safeParse({
				orderId: 'ord-1',
				itemId: 'item-1',
				objectKey: 'guest-photos/org-1/abc.jpg',
				contentType: 'image/jpeg',
				byteSize: 5000,
				consent: false,
			}).success,
		).toBe(false)

		expect(
			guestPhotoSubmitSchema.parse({
				orderId: 'ord-1',
				itemId: 'item-1',
				objectKey: 'guest-photos/org-1/abc.jpg',
				contentType: 'image/webp',
				byteSize: 5000,
				consent: true,
			}).consent,
		).toBe(true)

		expect(
			guestPhotoSubmitSchema.safeParse({
				orderId: 'ord-1',
				itemId: 'item-1',
				objectKey: 'guest-photos/org-1/abc.jpg',
				contentType: 'image/webp',
				byteSize: 5000,
				consent: true,
				consentText: 'custom client consent',
			}).success,
		).toBe(false)

		expect(
			guestPhotoSubmissionSchema.parse({
				id: 'sub-1',
				orgId: 'org-1',
				orderId: 'ord-1',
				itemId: 'item-1',
				objectKey: 'guest-photos/org-1/abc.jpg',
				contentType: 'image/webp',
				byteSize: 5000,
				status: 'pending',
				consentText: GUEST_PHOTO_CONSENT_TEXT,
				consentVersion: GUEST_PHOTO_CONSENT_VERSION,
				consentedAt: '2026-11-20T00:00:00.000Z',
				decidedAt: null,
				decidedByUserId: null,
				addedAt: null,
				createdAt: '2026-11-20T00:00:00.000Z',
			}).consentVersion,
		).toBe(GUEST_PHOTO_CONSENT_VERSION)
	})

	it('validates operator list, decision, and mark-added schemas', () => {
		expect(guestPhotoListQuerySchema.parse({})).toEqual({ limit: 50 })
		expect(
			guestPhotoListQuerySchema.parse({ status: 'pending', limit: '20' }),
		).toEqual({ status: 'pending', limit: 20 })

		expect(guestPhotoDecisionSchema.parse({ decision: 'approve' })).toEqual({
			decision: 'approve',
		})
		expect(
			guestPhotoDecisionSchema.safeParse({ decision: 'delete' }).success,
		).toBe(false)

		expect(guestPhotoMarkAddedSchema.parse({})).toEqual({})
	})
})
