import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	marketingJourneys,
	rsvGuests,
	rsvJourneyEmissions,
	rsvReservations,
	type ReservationJourneyTriggerType,
	RESERVATION_JOURNEY_TRIGGER_TYPES,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import {
	hashHoldToken,
	newHoldToken,
	resetPublicRateLimits,
} from '../lib/reservations-public-auth.ts'
import { clearReservationDayCacheForTest } from '../lib/reservations-write.ts'
import { createHold } from '../services/rsv-hold-service.ts'
import {
	bookFromHold,
	guestCancelReservation,
} from '../services/rsv-public-booking-service.ts'
import {
	confirmCustomerSubscription,
	emailConsentHash,
} from '../services/marketing-audience.ts'
import { transitionReservationStatus } from '../services/rsv-booking-service.ts'
import {
	emitReservationJourney,
	RESERVATION_JOURNEY_CONTEXT_KEYS,
} from './reservations-journeys.ts'

const ORG = 'org_journeys_us'
const DAY = dateAhead(10)

let tempDir: string
const fetchMock = vi.fn()

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-journeys-test-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-token-123456789'
	process.env.JWT_SECRET = 'test-public-customer-jwt-secret-123456'
	process.env.AUTH_HMAC_SECRET = 'test-public-auth-hmac-secret-0123456789'
	resetReservationsContextCache()
	clearReservationDayCacheForTest()
	resetPublicRateLimits()
	fetchMock.mockReset()
	fetchMock.mockImplementation(
		async () =>
			new Response(JSON.stringify({ instanceId: 'wf_1' }), { status: 200 }),
	)
	vi.stubGlobal('fetch', fetchMock)
	await seedPublicOrg(ORG, { seedContext: false })
	seedReservationsContextForTest(ORG, publicContext(ORG))
})

