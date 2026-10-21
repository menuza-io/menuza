import { createHash } from 'node:crypto'
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
 * fails when the iOS or Android copy differs from the canonical file by a
 * single byte (or has an extra or missing file).
 */

const ROOT = path.resolve(import.meta.dirname, '../../..')
const CANONICAL = path.join(ROOT, 'packages/reservations/contract-fixtures')
const COPIES = [
	path.join(ROOT, 'apps/ios/Tests/TenantKitTests/Fixtures/Reservations'),
	path.join(ROOT, 'apps/android/app/src/test/resources/reservations'),
]

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
const digest = (file: string) =>
	createHash('sha256').update(fs.readFileSync(file)).digest('hex')

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

	it.each(COPIES)(
		'keeps %s byte-identical to the canonical fixtures',
		(dir) => {
			expect(files(dir)).toEqual(files(CANONICAL))
			for (const file of files(CANONICAL)) {
				expect(digest(path.join(dir, file)), file).toBe(
					digest(path.join(CANONICAL, file)),
				)
			}
		},
	)

	it('holds only seeded demo data (no real-looking guest details)', () => {
		for (const file of files(CANONICAL)) {
			const text = fs.readFileSync(path.join(CANONICAL, file), 'utf8')
			expect(text, file).not.toMatch(/@(?!example\.com)[a-z0-9-]+\.[a-z]{2,}/i)
		}
	})
})
