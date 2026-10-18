import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuestMerges,
	rsvGuests,
	rsvNotifyRequests,
	rsvWaitlistEntries,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eraseGuestProfile } from './rsv-guest-service.ts'

const ORG = 'org_guest_erase'
const LOC = 'loc_erase'
let tempDir: string

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-erase-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(tempDir, { recursive: true, force: true })
})

function notify(id: string, guestId: string | null, status = 'active') {
	return {
		id,
		locationId: LOC,
		businessDate: '2031-03-10',
		partySize: 2,
		fromLocalMin: 1080,
		toLocalMin: 1200,
		contactPhoneE164: '+14155550123',
		contactEmailNorm: `${id}@example.com`,
		guestId,
		status: status as 'active',
		expiresAt: Date.parse('2031-03-11T00:00:00Z'),
	}
}

function waitlist(id: string, guestId: string, status = 'waiting') {
	return {
		id,
		locationId: LOC,
		businessDate: '2031-03-10',
		guestId,
		displayName: 'Real Name',
		phoneE164: '+14155550124',
		emailNorm: `${id}@example.com`,
		partySize: 2,
		notes: 'secret',
		status: status as 'waiting',
	}
}

describe('eraseGuestProfile contact scrub', () => {
	it('clears notify and waitlist contact data across a recursive merge chain', async () => {
		const db = await getTenantDb(ORG)
		// Chain A <- B <- C: B merged into A, C merged into B.
		await db.insert(rsvGuests).values([
			{ id: 'gA', firstName: 'A', lastName: 'a', phoneE164: '+14155550001' },
			{
				id: 'gB',
				firstName: 'B',
				lastName: 'b',
				phoneE164: '+14155550002',
				mergedIntoId: 'gA',
			},
			{
				id: 'gC',
				firstName: 'C',
				lastName: 'c',
				phoneE164: '+14155550003',
				emailNorm: 'c@example.com',
				mergedIntoId: 'gB',
			},
			{
				id: 'gOther',
				firstName: 'O',
				lastName: 'o',
				phoneE164: '+14155550009',
			},
		])
		await db.insert(rsvGuestMerges).values([
			{ id: 'm1', keptGuestId: 'gA', mergedGuestId: 'gB', actorId: 'u' },
			{ id: 'm2', keptGuestId: 'gB', mergedGuestId: 'gC', actorId: 'u' },
		])
		await db
			.insert(rsvNotifyRequests)
			.values([
				notify('n_a', 'gA'),
				notify('n_c', 'gC'),
				notify('n_done', 'gB', 'booked'),
				notify('n_other', 'gOther'),
			])
		await db
			.insert(rsvWaitlistEntries)
			.values([
				waitlist('w_b', 'gB'),
				waitlist('w_c', 'gC', 'notified'),
				waitlist('w_seated', 'gC', 'seated'),
				waitlist('w_other', 'gOther'),
			])

		await eraseGuestProfile({ db, orgId: ORG, guestId: 'gA', actorId: 'u' })

		const notifyRows = await db.select().from(rsvNotifyRequests).all()
		expect(notifyRows).toHaveLength(4)
		for (const id of ['n_a', 'n_c', 'n_done']) {
			const row = notifyRows.find((r) => r.id === id)!
			expect(row.contactPhoneE164).toBeNull()
			expect(row.contactEmailNorm).toBeNull()
		}
		expect(notifyRows.find((r) => r.id === 'n_a')!.status).toBe('cancelled')
		expect(notifyRows.find((r) => r.id === 'n_c')!.status).toBe('cancelled')
		expect(notifyRows.find((r) => r.id === 'n_done')!.status).toBe('booked')
		const other = notifyRows.find((r) => r.id === 'n_other')!
		expect(other.status).toBe('active')
		expect(other.contactPhoneE164).toBe('+14155550123')

		const waitRows = await db.select().from(rsvWaitlistEntries).all()
		expect(waitRows).toHaveLength(4)
		expect(waitRows.find((r) => r.id === 'w_b')!.status).toBe('cancelled')
		expect(waitRows.find((r) => r.id === 'w_c')!.status).toBe('cancelled')
		expect(waitRows.find((r) => r.id === 'w_seated')!.status).toBe('seated')
		for (const id of ['w_b', 'w_c', 'w_seated']) {
			const row = waitRows.find((r) => r.id === id)!
			expect(row.phoneE164).toBeNull()
			expect(row.emailNorm).toBeNull()
			expect(row.notes).toBeNull()
			expect(row.displayName).toBe('Removed Guest')
		}
		expect(waitRows.find((r) => r.id === 'w_other')!.status).toBe('waiting')

		const guests = await db.select().from(rsvGuests).all()
		expect(guests).toHaveLength(4)
		for (const id of ['gA', 'gB', 'gC']) {
			const g = guests.find((r) => r.id === id)!
			expect(g.phoneE164).toBeNull()
			expect(g.emailNorm).toBeNull()
			expect(g.erasedAt).not.toBeNull()
			expect(g.firstName).toBe('Erased')
		}
		expect(guests.find((r) => r.id === 'gOther')!.phoneE164).toBe(
			'+14155550009',
		)
		expect(await db.select().from(rsvGuestMerges).all()).toHaveLength(2)
	})

	it('survives a merge cycle without looping', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvGuests).values([
			{ id: 'gX', firstName: 'X', lastName: 'x', phoneE164: '+14155550011' },
			{ id: 'gY', firstName: 'Y', lastName: 'y', phoneE164: '+14155550012' },
		])
		await db.insert(rsvGuestMerges).values([
			{ id: 'c1', keptGuestId: 'gX', mergedGuestId: 'gY', actorId: 'u' },
			{ id: 'c2', keptGuestId: 'gY', mergedGuestId: 'gX', actorId: 'u' },
		])
		await db.insert(rsvNotifyRequests).values(notify('n_y', 'gY'))
		await eraseGuestProfile({ db, orgId: ORG, guestId: 'gX', actorId: 'u' })
		const row = await db
			.select()
			.from(rsvNotifyRequests)
			.where(eq(rsvNotifyRequests.id, 'n_y'))
			.get()
		expect(row!.contactPhoneE164).toBeNull()
		expect(row!.status).toBe('cancelled')
	})
})