afterEach(async () => {
	vi.unstubAllGlobals()
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

async function activeJourney(trigger: ReservationJourneyTriggerType) {
	const db = await getTenantDb(ORG)
	const [journey] = await db
		.insert(marketingJourneys)
		.values({
			name: `Journey ${trigger}`,
			triggerType: trigger,
			status: 'active',
		})
		.returning()
	return journey!
}

let bookingCounter = 0
async function book(
	options: {
		localMin?: number
		phone?: string
		email?: string | null
		marketing?: boolean
		/**
		 * The guest already confirmed this address by email on an earlier visit
		 * (double opt-in), so ticking the box again keeps it confirmed.
		 */
		confirmed?: boolean
		customerId?: string | null
		customerPhone?: string | null
		firstName?: string
	} = {},
) {
	bookingCounter += 1
	const phone = options.phone ?? `+1415555${String(2000 + bookingCounter)}`
	if (options.confirmed && options.marketing && options.email) {
		const db = await getTenantDb(ORG)
		const [returning] = await db
			.insert(customers)
			.values({
				name: 'Returning Guest',
				phone,
				email: options.email,
				phoneVerified: false,
			})
			.returning()
		await db.insert(customerSubscriptions).values({
			customerId: returning!.id,
			topic: 'reservations',
			channel: 'email',
			source: 'reservation_booking',
			subscribedAt: new Date(),
			confirmedEmailHash: emailConsentHash(options.email),
		})
	}
	const token = newHoldToken()
	await createHold({
		orgId: ORG,
		locationId: PUBLIC_LOC,
		slot: {
			date: DAY,
			localMin: options.localMin ?? 17 * 60,
			partySize: 2,
		},
		tokenHash: hashHoldToken(token),
		source: 'web',
		ipHash: 'ip',
	})
	const { reservationId } = await bookFromHold({
		orgId: ORG,
		holdTokenHash: hashHoldToken(token),
		input: {
			guest: {
				firstName: options.firstName ?? 'Quentin',
				lastName: 'Secretname',
				phone,
				email:
					options.email === undefined
						? `quentin${bookingCounter}@example.com`
						: options.email,
				locale: 'en',
			},
			smsOptIn: false,
			marketing: options.marketing ?? false,
		},
		client: 'web',
		channel: 'online',
		customerId: options.customerId ?? null,
		customerPhone: options.customerPhone ?? null,
		ipHash: 'ip',
		idempotencyKey: `key-${bookingCounter}`,
		requestHash: `hash-${bookingCounter}`,
		context: publicContext(ORG),
	})
	return { reservationId, phone }
}

async function verifiedCustomer(phone: string) {
	const db = await getTenantDb(ORG)
	const [customer] = await db
		.insert(customers)
		.values({ name: 'Vera Verified', phone, phoneVerified: true })
		.returning()
	return customer!
}

const runsFor = async (journeyId: string) =>
	(await getTenantDb(ORG))
		.select()
		.from(journeyRuns)
		.where(eq(journeyRuns.journeyId, journeyId))
		.all()
const emissions = async () =>
	(await getTenantDb(ORG)).select().from(rsvJourneyEmissions).all()

describe('reservation_booked', () => {
	it('fires once after commit for a verified guest, and once more for each later booking (VAL-JRNY-003)', async () => {
		const journey = await activeJourney('reservation_booked')
		const phone = '+14155550177'
		const customer = await verifiedCustomer(phone)
		const first = await book({
			phone,
			customerId: customer.id,
			customerPhone: phone,
			localMin: 17 * 60,
		})
		let runs = await runsFor(journey.id)
		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({
			customerId: customer.id,
			triggerEvent: 'reservation_booked',
		})
		expect(await emissions()).toEqual([
			expect.objectContaining({
				reservationId: first.reservationId,
				eventType: 'reservation_booked',
			}),
		])

		await book({
			phone,
			customerId: customer.id,
			customerPhone: phone,
			localMin: 20 * 60,
		})
		runs = await runsFor(journey.id)
		expect(runs).toHaveLength(2)
		expect(await emissions()).toHaveLength(2)
	})

	it('waits for the owner to confirm a first-time consent by email (double opt-in)', async () => {
		const journey = await activeJourney('reservation_booked')
		const { reservationId, phone } = await book({
			marketing: true,
			email: 'pending@example.com',
		})
		// Ticked, but nobody proved the address is theirs yet: no run, no emission.
		expect(await runsFor(journey.id)).toEqual([])
		expect(await emissions()).toEqual([])
		const db = await getTenantDb(ORG)
		const [guest] = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.phoneE164, phone))
		const [subscription] = await db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, guest!.marketingCustomerId!))
			.all()
		expect(subscription).toMatchObject({
			topic: 'reservations',
			channel: 'email',
			source: 'reservation_booking',
			unsubscribedAt: null,
			confirmedEmailHash: null,
		})
		await expect(
			emitReservationJourney({
				orgId: ORG,
				reservationId,
				trigger: 'reservation_booked',
			}),
		).resolves.toEqual({ emitted: false, reason: 'not_eligible' })

		// The owner follows the emailed link.
		expect(
			await confirmCustomerSubscription(db, {
				customerId: guest!.marketingCustomerId!,
				topic: 'reservations',
				email: 'pending@example.com',
			}),
		).toBe(true)
		await expect(
			emitReservationJourney({
				orgId: ORG,
				reservationId,
				trigger: 'reservation_booked',
			}),
		).resolves.toMatchObject({ emitted: true })
		expect(await runsFor(journey.id)).toHaveLength(1)
	})

	it('fires for a guest who confirmed by email earlier and records the consent (VAL-JRNY-004)', async () => {
		const journey = await activeJourney('reservation_booked')
		const { reservationId, phone } = await book({
			marketing: true,
			confirmed: true,
			email: 'consent@example.com',
		})
		const runs = await runsFor(journey.id)
		expect(runs).toHaveLength(1)
		const db = await getTenantDb(ORG)
		const [guest] = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.phoneE164, phone))
		expect(guest!.marketingCustomerId).toBe(runs[0]!.customerId)
		expect(guest!.customerId).toBeNull()
		const [customer] = await db
			.select()
			.from(customers)
			.where(eq(customers.id, guest!.marketingCustomerId!))
		expect(customer).toMatchObject({
			phone,
			email: 'consent@example.com',
			phoneVerified: false,
		})
		const subscriptions = await db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, customer!.id))
			.all()
		expect(subscriptions).toHaveLength(1)
		expect(subscriptions[0]).toMatchObject({
			topic: 'reservations',
			channel: 'email',
			source: 'reservation_booking',
			unsubscribedAt: null,
			confirmedEmailHash: emailConsentHash('consent@example.com'),
		})
		expect(await emissions()).toEqual([
			expect.objectContaining({ reservationId }),
		])
	})

	it('gives a guest who is neither verified nor consenting no run, no emission and no customer row (VAL-JRNY-005)', async () => {
		const journey = await activeJourney('reservation_booked')
		const { phone } = await book({ marketing: false })
		expect(await runsFor(journey.id)).toEqual([])
		expect(await emissions()).toEqual([])
		const db = await getTenantDb(ORG)
		expect(
			await db.select().from(customers).where(eq(customers.phone, phone)),
		).toEqual([])
		// The booking itself still counts.
		expect(await db.select().from(rsvReservations).all()).toHaveLength(1)
	})

	it('needs the marketing email to be the one the profile holds', async () => {
		const journey = await activeJourney('reservation_booked')
		const first = await book({
			phone: '+14155550188',
			email: 'owner@example.com',
			marketing: false,
			localMin: 17 * 60,
		})
		// Someone else types the same phone with another address and ticks the box.
		await book({
			phone: first.phone,
			email: 'attacker@example.com',
			marketing: true,
			localMin: 20 * 60,
		})
		expect(await runsFor(journey.id)).toEqual([])
		const db = await getTenantDb(ORG)
		expect(await db.select().from(customers).all()).toEqual([])
		expect(await db.select().from(customerSubscriptions).all()).toEqual([])
	})

	it('never links or rewrites a verified customer from a booking form', async () => {
		const journey = await activeJourney('reservation_booked')
		const phone = '+14155550166'
		const owner = await verifiedCustomer(phone)
		await book({ phone, email: 'typed@example.com', marketing: true })
		expect(await runsFor(journey.id)).toEqual([])
		const db = await getTenantDb(ORG)
		const [after] = await db
			.select()
			.from(customers)
			.where(eq(customers.id, owner.id))
		expect(after).toMatchObject({ name: 'Vera Verified', email: null })
		expect(await db.select().from(customerSubscriptions).all()).toEqual([])
	})

	it('does not start a journey of another trigger', async () => {
		const cancelled = await activeJourney('reservation_cancelled')
		await book({ marketing: true, email: 'c@example.com' })
		expect(await runsFor(cancelled.id)).toEqual([])
	})
})

