import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuests,
	rsvReservations,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadBroadcastAudience } from './marketing-audience.ts'
import {
	linkGuestsToCustomers,
	linkGuestToVerifiedCustomer,
	linkVerifiedCustomerToGuest,
} from './rsv-customer-link.ts'
import { resolveOrCreateGuestForBooking } from './rsv-guest-service.ts'
import { mergeGuests } from './rsv-guestbook-service.ts'
import {
	loadGuestMarketingConsent,
	recordReservationMarketingConsent,
} from './rsv-marketing-consent.ts'

const ORG = 'org_customer_link'
const PHONE = '+14155550101'
let tempDir: string
let db: TenantDatabase

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-link-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
	db = await getTenantDb(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(tempDir, { recursive: true, force: true })
})

async function customer(id: string, phone: string | null, verified: boolean) {
	await db
		.insert(customers)
		.values({ id, name: `Cust ${id}`, phone, phoneVerified: verified })
}

async function guest(
	id: string,
	over: Partial<typeof rsvGuests.$inferInsert> = {},
) {
	await db
		.insert(rsvGuests)
		.values({ id, firstName: id, lastName: 'g', phoneE164: PHONE, ...over })
}

async function guestRow(id: string) {
	return (await db.select().from(rsvGuests).where(eq(rsvGuests.id, id)).get())!
}

describe('linking rule: verified phone only', () => {
	it('links a guest to the customer whose VERIFIED phone matches, and its bookings', async () => {
		await customer('c1', PHONE, true)
		await guest('g1')
		const startAt = Date.parse('2031-03-10T19:00:00Z')
		await db.insert(rsvReservations).values({
			id: 'r1',
			locationId: 'loc',
			guestId: 'g1',
			confirmationCode: 'C1',
			businessDate: '2031-03-10',
			localStartMin: 1140,
			timeZone: 'UTC',
			startAt,
			endAt: startAt + 5_400_000,
			durationMin: 90,
			partySize: 2,
		})
		const summary = await linkGuestsToCustomers(db, { orgId: ORG })
		expect(summary.linked).toBe(1)
		expect((await guestRow('g1')).customerId).toBe('c1')
		const r = await db.select().from(rsvReservations).get()
		expect(r!.customerId).toBe('c1')
	})

	it('never links on an unverified phone, a name or an email', async () => {
		await customer('c_unverified', PHONE, false)
		await db.insert(customers).values({
			id: 'c_email',
			name: 'g1 g',
			email: 'same@example.com',
			phone: '+14155550999',
			phoneVerified: true,
		})
		await guest('g1', { emailNorm: 'same@example.com' })
		const summary = await linkGuestsToCustomers(db, { orgId: ORG })
		expect(summary.linked).toBe(0)
		expect((await guestRow('g1')).customerId).toBeNull()
		expect(
			await linkGuestToVerifiedCustomer(db, await guestRow('g1')),
		).toBeNull()
		expect(
			(await linkVerifiedCustomerToGuest(db, 'c_unverified')).linkedGuestId,
		).toBeNull()
	})

	it('does not link a customer that already owns a guest, and skips erased and merged guests', async () => {
		await customer('c1', PHONE, true)
		await guest('g_owner', { customerId: 'c1', phoneE164: '+14155550222' })
		await guest('g_new')
		await guest('g_erased', { erasedAt: 1 })
		await guest('g_merged', { mergedIntoId: 'g_owner' })
		const summary = await linkGuestsToCustomers(db, { orgId: ORG })
		expect(summary.linked).toBe(0)
		expect(summary.alreadyLinked).toBe(1)
		expect((await guestRow('g_new')).customerId).toBeNull()
		expect((await guestRow('g_erased')).customerId).toBeNull()
		expect((await guestRow('g_merged')).customerId).toBeNull()
	})

	it('picks the guest with the latest visit when two share the phone, and is idempotent', async () => {
		await customer('c1', PHONE, true)
		await guest('g_old', { lastVisitAt: 1000 })
		await guest('g_recent', { lastVisitAt: 9000 })
		await guest('g_none')
		const first = await linkGuestsToCustomers(db, { orgId: ORG })
		expect(first).toMatchObject({ linked: 1, skippedTies: 2 })
		expect((await guestRow('g_recent')).customerId).toBe('c1')
		expect((await guestRow('g_old')).customerId).toBeNull()
		const second = await linkGuestsToCustomers(db, { orgId: ORG })
		expect(second.linked).toBe(0)
		expect((await guestRow('g_recent')).customerId).toBe('c1')
	})

	it('links at phone verification and never creates customer rows', async () => {
		await customer('c1', PHONE, true)
		await guest('g1')
		const before = await db.select().from(customers).all()
		const result = await linkVerifiedCustomerToGuest(db, 'c1', { orgId: ORG })
		expect(result.linkedGuestId).toBe('g1')
		expect((await guestRow('g1')).customerId).toBe('c1')
		expect(await db.select().from(customers).all()).toHaveLength(before.length)
		// Never throws into sign-in, even for a customer that does not exist.
		expect(
			(await linkVerifiedCustomerToGuest(db, 'missing', { orgId: ORG }))
				.linkedGuestId,
		).toBeNull()
	})

	it('operator booking links by phone to a verified customer only', async () => {
		await customer('c_verified', PHONE, true)
		await customer('c_unverified', '+14155550303', false)
		const linked = await resolveOrCreateGuestForBooking(db, {
			guest: { firstName: 'Ann', phone: PHONE },
		})
		expect(linked.customerId).toBe('c_verified')
		const unverified = await resolveOrCreateGuestForBooking(db, {
			guest: { firstName: 'Bob', phone: '+14155550303' },
		})
		expect(unverified.customerId).toBeNull()
		const walkIn = await resolveOrCreateGuestForBooking(db, {
			guest: { firstName: 'Walk-in' },
		})
		expect(walkIn.customerId).toBeNull()
		expect(walkIn.phoneE164).toBeNull()
	})
})

