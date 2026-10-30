import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { type z } from 'zod'
import type availabilityPreferredTaken from '../../../../packages/reservations/contract-fixtures/availability-preferred-taken.json'
import type availability from '../../../../packages/reservations/contract-fixtures/availability.json'
import type bookingPendingPayment from '../../../../packages/reservations/contract-fixtures/booking-pending-payment.json'
import type booking from '../../../../packages/reservations/contract-fixtures/booking.json'
import type calendar from '../../../../packages/reservations/contract-fixtures/calendar.json'
import type config from '../../../../packages/reservations/contract-fixtures/config.json'
import type errorHoldExpired from '../../../../packages/reservations/contract-fixtures/error-hold-expired.json'
import type errorInvalid from '../../../../packages/reservations/contract-fixtures/error-invalid.json'
import type errorPolicyRequired from '../../../../packages/reservations/contract-fixtures/error-policy-required.json'
import type errorRateLimited from '../../../../packages/reservations/contract-fixtures/error-rate-limited.json'
import type errorSlotUnavailable from '../../../../packages/reservations/contract-fixtures/error-slot-unavailable.json'
import type holdRequiresPayment from '../../../../packages/reservations/contract-fixtures/hold-requires-payment.json'
import type hold from '../../../../packages/reservations/contract-fixtures/hold.json'
import type manage from '../../../../packages/reservations/contract-fixtures/manage.json'
import type mine from '../../../../packages/reservations/contract-fixtures/mine.json'
import type paymentStatusNone from '../../../../packages/reservations/contract-fixtures/payment-status-none.json'
import type paymentStatusPending from '../../../../packages/reservations/contract-fixtures/payment-status-pending.json'
import type request from '../../../../packages/reservations/contract-fixtures/request.json'
import type waitlistJoin from '../../../../packages/reservations/contract-fixtures/waitlist-join.json'
import type waitlistStatus from '../../../../packages/reservations/contract-fixtures/waitlist-status.json'

// The canonical contract fixtures recorded from tenant-api
// (`npm run fixtures:reservations -w tenant-api`), read in place. The same
// files back the tenant-api and `@repo/reservations` contract tests, so
// decoding them pins the app to the real server shapes.
// `@repo/reservations` fails when a recorded file has no type here.
type Fixtures = {
	availability: typeof availability
	'availability-preferred-taken': typeof availabilityPreferredTaken
	booking: typeof booking
	'booking-pending-payment': typeof bookingPendingPayment
	calendar: typeof calendar
	config: typeof config
	'error-hold-expired': typeof errorHoldExpired
	'error-invalid': typeof errorInvalid
	'error-policy-required': typeof errorPolicyRequired
	'error-rate-limited': typeof errorRateLimited
	'error-slot-unavailable': typeof errorSlotUnavailable
	hold: typeof hold
	'hold-requires-payment': typeof holdRequiresPayment
	manage: typeof manage
	mine: typeof mine
	'payment-status-none': typeof paymentStatusNone
	'payment-status-pending': typeof paymentStatusPending
	request: typeof request
	'waitlist-join': typeof waitlistJoin
	'waitlist-status': typeof waitlistStatus
}

const PACKAGE_DIR = path.resolve(__dirname, '../../../../packages/reservations')

function readFixtures(dir: string): Record<string, unknown> {
	return Object.fromEntries(
		readdirSync(dir)
			.filter((file) => file.endsWith('.json'))
			.sort()
			.map((file) => [
				file.slice(0, -'.json'.length),
				JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as unknown,
			]),
	)
}

// Every file in the folder is loaded, so a newly recorded fixture is never
// skipped; the type imports above only describe the shapes.
const FIXTURES = readFixtures(
	path.join(PACKAGE_DIR, 'contract-fixtures'),
) as Fixtures

/**
 * Hand-written answers with values a newer region may send (unknown kinds,
 * statuses and labels), kept outside the recorded folder.
 */
const FUTURE_FIXTURES = readFixtures(path.join(PACKAGE_DIR, 'future-fixtures'))

export type FixtureName = keyof typeof FIXTURES

export const FIXTURE_NAMES = Object.keys(FIXTURES) as FixtureName[]

export const FUTURE_FIXTURE_NAMES = Object.keys(FUTURE_FIXTURES)

/** A future-values fixture as a response body. */
export function futureFixtureText(name: string): string {
	if (!(name in FUTURE_FIXTURES)) throw new Error(`No future fixture ${name}`)
	return JSON.stringify(FUTURE_FIXTURES[name])
}

/** A deep copy, so a test can change it without touching other tests. */
export function fixtureJson<Name extends FixtureName>(
	name: Name,
): (typeof FIXTURES)[Name] {
	return JSON.parse(JSON.stringify(FIXTURES[name])) as (typeof FIXTURES)[Name]
}

/** The fixture as a response body. */
export function fixtureText(name: FixtureName): string {
	return JSON.stringify(FIXTURES[name])
}

/** Parses a fixture (or a changed copy) with a response schema; throws on drift. */
export function decodeFixture<Schema extends z.ZodTypeAny>(
	schema: Schema,
	value: FixtureName | object,
): z.output<Schema> {
	return schema.parse(
		typeof value === 'string' ? fixtureJson(value) : value,
	) as z.output<Schema>
}