describe('emission', () => {
	it('is deduplicated per booking and trigger (VAL-JRNY-006)', async () => {
		const journey = await activeJourney('reservation_booked')
		const { reservationId } = await book({
			marketing: true,
			confirmed: true,
			email: 'dedupe@example.com',
		})
		expect(await runsFor(journey.id)).toHaveLength(1)
		for (let i = 0; i < 3; i++) {
			await expect(
				emitReservationJourney({
					orgId: ORG,
					reservationId,
					trigger: 'reservation_booked',
				}),
			).resolves.toEqual({ emitted: false, reason: 'already_emitted' })
		}
		expect(await runsFor(journey.id)).toHaveLength(1)
		expect(await emissions()).toHaveLength(1)
	})

	it('carries ids and counts only, never names, phones, emails or notes (VAL-JRNY-006)', async () => {
		const journey = await activeJourney('reservation_booked')
		const { reservationId, phone } = await book({
			marketing: true,
			confirmed: true,
			email: 'private@example.com',
			firstName: 'Quentin',
		})
		const [run] = await runsFor(journey.id)
		const context = JSON.parse(String(run!.contextData)) as Record<
			string,
			unknown
		>
		expect(Object.keys(context).sort()).toEqual(
			[...RESERVATION_JOURNEY_CONTEXT_KEYS].sort(),
		)
		expect(context).toMatchObject({
			reservationId,
			locationId: PUBLIC_LOC,
			partySize: 2,
			businessDate: DAY,
			channel: 'online',
			experienceId: null,
			visitNumber: 1,
		})
		const serialized = JSON.stringify(context)
		for (const secret of [
			'Quentin',
			'Secretname',
			phone,
			'private@example.com',
		]) {
			expect(serialized).not.toContain(secret)
		}
		// The worker payload is ids only as well.
		const workerBody = String(fetchMock.mock.calls[0]![1].body)
		for (const secret of [
			'Quentin',
			'Secretname',
			phone,
			'private@example.com',
		]) {
			expect(workerBody).not.toContain(secret)
		}
	})

	it('answers not eligible without a run for an unknown or ineligible booking', async () => {
		await activeJourney('reservation_booked')
		await expect(
			emitReservationJourney({
				orgId: ORG,
				reservationId: 'rsv_missing',
				trigger: 'reservation_booked',
			}),
		).resolves.toEqual({ emitted: false, reason: 'not_found' })
		const { reservationId } = await book()
		await expect(
			emitReservationJourney({
				orgId: ORG,
				reservationId,
				trigger: 'reservation_booked',
			}),
		).resolves.toEqual({ emitted: false, reason: 'not_eligible' })
		expect(await emissions()).toEqual([])
	})

	it('stops with the consent: a withdrawn subscription fires nothing', async () => {
		const journey = await activeJourney('reservation_completed')
		const { reservationId } = await book({
			marketing: true,
			email: 'withdrawn@example.com',
		})
		const db = await getTenantDb(ORG)
		await db.update(customerSubscriptions).set({ unsubscribedAt: new Date() })
		await expect(
			emitReservationJourney({
				orgId: ORG,
				reservationId,
				trigger: 'reservation_completed',
			}),
		).resolves.toEqual({ emitted: false, reason: 'not_eligible' })
		expect(await runsFor(journey.id)).toEqual([])
	})
})

