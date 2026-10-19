import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	customerPaymentMethods,
	customerRefreshTokens,
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	marketingJourneys,
	provisionTenantDb,
	restaurantOrders,
	rsvAuditLog,
	rsvGuestNotes,
	rsvGuests,
	rsvHolds,
	rsvMessages,
	rsvNotifyRequests,
	rsvReservations,
	rsvWaitlistEntries,
	shopOrders,
	voiceCalls,
	voiceCallRequests,
	voiceSmsSends,
	websiteFormSubmissions,
	websiteForms,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { erasePerson } from './person-erasure-service.ts'
import { eraseGuestProfile } from './rsv-guest-service.ts'
import { emitReservationJourney } from '../restaurant/reservations-journeys.ts'

const ORG = 'org_person_erase'
const LOC = 'loc_pe'
const FUTURE = '2099-03-10'

// Distinctive values that must not survive anywhere in the database.
export const SENTINEL = {
	phone: '+14155550777',
	email: 'sentinel.person@example.com',
	name: 'Sentinelle',
	surname: 'Zorblax',
	address: '77 Sentinel Street',
	secret: 'secretallergynote',
} as const

let tempDir: string
let db: TenantDatabase
let seq = 0

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'person-erase-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
	db = await getTenantDb(ORG)
	seq = 0
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(tempDir, { recursive: true, force: true })
})

async function insertBooking(
	guestId: string,
	over: Record<string, unknown> = {},
) {
	seq += 1
	const id = (over.id as string | undefined) ?? `rsv_${seq}`
	const startAt = Date.parse(`${FUTURE}T19:00:00Z`)
	await db.insert(rsvReservations).values({
		id,
		locationId: LOC,
		guestId,
		confirmationCode: `CODE${seq}`,
		businessDate: FUTURE,
		localStartMin: 19 * 60,
		timeZone: 'UTC',
		startAt,
		endAt: startAt + 90 * 60_000,
		durationMin: 90,
		partySize: 2,
		status: 'booked',
		guestRequests: SENTINEL.secret,
		ipHash: 'iphash-sentinel',
		client: 'UA-sentinel',
		...over,
		id,
	} as never)
	return id
}

