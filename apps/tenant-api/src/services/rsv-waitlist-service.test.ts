import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	rsvLocationSettings,
	rsvMessages,
	rsvReservations,
	rsvTableOccupancies,
	rsvWaitlistEntries,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resetReservationsContextCache } from '../lib/reservations-context.ts'
import {
	clearReservationDayCacheForTest,
	withReservationWrite,
} from '../lib/reservations-write.ts'
import {
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import { getLocationBusinessDate } from './rsv-business-date.ts'
import {
	buildPublicWaitlistStatus,
	computeWaitlistQuote,
	createWaitlistEntry,
	findWaitlistEntryByToken,
	getOperatorWaitlistQuote,
	listWaitlistEntries,
	loadWaitlistEntry,
	notifyWaitlistEntry,
	reorderWaitlist,
	seatWaitlistEntry,
	setWaitlistEntryStatus,
	updateWaitlistEntry,
} from './rsv-waitlist-service.ts'
import { deriveWaitlistToken } from '../lib/reservations-public-auth.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-waitlist-svc-'))
process.env.TENANT_DB_DIR = TEST_DIR
process.env.DATA_REGION = 'us'
process.env.AUTH_HMAC_SECRET = 'test-waitlist-auth-hmac-secret-0123456789'
process.env.JWT_SECRET = 'test-waitlist-customer-jwt-secret-123456'

const ORG = 'org_waitlist_svc'

let counter = 0
const key = () =>
	`wl-key-${++counter}-${Math.random().toString(36).slice(2, 8)}`

async function add(
	name: string,
	partySize = 2,
	extra: Partial<Parameters<typeof createWaitlistEntry>[0]['input']> = {},
) {
	const { entryId } = await createWaitlistEntry({
		orgId: ORG,
		locationId: PUBLIC_LOC,
		idempotencyKey: key(),
		channel: 'walk_in',
		duplicateCode: 'duplicate_active_entry',
		input: { displayName: name, partySize, ...extra },
	})
	return entryId
}

async function today() {
	const db = await getTenantDb(ORG)
	return getLocationBusinessDate(db, PUBLIC_LOC)
}

async function listing() {
	const db = await getTenantDb(ORG)
	return listWaitlistEntries(db, {
		locationId: PUBLIC_LOC,
		businessDate: await today(),
		canReadGuestSensitive: true,
	})
}

beforeEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	resetReservationsContextCache()
	clearReservationDayCacheForTest()
	await seedPublicOrg(ORG, {
		settings: {
			waitlistEnabled: true,
			waitlistOnline: true,
			waitlistResponseMin: 10,
		},
	})
})

afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('waitlist entries', () => {
	it('adds entries in line order with a positive quote and a position', async () => {
		const a = await add('Ann', 2, { phone: '+14155550101' })
		const b = await add('Bob', 4)
		const c = await add('Cy', 2)
		const rows = (await listing()).entries
		expect(rows.map((r) => r.id)).toEqual([a, b, c])
		expect(rows.map((r) => r.position)).toEqual([1, 2, 3])
		for (const row of rows) {
			expect(row.status).toBe('waiting')
			expect(row.quotedMin === null || row.quotedMin >= 1).toBe(true)
		}
		const first = await loadWaitlistEntry(ORG, a)
		expect(first.phoneE164).toBe('+14155550101')
		expect(first.channel).toBe('walk_in')
	})

	it('answers a repeated idempotency key with the same entry and rejects a changed body', async () => {
		const k = key()
		const make = (name: string) =>
			createWaitlistEntry({
				orgId: ORG,
				locationId: PUBLIC_LOC,
				idempotencyKey: k,
				channel: 'walk_in',
				duplicateCode: 'duplicate_active_entry',
				input: { displayName: name, partySize: 2 },
			})
		const first = await make('Dee')
		const again = await make('Dee')
		expect(again.entryId).toBe(first.entryId)
		await expect(make('Different')).rejects.toMatchObject({
			status: 409,
			code: 'idempotency_conflict',
		})
		expect((await listing()).entries).toHaveLength(1)
	})

	it('refuses a second active entry for the same phone with the caller code', async () => {
		await add('Ann', 2, { phone: '+14155550101' })
		await expect(
			createWaitlistEntry({
				orgId: ORG,
				locationId: PUBLIC_LOC,
				idempotencyKey: key(),
				channel: 'remote',
				remote: true,
				duplicateCode: 'already_on_waitlist',
				input: {
					displayName: 'Ann again',
					partySize: 2,
					phone: '+14155550101',
				},
			}),
		).rejects.toMatchObject({ status: 409, code: 'already_on_waitlist' })
	})

	it('caps remote joins at waitlist_max_parties but not host additions', async () => {
		const db = await getTenantDb(ORG)
		await db
			.update(rsvLocationSettings)
			.set({ waitlistMaxParties: 2 })
			.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
		const remote = (n: number) =>
			createWaitlistEntry({
				orgId: ORG,
				locationId: PUBLIC_LOC,
				idempotencyKey: key(),
				channel: 'remote',
				remote: true,
				duplicateCode: 'already_on_waitlist',
				input: {
					displayName: `R${n}`,
					partySize: 2,
					email: `r${n}@example.com`,
				},
			})
		await remote(1)
		await remote(2)
		await expect(remote(3)).rejects.toMatchObject({
			status: 409,
			code: 'waitlist_full',
		})
		await add('Host added')
		expect((await listing()).counts.active).toBe(3)
	})

	it('queues a waitlist_joined message for an emailed guest', async () => {
		const id = await add('Eve', 2, { email: 'eve@example.com' })
		const db = await getTenantDb(ORG)
		const rows = await db
			.select()
			.from(rsvMessages)
			.where(eq(rsvMessages.waitlistEntryId, id))
			.all()
		expect(rows.map((r) => `${r.kind}:${r.channel}`)).toEqual([
			'waitlist_joined:email',
		])
	})

	it('quotes through one function: creation, the quote route and the status page agree', async () => {
		const db = await getTenantDb(ORG)
		const id = await add('Fay', 2)
		const entry = await loadWaitlistEntry(ORG, id)
		const quote = await getOperatorWaitlistQuote(db, {
			locationId: PUBLIC_LOC,
			partySize: 2,
			now: entry.joinedAt,
		})
		// Fay herself is now ahead of a new party of two.
		const direct = await computeWaitlistQuote(db, {
			locationId: PUBLIC_LOC,
			businessDate: entry.businessDate,
			partySize: 2,
			now: entry.joinedAt,
			ahead: [],
		})
		expect(entry.quotedMin).toBe(direct.quotedMin)
		expect(quote.quotedMin === null || quote.quotedMin >= 1).toBe(true)
		const status = await buildPublicWaitlistStatus(
			db,
			publicContext(ORG),
			entry,
			entry.joinedAt,
		)
		expect(status.quotedMin).toBe(direct.quotedMin)
		expect(status.position).toBe(1)
		expect(JSON.stringify(status)).not.toContain('Fay')
	})

	it('edits party size and requotes; a stale version is refused', async () => {
		const id = await add('Gus', 2)
		const before = await loadWaitlistEntry(ORG, id)
		await updateWaitlistEntry({
			orgId: ORG,
			entry: before,
			input: {
				partySize: 4,
				notes: 'high chair',
				expectedVersion: before.version,
			},
		})
		const after = await loadWaitlistEntry(ORG, id)
		expect(after.partySize).toBe(4)
		expect(after.notes).toBe('high chair')
		expect(after.version).toBe(before.version + 1)
		await expect(
			updateWaitlistEntry({
				orgId: ORG,
				entry: after,
				input: { partySize: 3, expectedVersion: before.version },
			}),
		).rejects.toMatchObject({ status: 409, code: 'stale_version' })
	})
})

