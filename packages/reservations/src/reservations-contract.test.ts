import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	publicAvailabilityResponseSchema,
	publicBookingResponseSchema,
	publicCalendarResponseSchema,
	publicConfigResponseSchema,
	publicErrorResponseSchema,
	publicHoldResponseSchema,
	publicJoinWaitlistResponseSchema,
	publicManageViewSchema,
	publicMineResponseSchema,
	publicPaymentStatusResponseSchema,
	publicWaitlistStatusResponseSchema,
} from './schemas/index.ts'

/**
 * The canonical public-API fixtures are recorded by
 * `npm run fixtures:reservations -w tenant-api`. This package-level test needs
 * no database: it parses every fixture with the shared response schemas and
 * fails when the customer app's tests stop reading one of the canonical files
 * (they import them from this folder; there are no copies to drift).
 */

const ROOT = path.resolve(import.meta.dirname, '../../..')
const CANONICAL = path.join(ROOT, 'packages/reservations/contract-fixtures')
/**
 * Hand-written answers carrying values a newer region may send. Kept outside
 * the recorded folder, which the recorder deletes and rewrites.
 */
const FUTURE = path.join(ROOT, 'packages/reservations/future-fixtures')
const CUSTOMER_APP_FIXTURES = path.join(
	ROOT,
	'apps/customer/test/reservations/fixtures.ts',
)

const SCHEMAS: Record<
	string,
	{ safeParse(value: unknown): { success: boolean } }
> = {
	config: publicConfigResponseSchema,
	availability: publicAvailabilityResponseSchema,
	'availability-preferred-taken': publicAvailabilityResponseSchema,
	calendar: publicCalendarResponseSchema,
	hold: publicHoldResponseSchema,
	'hold-requires-payment': publicHoldResponseSchema,
	booking: publicBookingResponseSchema,
	'booking-pending-payment': publicBookingResponseSchema,
	request: publicBookingResponseSchema,
	manage: publicManageViewSchema,
	mine: publicMineResponseSchema,
	'payment-status-none': publicPaymentStatusResponseSchema,
	'payment-status-pending': publicPaymentStatusResponseSchema,
	'waitlist-join': publicJoinWaitlistResponseSchema,
	'waitlist-status': publicWaitlistStatusResponseSchema,
	'error-hold-expired': publicErrorResponseSchema,
	'error-invalid': publicErrorResponseSchema,
	'error-policy-required': publicErrorResponseSchema,
	'error-rate-limited': publicErrorResponseSchema,
	'error-slot-unavailable': publicErrorResponseSchema,
}

const files = (dir: string) =>
	fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.json'))
		.sort()

describe('reservations contract fixtures', () => {
	it('has a schema for every canonical fixture and a fixture for every schema', () => {
		expect(files(CANONICAL)).toEqual(
			Object.keys(SCHEMAS)
				.map((name) => `${name}.json`)
				.sort(),
		)
	})

	it.each(Object.keys(SCHEMAS))('parses %s with the public schema', (name) => {
		const fixture = JSON.parse(
			fs.readFileSync(path.join(CANONICAL, `${name}.json`), 'utf8'),
		)
		expect(SCHEMAS[name]!.safeParse(fixture).success).toBe(true)
	})

	it('keeps the payment status poll to exactly three fields', () => {
		const fixture = JSON.parse(
			fs.readFileSync(
				path.join(CANONICAL, 'payment-status-pending.json'),
				'utf8',
			),
		)
		expect(Object.keys(fixture).sort()).toEqual([
			'now',
			'paymentStatus',
			'reservationStatus',
		])
	})

	it('is read file by file by the customer app tests', () => {
		const source = fs.readFileSync(CUSTOMER_APP_FIXTURES, 'utf8')
		const imported = [
			...source.matchAll(
				/from '(?:\.\.\/)+packages\/reservations\/contract-fixtures\/([^']+\.json)'/g,
			),
		]
			.map((match) => match[1])
			.sort()
		expect(imported).toEqual(files(CANONICAL))
	})

	it('holds only seeded demo data (no real-looking guest details)', () => {
		for (const file of files(CANONICAL)) {
			const text = fs.readFileSync(path.join(CANONICAL, file), 'utf8')
			expect(text, file).not.toMatch(/@(?!example\.com)[a-z0-9-]+\.[a-z]{2,}/i)
		}
	})
})

