import { isValidTimeZone } from '@repo/zoned-time'
import { z } from 'zod'
import {
	LARGE_PARTY_MODES,
	POLICY_MODES,
	SEATING_PREFERENCES,
	SEATING_PREFERENCE_MODES,
	SERVICE_TABLE_MODES,
	SPECIAL_DAY_TYPES,
} from '../config.ts'
import { BOOKING_CHANNELS } from '../engine/day-state.ts'
import { isValidNormalizedPhone, normalizeGuestPhone } from '../phone.ts'
import { RESERVATION_ACTORS, RESERVATION_STATUSES } from '../state-machine.ts'

export const isoTimestampSchema = z.string().datetime({
	offset: true,
	message: 'Expected ISO-8601 timestamp string',
})

export const deadlineResponseFields = {
	expiresAt: isoTimestampSchema,
	now: isoTimestampSchema,
} as const

export const businessDateStringSchema = z
	.string()
	.regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
		message: 'Expected YYYY-MM-DD calendar date',
	})

export const ianaTimeZoneStringSchema = z
	.string()
	.trim()
	.min(1)
	.refine((tz) => isValidTimeZone(tz), {
		message: 'Invalid IANA time zone identifier',
	})

export const normalizedPhoneSchema = z
	.string()
	.trim()
	.min(7)
	.max(24)
	.transform((val) => normalizeGuestPhone(val))
	.refine((val) => isValidNormalizedPhone(val), {
		message: 'Invalid E.164 phone number',
	})

export const partySizeSchema = z.number().int().min(1).max(99)

export const slotMinSchema = z.number().int().min(0).max(2880)

export const bookingChannelSchema = z.enum(BOOKING_CHANNELS)

export const seatingPreferenceSchema = z.enum(SEATING_PREFERENCES)
export const seatingPreferenceModeSchema = z.enum(SEATING_PREFERENCE_MODES)
export const largePartyModeSchema = z.enum(LARGE_PARTY_MODES)
export const policyModeSchema = z.enum(POLICY_MODES)
export const serviceTableModeSchema = z.enum(SERVICE_TABLE_MODES)
export const specialDayTypeSchema = z.enum(SPECIAL_DAY_TYPES)
export const reservationStatusSchema = z.enum(RESERVATION_STATUSES)
export const reservationActorSchema = z.enum(RESERVATION_ACTORS)

export const attributeTagSchema = z.enum([
	'accessible',
	'high_top',
	'window',
	'booth',
	'patio',
	'bar',
])

export const guestOccasionSchema = z.enum([
	'birthday',
	'anniversary',
	'date_night',
	'business',
	'celebration',
	'other',
])