describe('reorder', () => {
	it('swaps listed entries and leaves the others in place', async () => {
		const [a, b, c, d] = [
			await add('A'),
			await add('B'),
			await add('C'),
			await add('D'),
		]
		await reorderWaitlist({
			orgId: ORG,
			locationId: PUBLIC_LOC,
			businessDate: await today(),
			ids: [d, a],
		})
		expect((await listing()).entries.map((e) => e.id)).toEqual([d, b, c, a])
	})

	it('rejects duplicate and unknown ids', async () => {
		const a = await add('A')
		const businessDate = await today()
		await expect(
			reorderWaitlist({
				orgId: ORG,
				locationId: PUBLIC_LOC,
				businessDate,
				ids: [a, a],
			}),
		).rejects.toMatchObject({ status: 400 })
		await expect(
			reorderWaitlist({
				orgId: ORG,
				locationId: PUBLIC_LOC,
				businessDate,
				ids: ['missing'],
			}),
		).rejects.toMatchObject({ status: 404 })
	})
})

describe('notify and status', () => {
	it('takes the response deadline from the live location settings (VAL-WAIT-025)', async () => {
		const db = await getTenantDb(ORG)
		const id = await add('Hal', 2, { email: 'hal@example.com' })
		await db
			.update(rsvLocationSettings)
			.set({ waitlistResponseMin: 25 })
			.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
		const out = await notifyWaitlistEntry({
			orgId: ORG,
			entry: await loadWaitlistEntry(ORG, id),
		})
		expect(out.changed).toBe(true)
		const row = await loadWaitlistEntry(ORG, id)
		expect(row.status).toBe('notified')
		expect(row.responseDeadlineAt! - row.notifiedAt!).toBe(25 * 60_000)
	})

	it('repeating Notify neither restarts the clock nor queues a second message', async () => {
		const db = await getTenantDb(ORG)
		const id = await add('Ivy', 2, { email: 'ivy@example.com' })
		await notifyWaitlistEntry({
			orgId: ORG,
			entry: await loadWaitlistEntry(ORG, id),
		})
		const first = await loadWaitlistEntry(ORG, id)
		const again = await notifyWaitlistEntry({ orgId: ORG, entry: first })
		expect(again.changed).toBe(false)
		const second = await loadWaitlistEntry(ORG, id)
		expect(second.notifiedAt).toBe(first.notifiedAt)
		expect(second.version).toBe(first.version)
		const ready = await db
			.select()
			.from(rsvMessages)
			.where(eq(rsvMessages.waitlistEntryId, id))
			.all()
		expect(ready.filter((m) => m.kind === 'waitlist_ready')).toHaveLength(1)
	})

	it('moves a notified entry past its deadline to no_response inside any write (VAL-WAIT-023)', async () => {
		const id = await add('Jo')
		await notifyWaitlistEntry({
			orgId: ORG,
			entry: await loadWaitlistEntry(ORG, id),
		})
		const notified = await loadWaitlistEntry(ORG, id)
		await withReservationWrite(
			{ orgId: ORG, now: notified.responseDeadlineAt! + 1000 },
			async () => undefined,
		)
		expect((await loadWaitlistEntry(ORG, id)).status).toBe('no_response')
	})

	it('follows the transition table', async () => {
		const id = await add('Kai')
		const entry = () => loadWaitlistEntry(ORG, id)
		await setWaitlistEntryStatus({
			orgId: ORG,
			entry: await entry(),
			status: 'on_the_way',
		})
		expect((await entry()).status).toBe('on_the_way')
		const noop = await setWaitlistEntryStatus({
			orgId: ORG,
			entry: await entry(),
			status: 'on_the_way',
		})
		expect(noop.changed).toBe(false)
		await setWaitlistEntryStatus({
			orgId: ORG,
			entry: await entry(),
			status: 'left',
		})
		await expect(
			setWaitlistEntryStatus({
				orgId: ORG,
				entry: await entry(),
				status: 'waiting',
			}),
		).rejects.toMatchObject({ status: 409, code: 'invalid_status_transition' })
	})

	it('revives a no_response party back into the line', async () => {
		const id = await add('Lee')
		await setWaitlistEntryStatus({
			orgId: ORG,
			entry: await loadWaitlistEntry(ORG, id),
			status: 'no_response',
		})
		await setWaitlistEntryStatus({
			orgId: ORG,
			entry: await loadWaitlistEntry(ORG, id),
			status: 'waiting',
		})
		const row = await loadWaitlistEntry(ORG, id)
		expect(row.status).toBe('waiting')
		expect(row.responseDeadlineAt).toBeNull()
	})

	it('resolves a status token only for the right entry and version', async () => {
		const id = await add('Mia')
		const row = await loadWaitlistEntry(ORG, id)
		const token = deriveWaitlistToken(ORG, id, row.statusTokenVersion)
		expect((await findWaitlistEntryByToken(ORG, token))?.id).toBe(id)
		expect(await findWaitlistEntryByToken(ORG, null)).toBeNull()
		expect(await findWaitlistEntryByToken(ORG, 'rsv_w_junk')).toBeNull()
		expect(
			await findWaitlistEntryByToken(
				ORG,
				deriveWaitlistToken(ORG, id, row.statusTokenVersion + 1),
			),
		).toBeNull()
		expect(
			await findWaitlistEntryByToken(
				ORG,
				deriveWaitlistToken('org_other', id, row.statusTokenVersion),
			),
		).toBeNull()
	})
})

