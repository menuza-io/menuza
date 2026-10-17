import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuests,
	rsvLocationSettings,
	rsvReservationEvents,
	rsvReservations,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileGuestCounters } from './rsv-guestbook-service.ts'
import { isLateCancellation } from './rsv-late-cancel.ts'

const ORG = 'org_guest_counters'
const LOC = 'loc_counters'
const START = Date.parse('2031-03-10T19:00:00Z')
let tempDir: string

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-counters-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
	const db = await getTenantDb(ORG)
	await db.insert(rsvLocationSettings).values({
		locationId: LOC,
		timeZone: 'UTC',
		enabled: true,
		guestModifyCutoffMin: 60,
		version: 1,
	})
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(tempDir, { recursive: true, force: true })
})

describe('isLateCancellation', () => {
	it('uses the location cutoff when the booking carries no policy', async () => {
		const db = await getTenantDb(ORG)
		const r = { locationId: LOC, startAt: START, policySnapshot: null }
		expect(await isLateCancellation(db, r, START - 61 * 60_000)).toBe(false)
		expect(await isLateCancellation(db, r, START - 59 * 60_000)).toBe(true)
	})

	it('lets the policy snapshot cutoff win', async () => {
		const db = await getTenantDb(ORG)
		const r = {
			locationId: LOC,
			startAt: START,
			policySnapshot: { cancelCutoffMin: 24 * 60 },
		}
		expect(await isLateCancellation(db, r, START - 23 * 60 * 60_000)).toBe(true)
		expect(await isLateCancellation(db, r, START - 25 * 60 * 60_000)).toBe(
			false,
		)
	})
})

describe('reconcileGuestCounters', () => {
	async function seed() {
		const db = await getTenantDb(ORG)
		await db.insert(rsvGuests).values({
			id: 'gst_drift',
			firstName: 'Drift',
			lastName: 'Guest',
			visits: 9,
			noShows: 0,
			cancels: 4,
		})
		const base = {
			locationId: LOC,
			guestId: 'gst_drift',
			businessDate: '2031-03-10',
			localStartMin: 1140,
			timeZone: 'UTC',
			startAt: START,
			endAt: START + 90 * 60_000,
			durationMin: 90,
			partySize: 2,
			channel: 'online' as const,
		}
		await db.insert(rsvReservations).values([
			{ ...base, id: 'rd1', confirmationCode: 'D1', status: 'finished' },
			{ ...base, id: 'rd2', confirmationCode: 'D2', status: 'no_show' },
			{
				...base,
				id: 'rd3',
				confirmationCode: 'D3',
				status: 'cancelled',
				lateCancel: true,
			},
		])
		await db.insert(rsvReservationEvents).values({
			id: 'ev_touch',
			reservationId: 'rd2',
			type: 'no_show',
			at: START,
			actorKind: 'system',
		} as never)
		return db
	}

	it('repairs counters of recently touched guests from reservations', async () => {
		const db = await seed()
		const out = await reconcileGuestCounters(db, START + 60_000)
		expect(out).toEqual({ checked: 1, repaired: 1 })
		const g = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_drift'))
			.get()
		expect(g).toMatchObject({
			visits: 1,
			noShows: 1,
			cancels: 1,
			lateCancels: 1,
		})
		expect(await reconcileGuestCounters(db, START + 60_000)).toEqual({
			checked: 1,
			repaired: 0,
		})
	})

	it('leaves guests without recent status events alone', async () => {
		const db = await seed()
		const out = await reconcileGuestCounters(db, START + 30 * 86_400_000)
		expect(out).toEqual({ checked: 0, repaired: 0 })
		const g = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, 'gst_drift'))
			.get()
		expect(g?.visits).toBe(9)
	})
})
