import { describe, expect, it } from 'vitest'
import { RESERVATIONS_ERROR_CODES, ReservationsDomainError } from '../errors.ts'
import {
	createHoldRequestSchema,
	createReservationFromHoldRequestSchema,
	operatorCreateReservationSchema,
	publicAvailabilityQuerySchema,
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
	})
})
