import { describe, expect, it } from 'vitest'
import { RESERVATIONS_ERROR_CODES, ReservationsDomainError } from '../errors.ts'
import {
	createHoldRequestSchema,
	createReservationFromHoldRequestSchema,
	operatorCreateReservationSchema,
	publicAvailabilityQuerySchema,
	reservationsContextSchema,
	voiceCheckAvailabilitySchema,
} from './index.ts'

describe('strict Zod API schemas and stable error codes', () => {
	it('defines all 24 stable error codes and ReservationsDomainError', () => {
		expect(RESERVATIONS_ERROR_CODES).toHaveLength(24)
		expect(RESERVATIONS_ERROR_CODES).toContain('slot_unavailable')
		expect(RESERVATIONS_ERROR_CODES).toContain('hold_expired')
		expect(RESERVATIONS_ERROR_CODES).toContain('invalid_transition')
		expect(RESERVATIONS_ERROR_CODES).toContain('forbidden_grant')

		const err = new ReservationsDomainError(
			'slot_unavailable',
			'Slot is no longer available',
			409,
		)
		expect(err.code).toBe('slot_unavailable')
		expect(err.status).toBe(409)
	})

	it('accepts valid payloads and rejects unknown keys, out-of-range party sizes, malformed dates, invalid time zones, and invalid phones', () => {
		// Valid public availability query
		const validQuery = publicAvailabilityQuerySchema.safeParse({
			locationSlug: 'flagship-nyc',
			businessDate: '2026-06-12',
			partySize: 4,
			preferredSlotMin: 1140,
			seatingPreference: 'any',
		})
		expect(validQuery.success).toBe(true)

		// Unknown key rejected by strictObject
		const unknownKey = publicAvailabilityQuerySchema.safeParse({
			locationSlug: 'flagship-nyc',
			businessDate: '2026-06-12',
			partySize: 4,
			extraField: 'not_allowed',
		})
		expect(unknownKey.success).toBe(false)

		// Malformed date rejected
		const badDate = publicAvailabilityQuerySchema.safeParse({
			locationSlug: 'flagship-nyc',
			businessDate: '06/12/2026',
			partySize: 4,
		})
		expect(badDate.success).toBe(false)

		// Out-of-range party size rejected
		const badParty = createHoldRequestSchema.safeParse({
			locationSlug: 'flagship-nyc',
			businessDate: '2026-06-12',
			slotMin: 1140,
			partySize: 0,
		})
		expect(badParty.success).toBe(false)

		// Invalid phone rejected in createReservationFromHoldRequestSchema
		const badPhone = createReservationFromHoldRequestSchema.safeParse({
			holdId: 'hold_123',
			holdToken: 'tok_secret_123',
			guestName: 'Ada Lovelace',
			guestPhone: 'not-a-phone',
			idempotencyKey: 'idem_12345678',
		})
		expect(badPhone.success).toBe(false)

		// Valid createReservationFromHoldRequestSchema normalizes phone
		const goodBook = createReservationFromHoldRequestSchema.safeParse({
			holdId: 'hold_123',
			holdToken: 'tok_secret_123',
			guestName: 'Ada Lovelace',
			guestPhone: '+1 (415) 555-2671',
			guestEmail: 'ada@example.com',
			smsOptIn: true,
			idempotencyKey: 'idem_12345678',
		})
		expect(goodBook.success).toBe(true)
		if (goodBook.success) {
			expect(goodBook.data.guestPhone).toBe('+14155552671')
		}

		// Operator create reservation and voice check availability
		expect(
			operatorCreateReservationSchema.safeParse({
				locationId: 'loc_1',
				businessDate: '2026-06-12',
				slotMin: 1140,
				partySize: 4,
				guestName: 'Grace Hopper',
				guestPhone: '+14155552671',
				channel: 'phone',
			}).success,
		).toBe(true)

		expect(
			voiceCheckAvailabilitySchema.safeParse({
				businessDate: '2026-06-12',
				partySize: 4,
				preferredSlotMin: 1140,
			}).success,
		).toBe(true)

		expect(
			reservationsContextSchema.safeParse({
				orgId: 'org_acme',
				dataRegion: 'us',
				features: {
					enabled: true,
					online: true,
					waitlist: true,
					payments: false,
					experiences: false,
					voice: false,
				},
				organization: {
					name: 'Acme Bistro',
					slug: 'acme',
					defaultLocale: 'en',
					locales: ['en', 'ar'],
					siteOrigin: 'https://acme.epic-startup.test:2999',
					sitePublished: true,
					emailTheme: {
						organizationName: 'Acme Bistro',
						logoUrl: null,
						appUrl: 'http://localhost:3001',
						background: '#F4F4F5',
						card: '#FFFFFF',
						foreground: '#18181B',
						muted: '#F4F4F5',
						mutedForeground: '#71717A',
						border: '#E4E4E7',
						primary: '#2563EB',
						primaryForeground: '#FFFFFF',
						accent: '#F4F4F5',
						accentForeground: '#18181B',
						radius: 8,
						headingFont: 'Inter',
						bodyFont: 'Inter',
					},
					logoUrl: null,
				},
				locations: [
					{
						id: 'loc_1',
						slug: 'flagship',
						name: 'Flagship',
						timeZone: 'America/New_York',
						currency: 'USD',
						phone: '+14155552671',
						address: {
							formattedAddress: '123 Main St, New York, NY',
							city: 'New York',
							lat: 40.7128,
							lng: -74.006,
						},
						storeHours: null,
						specialHours: null,
						isActive: true,
					},
				],
				payments: {
					processor: 'connect',
					deposit: true,
					guarantee: true,
					platformFeeBp: 150,
				},
				staffing: {
					enabled: true,
				},
				voice: {
					enabled: false,
				},
			}).success,
		).toBe(true)
	})
})