describe('merge and links', () => {
	it('blocks a merge of two guests linked to different customers (409 merge_conflicting_customers)', async () => {
		await customer('c1', '+14155550001', true)
		await customer('c2', '+14155550002', true)
		await guest('g1', { customerId: 'c1', phoneE164: '+14155550001' })
		await guest('g2', { customerId: 'c2', phoneE164: '+14155550002' })
		await expect(
			mergeGuests(db, { keepId: 'g1', mergeId: 'g2', actorId: 'u' }),
		).rejects.toMatchObject({
			status: 409,
			code: 'merge_conflicting_customers',
		})
		expect((await guestRow('g1')).customerId).toBe('c1')
		expect((await guestRow('g2')).customerId).toBe('c2')
		expect((await guestRow('g2')).mergedIntoId).toBeNull()
	})

	it('keeps the link when only one of the merged guests is linked', async () => {
		await customer('c2', '+14155550002', true)
		await guest('g1', { phoneE164: '+14155550001' })
		await guest('g2', { customerId: 'c2', phoneE164: '+14155550002' })
		await mergeGuests(db, { keepId: 'g1', mergeId: 'g2', actorId: 'u' })
		expect((await guestRow('g1')).customerId).toBe('c2')
		expect((await guestRow('g2')).customerId).toBeNull()
		expect((await guestRow('g2')).mergedIntoId).toBe('g1')
	})
})