describe('status transitions', () => {
	async function consentingBooking() {
		const result = await book({
			marketing: true,
			confirmed: true,
			email: 'flow@example.com',
		})
		return result.reservationId
	}

	it('fires completed, no-show and cancelled once each, from the host actions', async () => {
		const completed = await activeJourney('reservation_completed')
		const noShow = await activeJourney('reservation_no_show')
		const cancelled = await activeJourney('reservation_cancelled')

		const finishedId = await consentingBooking()
		for (const status of ['arrived', 'seated', 'finished']) {
			await transitionReservationStatus({
				orgId: ORG,
				reservationId: finishedId,
				actorId: 'usr_host',
				input: { status },
			})
		}
		const missed = await book({
			marketing: true,
			confirmed: true,
			email: 'flow2@example.com',
			localMin: 20 * 60,
		})
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: missed.reservationId,
			actorId: 'usr_host',
			actorKind: 'system',
			input: { status: 'no_show', reason: 'auto_no_show' },
		})
		const dropped = await book({
			marketing: true,
			confirmed: true,
			email: 'flow3@example.com',
			localMin: 19 * 60,
		})
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: dropped.reservationId,
			actorId: 'usr_host',
			input: { status: 'cancelled', cancelReason: 'private note' },
		})

		expect(await runsFor(completed.id)).toHaveLength(1)
		expect(await runsFor(noShow.id)).toHaveLength(1)
		expect(await runsFor(cancelled.id)).toHaveLength(1)
		const completedRun = (await runsFor(completed.id))[0]!
		expect(JSON.parse(String(completedRun.contextData))).toMatchObject({
			reservationId: finishedId,
			// The finished visit is already counted on the profile.
			visitNumber: 1,
		})
		expect(JSON.stringify(await runsFor(cancelled.id))).not.toContain(
			'private note',
		)
		const events = (await emissions()).map((e) => e.eventType).sort()
		expect(events).toEqual([
			'reservation_booked',
			'reservation_booked',
			'reservation_booked',
			'reservation_cancelled',
			'reservation_completed',
			'reservation_no_show',
		])
	})

	it('fires reservation_cancelled once from a guest cancel and not at booking time (VAL-JRNY-008)', async () => {
		const journey = await activeJourney('reservation_cancelled')
		const reservationId = await consentingBooking()
		expect(await runsFor(journey.id)).toEqual([])
		await guestCancelReservation({ orgId: ORG, reservationId })
		// A repeat of the same transition emits nothing more.
		await guestCancelReservation({ orgId: ORG, reservationId })
		expect(await runsFor(journey.id)).toHaveLength(1)
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(rsvJourneyEmissions)
			.where(
				and(
					eq(rsvJourneyEmissions.reservationId, reservationId),
					eq(rsvJourneyEmissions.eventType, 'reservation_cancelled'),
				),
			)
			.all()
		expect(rows).toHaveLength(1)
	})

	it('knows exactly four reservation triggers', () => {
		expect([...RESERVATION_JOURNEY_TRIGGER_TYPES]).toHaveLength(4)
	})
})