describe('seating', () => {
	it('seats from the waitlist: channel waitlist, table occupied, entry seated', async () => {
		const db = await getTenantDb(ORG)
		const id = await add('Ned', 2, { phone: '+14155550177' })
		const entry = await loadWaitlistEntry(ORG, id)
		const seated = await seatWaitlistEntry({
			orgId: ORG,
			actorId: 'usr_host',
			entry,
			input: { tableIds: ['tbl_pub_2'] },
		})
		expect(seated.reservation.id).toBeTruthy()
		const row = await loadWaitlistEntry(ORG, id)
		expect(row.status).toBe('seated')
		expect(row.reservationId).toBe(seated.reservation.id)
		expect(row.guestId).toBeTruthy()
		const reservation = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, row.reservationId!))
			.get()
		expect(reservation?.channel).toBe('waitlist')
		expect(reservation?.status).toBe('seated')
		const occupancies = await db
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.reservationId, row.reservationId!))
			.all()
		expect(occupancies.map((o) => o.tableId)).toEqual(['tbl_pub_2'])
	})

	it('refuses to seat a party twice and leaves no second reservation', async () => {
		const db = await getTenantDb(ORG)
		const id = await add('Opal', 2)
		await seatWaitlistEntry({
			orgId: ORG,
			actorId: 'usr_host',
			entry: await loadWaitlistEntry(ORG, id),
			input: { tableIds: ['tbl_pub_2'] },
		})
		await expect(
			seatWaitlistEntry({
				orgId: ORG,
				actorId: 'usr_host',
				entry: await loadWaitlistEntry(ORG, id),
				input: { tableIds: ['tbl_pub_4'] },
			}),
		).rejects.toMatchObject({ status: 409, code: 'invalid_status_transition' })
		expect(await db.select().from(rsvReservations).all()).toHaveLength(1)
	})

	it('rolls the walk-in back when the entry changed underneath it', async () => {
		const db = await getTenantDb(ORG)
		const id = await add('Pru', 2)
		const stale = await loadWaitlistEntry(ORG, id)
		await setWaitlistEntryStatus({
			orgId: ORG,
			entry: stale,
			status: 'cancelled',
		})
		await expect(
			seatWaitlistEntry({
				orgId: ORG,
				actorId: 'usr_host',
				entry: stale,
				input: { tableIds: ['tbl_pub_2'] },
			}),
		).rejects.toMatchObject({ status: 409 })
		expect(await db.select().from(rsvReservations).all()).toHaveLength(0)
		expect(
			(await db.select().from(rsvWaitlistEntries).all()).map((e) => e.status),
		).toEqual(['cancelled'])
	})
})