describe('one consent source: customer_subscriptions', () => {
	it('booking consent writes only subscriptions, never the guest consent columns, and never links verified', async () => {
		await guest('g1', { emailNorm: 'a@example.com' })
		const row = await guestRow('g1')
		const customerId = await recordReservationMarketingConsent(db, {
			guest: row,
			email: 'a@example.com',
			channels: ['email'],
			now: 1_000,
		})
		expect(customerId).not.toBeNull()
		const g = await guestRow('g1')
		expect(g.marketingEmailConsentAt).toBeNull()
		expect(g.marketingSmsConsentAt).toBeNull()
		expect(g.consentSource).toBeNull()
		expect(g.customerId).toBeNull()
		expect(g.marketingCustomerId).toBe(customerId)
		const created = await db
			.select()
			.from(customers)
			.where(eq(customers.id, customerId!))
			.get()
		expect(created!.phoneVerified).toBe(false)
		const subs = await db.select().from(customerSubscriptions).all()
		expect(subs).toHaveLength(1)
		expect(subs[0]).toMatchObject({ topic: 'reservations', channel: 'email' })
	})

	it('the guest profile reads consent from the linked customer; null when unlinked', async () => {
		await guest('g_unlinked')
		expect(
			await loadGuestMarketingConsent(db, await guestRow('g_unlinked')),
		).toBeNull()
		await customer('c1', '+14155550001', true)
		await guest('g1', { customerId: 'c1', phoneE164: '+14155550001' })
		await db.insert(customerSubscriptions).values({
			customerId: 'c1',
			topic: 'drops',
			channel: 'sms',
			source: 'profile',
			subscribedAt: new Date(5000),
			unsubscribedAt: new Date(6000),
		})
		const consent = await loadGuestMarketingConsent(db, await guestRow('g1'))
		expect(consent!.subscriptions).toEqual([
			{
				topic: 'drops',
				channel: 'sms',
				subscribed: false,
				subscribedAt: 5000,
				unsubscribedAt: 6000,
				source: 'profile',
			},
		])
	})

	it('a broadcast audience contains only customers with an ACTIVE subscription for the channel', async () => {
		await db.insert(customers).values([
			{
				id: 'sub_email',
				name: 'A',
				email: 'a@x.com',
				phone: '+14155550011',
				phoneVerified: true,
			},
			{
				id: 'sub_sms',
				name: 'B',
				email: 'b@x.com',
				phone: '+14155550012',
				phoneVerified: true,
			},
			{
				id: 'sub_sms_unverified',
				name: 'C',
				email: 'c@x.com',
				phone: '+14155550013',
				phoneVerified: false,
			},
			{
				id: 'opted_out',
				name: 'D',
				email: 'd@x.com',
				phone: '+14155550014',
				phoneVerified: true,
			},
			{
				id: 'no_consent',
				name: 'E',
				email: 'e@x.com',
				phone: '+14155550015',
				phoneVerified: true,
			},
		])
		const sub = (
			customerId: string,
			channel: 'email' | 'sms',
			over: Record<string, unknown> = {},
		) => ({
			customerId,
			topic: 'drops' as const,
			channel,
			source: 'profile' as const,
			subscribedAt: new Date(),
			...over,
		})
		await db
			.insert(customerSubscriptions)
			.values([
				sub('sub_email', 'email'),
				sub('sub_sms', 'sms'),
				sub('sub_sms_unverified', 'sms'),
				sub('opted_out', 'email', { unsubscribedAt: new Date() }),
			])
		// Two topics for one customer still count once.
		await db
			.insert(customerSubscriptions)
			.values(sub('sub_email', 'email', { topic: 'reservations' }))
		const email = await loadBroadcastAudience(db, { channel: 'email' })
		expect(email.map((c) => c.id)).toEqual(['sub_email'])
		const sms = await loadBroadcastAudience(db, { channel: 'sms' })
		expect(sms.map((c) => c.id)).toEqual(['sub_sms'])
		const unverified = await loadBroadcastAudience(db, {
			channel: 'email',
			audience: 'unverified',
		})
		expect(unverified).toEqual([])
		const topicOnly = await loadBroadcastAudience(db, {
			channel: 'email',
			topics: ['reservations'],
		})
		expect(topicOnly.map((c) => c.id)).toEqual(['sub_email'])
	})
})