async function seedSentinelPerson() {
	await db.insert(customers).values({
		id: 'cus_s',
		name: `${SENTINEL.name} ${SENTINEL.surname}`,
		email: SENTINEL.email,
		phone: SENTINEL.phone,
		phoneVerified: true,
		stripeCustomerId: 'cus_stripe_sentinel',
		refreshTokenHash: 'rt-sentinel',
	})
	await db.insert(customerSubscriptions).values([
		{
			customerId: 'cus_s',
			topic: 'reservations',
			channel: 'email',
			source: 'reservation_booking',
			subscribedAt: new Date(),
		},
		{
			customerId: 'cus_s',
			topic: 'drops',
			channel: 'sms',
			source: 'profile',
			subscribedAt: new Date(),
		},
	])
	await db.insert(customerRefreshTokens).values({
		customerId: 'cus_s',
		tokenHash: 'rt-hash-sentinel',
		expiresAt: new Date(Date.now() + 1e9),
	})
	await db.insert(customerPaymentMethods).values({
		customerId: 'cus_s',
		stripePaymentMethodId: 'pm_sentinel',
		brand: 'visa',
		last4: '4242',
		expMonth: 1,
		expYear: 2099,
	})
	await db.insert(rsvGuests).values({
		id: 'gst_s',
		customerId: 'cus_s',
		firstName: SENTINEL.name,
		lastName: SENTINEL.surname,
		phoneE164: SENTINEL.phone,
		emailNorm: SENTINEL.email,
		allergyNotes: SENTINEL.secret,
		visits: 4,
	})
	// A merged duplicate with its own phone, linked to nothing.
	await db.insert(rsvGuests).values({
		id: 'gst_dupe',
		firstName: SENTINEL.name,
		lastName: 'Dupe',
		phoneE164: '+14155550778',
		mergedIntoId: 'gst_s',
	})
	await db.insert(rsvGuestNotes).values({
		id: 'note_s',
		guestId: 'gst_s',
		body: `note ${SENTINEL.secret}`,
		authorId: 'u',
	})
	const futureId = await insertBooking('gst_s')
	const pastId = await insertBooking('gst_s', {
		id: 'rsv_past',
		status: 'finished',
		businessDate: '2020-01-01',
		startAt: Date.parse('2020-01-01T19:00:00Z'),
		endAt: Date.parse('2020-01-01T20:30:00Z'),
	})
	await db.insert(rsvMessages).values({
		id: 'msg_pending',
		locationId: LOC,
		reservationId: futureId,
		kind: 'reminder',
		channel: 'email',
		sendAt: Date.now() + 1e6,
		dedupeKey: 'dk-1',
	})
	await db.insert(rsvHolds).values({
		id: 'hold_s',
		locationId: LOC,
		tokenHash: 'tok-sentinel',
		businessDate: FUTURE,
		localStartMin: 1140,
		startAt: Date.parse(`${FUTURE}T19:00:00Z`),
		endAt: Date.parse(`${FUTURE}T20:30:00Z`),
		partySize: 2,
		status: 'converted',
		expiresAt: Date.now() + 1e6,
		ipHash: 'iphash-hold-sentinel',
		reservationId: futureId,
	})
	// Waitlist and notify rows that only carry the phone (no guest id).
	await db.insert(rsvWaitlistEntries).values({
		id: 'wl_phone_only',
		locationId: LOC,
		businessDate: FUTURE,
		guestId: null,
		displayName: SENTINEL.name,
		phoneE164: SENTINEL.phone,
		partySize: 2,
		ipHash: 'iphash-wl',
	})
	await db.insert(rsvNotifyRequests).values({
		id: 'nr_phone_only',
		locationId: LOC,
		businessDate: FUTURE,
		partySize: 2,
		fromLocalMin: 1000,
		toLocalMin: 1200,
		contactPhoneE164: SENTINEL.phone,
		contactEmailNorm: SENTINEL.email,
		expiresAt: Date.now() + 1e9,
	})
	await db.insert(rsvMessages).values({
		id: 'msg_wl',
		locationId: LOC,
		waitlistEntryId: 'wl_phone_only',
		kind: 'waitlist_ready',
		channel: 'sms',
		sendAt: Date.now(),
		dedupeKey: 'dk-2',
	})
	// Orders: one by customer id, one guest checkout by phone, one by email.
	const order = (n: number, over: Record<string, unknown>) => ({
		orgId: ORG,
		number: `N-${n}`,
		status: 'completed' as const,
		paymentMethod: 'handoff' as const,
		paymentStatus: 'unpaid' as const,
		fulfillment: 'delivery' as const,
		locationId: LOC,
		locationName: 'Main',
		contactName: `${SENTINEL.name} ${SENTINEL.surname}`,
		contactPhone: '+15550001111',
		contactEmail: null,
		deliveryAddress: SENTINEL.address,
		deliveryCity: 'City',
		deliveryNotes: SENTINEL.secret,
		deliveryLat: 1.5,
		deliveryLng: 2.5,
		currency: 'usd',
		subtotalCents: 1000,
		taxCents: 100,
		totalCents: 1100,
		lines: [],
		idempotencyKey: `idem-${n}`,
		requestHash: 'rh',
		receiptTokenHash: `receipt-${n}`,
		...over,
	})
	await db.insert(restaurantOrders).values([
		order(1, { id: 'ord_c', customerId: 'cus_s' }),
		order(2, { id: 'ord_p', contactPhone: SENTINEL.phone }),
		order(3, { id: 'ord_e', contactEmail: SENTINEL.email.toUpperCase() }),
		order(4, {
			id: 'ord_other',
			contactName: 'Someone Else',
			deliveryAddress: '1 Other St',
			deliveryNotes: null,
		}),
	] as never)
	await db.insert(shopOrders).values({
		id: 'shop_s',
		customerId: 'cus_s',
		productName: 'Thing',
		amountCents: 500,
		platformFeeCents: 10,
		orgPayoutCents: 490,
	})
	// Voice.
	await db.insert(voiceCalls).values([
		{
			id: 'call_phone',
			channel: 'phone',
			roomName: 'room-1',
			callerPhone: SENTINEL.phone,
			summary: SENTINEL.secret,
			startedAt: new Date(),
		},
		{
			id: 'call_cust',
			channel: 'phone',
			roomName: 'room-2',
			callerPhone: '+15550002222',
			customerId: 'cus_s',
			startedAt: new Date(),
		},
		{
			id: 'call_other',
			channel: 'phone',
			roomName: 'room-3',
			callerPhone: '+15550003333',
			startedAt: new Date(),
		},
	])
	await db.insert(voiceCallRequests).values({
		id: 'req_s',
		callId: 'call_other',
		type: 'message',
		callerPhone: SENTINEL.phone,
		callerName: SENTINEL.name,
		details: { note: 'x' },
	})
	await db.insert(voiceSmsSends).values({
		id: 'sms_s',
		callId: 'call_other',
		kind: 'website_link',
		toPhone: SENTINEL.phone,
		status: 'sent',
	})
	// Journeys.
	await db.insert(marketingJourneys).values({ id: 'jrn_1', name: 'Welcome' })
	await db.insert(journeyRuns).values({
		id: 'run_s',
		journeyId: 'jrn_1',
		customerId: 'cus_s',
	})
	// Form submission that typed the email.
	await db.insert(websiteForms).values({ id: 'form_1', name: 'Contact' })
	await db.insert(websiteFormSubmissions).values([
		{
			id: 'sub_s',
			formId: 'form_1',
			values: { email: SENTINEL.email, message: 'hi' },
		},
		{ id: 'sub_other', formId: 'form_1', values: { email: 'other@x.com' } },
	])
	// An unrelated person that must stay untouched.
	await db.insert(customers).values({
		id: 'cus_other',
		name: 'Other Person',
		email: 'other@example.com',
		phone: '+14155550999',
		phoneVerified: true,
	})
	await db.insert(rsvGuests).values({
		id: 'gst_other',
		customerId: 'cus_other',
		firstName: 'Other',
		lastName: 'Person',
		phoneE164: '+14155550999',
	})
	await db.insert(customerSubscriptions).values({
		customerId: 'cus_other',
		topic: 'reservations',
		channel: 'email',
		source: 'profile',
		subscribedAt: new Date(),
	})
	return { futureId, pastId }
}