const FUTURE_SCHEMAS: Record<
	string,
	{ safeParse(value: unknown): { success: boolean } }
> = {
	'availability-closed': publicAvailabilityResponseSchema,
	'availability-new-status': publicAvailabilityResponseSchema,
	calendar: publicCalendarResponseSchema,
}

const readJson = (dir: string, name: string): any =>
	JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'))

describe('reservations future values', () => {
	it('has a schema for every future fixture', () => {
		expect(files(FUTURE)).toEqual(
			Object.keys(FUTURE_SCHEMAS)
				.map((name) => `${name}.json`)
				.sort(),
		)
	})

	it('lives outside the folder the recorder rewrites', () => {
		expect(path.relative(CANONICAL, FUTURE).startsWith('..')).toBe(true)
	})

	it.each(Object.keys(FUTURE_SCHEMAS))('parses %s', (name) => {
		expect(
			FUTURE_SCHEMAS[name]!.safeParse(readJson(FUTURE, name)).success,
		).toBe(true)
	})

	it('marks a new closed source and a new day status as unknown', () => {
		const closed = publicAvailabilityResponseSchema.parse(
			readJson(FUTURE, 'availability-closed'),
		)
		expect(closed.status).toBe('closed')
		expect(closed.closed).toEqual({
			reason: null,
			note: null,
			name: 'Founders day',
			source: 'unknown',
		})
		const paused = publicAvailabilityResponseSchema.parse(
			readJson(FUTURE, 'availability-new-status'),
		)
		expect(paused.status).toBe('unknown')
		expect(paused.slots).toEqual([])
	})

	it('keeps every calendar day and marks the new values', () => {
		const calendar = publicCalendarResponseSchema.parse(
			readJson(FUTURE, 'calendar'),
		)
		expect(
			calendar.days.map((day) => [day.status, day.closedSource ?? null]),
		).toEqual([
			['available', null],
			['unknown', null],
			['closed', 'unknown'],
			['closed', 'location_hours'],
		])
	})

	it('still refuses a retyped field', () => {
		const availability = readJson(CANONICAL, 'availability')
		availability.status = 3
		expect(
			publicAvailabilityResponseSchema.safeParse(availability).success,
		).toBe(false)
		const calendar = readJson(CANONICAL, 'calendar')
		calendar.days[0].closedSource = false
		expect(publicCalendarResponseSchema.safeParse(calendar).success).toBe(false)
	})
})

describe('reservations currency codes', () => {
	const BAD = ['usd', 'US', 'USD$', '']

	it('refuses a policy currency that is not an ISO code', () => {
		for (const currency of BAD) {
			const hold = readJson(CANONICAL, 'hold-requires-payment')
			hold.policy.currency = currency
			expect(publicHoldResponseSchema.safeParse(hold).success, currency).toBe(
				false,
			)
		}
	})

	it('refuses a payment currency that is not an ISO code', () => {
		for (const currency of BAD) {
			const booking = readJson(CANONICAL, 'booking-pending-payment')
			booking.payment.currency = currency
			expect(
				publicBookingResponseSchema.safeParse(booking).success,
				currency,
			).toBe(false)
		}
	})

	it('refuses a manage policy currency that is not an ISO code', () => {
		for (const currency of BAD) {
			const view = readJson(CANONICAL, 'manage')
			view.policy = {
				kind: 'deposit',
				terms: null,
				freeCancelUntilMin: 1440,
				currency,
			}
			expect(publicManageViewSchema.safeParse(view).success, currency).toBe(
				false,
			)
			view.policy.currency = 'SAR'
			expect(publicManageViewSchema.safeParse(view).success).toBe(true)
		}
	})
})