async function dumpDatabase(): Promise<string> {
	const tables = await db.all<{ name: string }>(
		sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'`,
	)
	const parts: string[] = []
	for (const { name } of tables) {
		if (name.startsWith('__') || name === 'd1_migrations') continue
		const rows = await db.all(sql.raw(`SELECT * FROM "${name}"`))
		parts.push(JSON.stringify(rows))
	}
	return parts.join('\n').toLowerCase()
}

function expectNoSentinel(dump: string) {
	for (const [key, value] of Object.entries(SENTINEL)) {
		expect(dump, `sentinel ${key} survived`).not.toContain(value.toLowerCase())
	}
	for (const extra of [
		'iphash-sentinel',
		'iphash-hold-sentinel',
		'iphash-wl',
		'ua-sentinel',
		'cus_stripe_sentinel',
		'pm_sentinel',
		'tok-sentinel',
		'rt-sentinel',
		'rt-hash-sentinel',
	]) {
		expect(dump, `${extra} survived`).not.toContain(extra)
	}
}

describe('erasePerson', () => {
	it('erasing a guest erases the linked customer, subscriptions, tokens, orders contact and voice data', async () => {
		const { futureId, pastId } = await seedSentinelPerson()

		const result = await eraseGuestProfile(db, 'gst_s', { actorId: 'op' })
		expect(result.erased).toBe(true)
		expect(result.cancelledFutureReservations).toBe(1)
		expect(result.customersErased).toBe(1)

		expectNoSentinel(await dumpDatabase())

		// Customer side is gone.
		expect(
			await db.select().from(customers).where(eq(customers.id, 'cus_s')),
		).toHaveLength(0)
		expect(
			await db
				.select()
				.from(customerSubscriptions)
				.where(eq(customerSubscriptions.customerId, 'cus_s')),
		).toHaveLength(0)
		expect(await db.select().from(customerRefreshTokens)).toHaveLength(0)
		expect(await db.select().from(customerPaymentMethods)).toHaveLength(0)
		expect(await db.select().from(journeyRuns)).toHaveLength(0)

		// Guests (and the merged duplicate) are anonymized, history stays.
		for (const id of ['gst_s', 'gst_dupe']) {
			const g = await db
				.select()
				.from(rsvGuests)
				.where(eq(rsvGuests.id, id))
				.get()
			expect(g!.erasedAt).not.toBeNull()
			expect(g!.phoneE164).toBeNull()
			expect(g!.emailNorm).toBeNull()
			expect(g!.customerId).toBeNull()
		}
		expect(await db.select().from(rsvGuestNotes)).toHaveLength(0)
		const future = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, futureId))
			.get()
		expect(future!.status).toBe('cancelled')
		expect(future!.guestRequests).toBeNull()
		expect(future!.ipHash).toBeNull()
		const past = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, pastId))
			.get()
		expect(past!.status).toBe('finished')

		// Orders: contact scrubbed, totals and numbers kept.
		const orders = await db.select().from(restaurantOrders).all()
		for (const id of ['ord_c', 'ord_p', 'ord_e']) {
			const o = orders.find((r) => r.id === id)!
			expect(o.contactName).toBe('Erased customer')
			expect(o.contactPhone).toBe('')
			expect(o.contactEmail).toBeNull()
			expect(o.deliveryAddress).toBeNull()
			expect(o.deliveryLat).toBeNull()
			expect(o.customerId).toBeNull()
			expect(o.totalCents).toBe(1100)
		}
		const other = orders.find((r) => r.id === 'ord_other')!
		expect(other.contactName).toBe('Someone Else')
		expect(other.deliveryAddress).toBe('1 Other St')
		const shop = await db.select().from(shopOrders).get()
		expect(shop!.customerId).toBeNull()
		expect(shop!.amountCents).toBe(500)

		// Voice rows tied to the phone or the customer.
		const calls = await db.select().from(voiceCalls).all()
		expect(calls.map((c) => c.id)).toEqual(['call_other'])
		expect(await db.select().from(voiceCallRequests)).toHaveLength(0)
		expect(await db.select().from(voiceSmsSends)).toHaveLength(0)

		// Waitlist and notify rows found by phone alone.
		const wl = await db.select().from(rsvWaitlistEntries).get()
		expect(wl!.phoneE164).toBeNull()
		expect(wl!.status).toBe('cancelled')
		const nr = await db.select().from(rsvNotifyRequests).get()
		expect(nr!.contactPhoneE164).toBeNull()
		expect(nr!.status).toBe('cancelled')

		// Holds tied to the person's bookings are removed with their hashes.
		expect(await db.select().from(rsvHolds)).toHaveLength(0)

		// Form submission that typed the email is redacted; the other stays.
		const subs = await db.select().from(websiteFormSubmissions).all()
		expect(subs.find((s) => s.id === 'sub_s')!.values).toEqual({
			redacted: true,
		})
		expect(subs.find((s) => s.id === 'sub_other')!.values).toEqual({
			email: 'other@x.com',
		})

		// The unrelated person is untouched.
		expect(
			await db.select().from(customers).where(eq(customers.id, 'cus_other')),
		).toHaveLength(1)
		const otherGuest = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_other'))
			.get()
		expect(otherGuest!.erasedAt).toBeNull()
		expect(otherGuest!.customerId).toBe('cus_other')
		expect(await db.select().from(customerSubscriptions)).toHaveLength(1)
	})

	it('erasing a customer erases the linked guest and the rest of the person', async () => {
		await seedSentinelPerson()
		const result = await erasePerson(
			db,
			{ customerId: 'cus_s' },
			{ actorId: 'sys' },
		)
		expect(result.customersErased).toBe(1)
		expect(result.guestsErased).toBe(2)
		expect(result.guest).toBeNull()
		expectNoSentinel(await dumpDatabase())
		const g = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_s'))
			.get()
		expect(g!.erasedAt).not.toBeNull()
		expect(g!.firstName).toBe('Erased')
	})

	it('finds the guest by the customer phone when no link exists, and the customer by the guest phone', async () => {
		await db.insert(customers).values({
			id: 'cus_unlinked',
			name: 'Unlinked',
			phone: '+14155550123',
			phoneVerified: false,
		})
		await db.insert(rsvGuests).values({
			id: 'gst_by_phone',
			firstName: 'Phone',
			lastName: 'Match',
			phoneE164: '+14155550123',
		})
		await erasePerson(db, { guestId: 'gst_by_phone' }, { actorId: 'op' })
		expect(await db.select().from(customers)).toHaveLength(0)
	})

	it('is idempotent: a second run changes nothing and adds no audit entry', async () => {
		await seedSentinelPerson()
		await erasePerson(db, { customerId: 'cus_s' }, { actorId: 'sys' })
		const auditBefore = await db.select().from(rsvAuditLog).all()
		const second = await erasePerson(
			db,
			{ customerId: 'cus_s' },
			{ actorId: 'sys' },
		)
		expect(second.alreadyErased).toBe(true)
		expect(second.customersErased).toBe(0)
		expect(second.guestsErased).toBe(0)
		const third = await erasePerson(db, { guestId: 'gst_s' }, { actorId: 'op' })
		expect(third.alreadyErased).toBe(true)
		expect(await db.select().from(rsvAuditLog).all()).toHaveLength(
			auditBefore.length,
		)
		expectNoSentinel(await dumpDatabase())
	})

	it('sends nothing after erasure: pending messages are cancelled and no journey is emitted', async () => {
		const { futureId } = await seedSentinelPerson()
		await erasePerson(db, { guestId: 'gst_s' }, { actorId: 'op' })
		const messages = await db.select().from(rsvMessages).all()
		for (const m of messages.filter(
			(r) => r.id === 'msg_pending' || r.id === 'msg_wl',
		)) {
			expect(m.status).toBe('cancelled')
		}
		const outcome = await emitReservationJourney({
			orgId: ORG,
			reservationId: futureId,
			trigger: 'reservation_cancelled',
		})
		expect(outcome.emitted).toBe(false)
	})

	it('keeps audit entries free of PII and redacts earlier ones', async () => {
		await seedSentinelPerson()
		await db.insert(rsvAuditLog).values({
			id: 'aud_old',
			actorKind: 'operator',
			action: 'guest.update',
			entityType: 'guest',
			entityId: 'gst_s',
			changes: { phone: SENTINEL.phone },
		})
		await erasePerson(db, { guestId: 'gst_s' }, { actorId: 'op' })
		const old = await db
			.select()
			.from(rsvAuditLog)
			.where(eq(rsvAuditLog.id, 'aud_old'))
			.get()
		expect(old!.changes).toEqual({ redacted: true })
	})

	it('rejects a call with neither id and a missing guest', async () => {
		await expect(erasePerson(db, {}, { actorId: 'x' })).rejects.toThrow()
		await expect(
			erasePerson(db, { guestId: 'nope' }, { actorId: 'x' }),
		).rejects.toMatchObject({ status: 404 })
	})
})
