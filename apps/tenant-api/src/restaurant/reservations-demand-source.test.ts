import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEMAND_BUCKET_SECONDS } from '@repo/staffing'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PUBLIC_LOC } from '../routes/reservations-public-fixture.ts'
import {
	HOUR,
	insertGuest,
	insertReservation,
} from '../services/rsv-message-fixture.ts'
import {
	reservationsDemandSource,
	VISITS_SOURCE_ID,
} from './reservations-demand-source.ts'

const ORG = 'org_visits_source'
const CHICAGO = 'America/Chicago'

let tempDir: string
beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visits-source-test-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
})
afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

const FAR = Date.UTC(2031, 5, 10, 0, 0) // a future Tuesday, UTC midnight
const window = (fromMs: number, toMs: number, timeZone = 'UTC') => ({
	fromSeconds: Math.floor(fromMs / 1000),
	toSeconds: Math.floor(toMs / 1000),
	timeZone,
})

async function booking(
	startAt: number,
	partySize: number,
	patch: Parameters<typeof insertReservation>[1] extends infer P
		? Partial<P>
		: never = {},
) {
	const db = await getTenantDb(ORG)
	const guest = await insertGuest(db)
	return insertReservation(db, {
		guestId: guest.id,
		startAt,
		partySize,
		...patch,
	} as Parameters<typeof insertReservation>[1])
}

describe('visits demand source', () => {
	it('is the `visits` unit', () => {
		expect(reservationsDemandSource).toMatchObject({
			id: VISITS_SOURCE_ID,
			unit: 'visits',
		})
	})

	describe('loadBooked', () => {
		it('sums the party sizes of future bookings by local start hour (VAL-FCST-001)', async () => {
			await booking(FAR + 19 * HOUR, 2)
			await booking(FAR + 19 * HOUR + 30 * 60_000, 4)
			await booking(FAR + 20 * HOUR, 3, { status: 'confirmed' })
			await booking(FAR + 20 * HOUR, 5, { status: 'arrived' })
			const db = await getTenantDb(ORG)
			const facts = await reservationsDemandSource.loadBooked(
				db,
				PUBLIC_LOC,
				window(FAR, FAR + 24 * HOUR),
			)
			const byHour = Object.fromEntries(
				facts.reduce<Array<[string, number]>>((rows, fact) => {
					const key = `${fact.date}#${fact.hour}`
					const existing = rows.find(([k]) => k === key)
					if (existing) existing[1] += fact.units
					else rows.push([key, fact.units])
					return rows
				}, []),
			)
			expect(byHour).toEqual({ '2031-06-10#19': 6, '2031-06-10#20': 8 })
		})

		it('leaves out cancelled, no-show, declined, expired and finished bookings', async () => {
			for (const status of [
				'cancelled',
				'no_show',
				'declined',
				'expired',
				'finished',
				'seated',
				'pending_approval',
			] as const) {
				await booking(FAR + 19 * HOUR, 6, { status })
			}
			await booking(FAR + 19 * HOUR, 2)
			const db = await getTenantDb(ORG)
			const facts = await reservationsDemandSource.loadBooked(
				db,
				PUBLIC_LOC,
				window(FAR, FAR + 24 * HOUR),
			)
			expect(facts).toEqual([{ date: '2031-06-10', hour: 19, units: 2 }])
		})

		it('counts a booking waiting for its deposit only while the payment window is open', async () => {
			await booking(FAR + 19 * HOUR, 4, {
				status: 'pending_payment',
				paymentExpiresAt: Date.now() + HOUR,
			})
			await booking(FAR + 19 * HOUR, 7, {
				status: 'pending_payment',
				paymentExpiresAt: Date.now() - HOUR,
			})
			const db = await getTenantDb(ORG)
			const facts = await reservationsDemandSource.loadBooked(
				db,
				PUBLIC_LOC,
				window(FAR, FAR + 24 * HOUR),
			)
			expect(facts).toEqual([{ date: '2031-06-10', hour: 19, units: 4 }])
		})

		it('is limited to the scope and the window', async () => {
			await booking(FAR + 19 * HOUR, 2)
			await booking(FAR + 19 * HOUR, 9, { locationId: 'loc_other' })
			await booking(FAR + 30 * HOUR, 5)
			const db = await getTenantDb(ORG)
			const here = await reservationsDemandSource.loadBooked(
				db,
				PUBLIC_LOC,
				window(FAR, FAR + 24 * HOUR),
			)
			expect(here).toEqual([{ date: '2031-06-10', hour: 19, units: 2 }])
			expect(
				await reservationsDemandSource.loadBooked(
					db,
					'loc_nobody',
					window(FAR, FAR + 48 * HOUR),
				),
			).toEqual([])
		})

		it('buckets by local hour across a daylight-saving change', async () => {
			// 19:30 Chicago on 2031-03-08 (CST, UTC-6) and 2031-03-09 (CDT, UTC-5).
			await booking(Date.UTC(2031, 2, 9, 1, 30), 2)
			await booking(Date.UTC(2031, 2, 10, 0, 30), 3)
			const db = await getTenantDb(ORG)
			const facts = await reservationsDemandSource.loadBooked(
				db,
				PUBLIC_LOC,
				window(Date.UTC(2031, 2, 8), Date.UTC(2031, 2, 11), CHICAGO),
			)
			expect(facts.sort((a, b) => a.date.localeCompare(b.date))).toEqual([
				{ date: '2031-03-08', hour: 19, units: 2 },
				{ date: '2031-03-09', hour: 19, units: 3 },
			])
		})

		it('selects no guest column: the facts carry a date, an hour and a count', async () => {
			await booking(FAR + 19 * HOUR, 2, {
				guestRequests: 'peanut allergy for Rana',
				staffNotes: 'VIP',
			})
			const db = await getTenantDb(ORG)
			const facts = await reservationsDemandSource.loadBooked(
				db,
				PUBLIC_LOC,
				window(FAR, FAR + 24 * HOUR),
			)
			expect(JSON.stringify(facts)).toBe(
				'[{"date":"2031-06-10","hour":19,"units":2}]',
			)
		})
	})

	describe('loadBuckets', () => {
		const seatedAt = (offsetMs: number) => FAR + offsetMs
		const bucketOf = (ms: number) =>
			Math.floor(Math.floor(ms / 1000) / DEMAND_BUCKET_SECONDS)

		it('sums the people seated, by 15-minute bucket of the seated time', async () => {
			await booking(seatedAt(18 * HOUR), 4, {
				status: 'finished',
				seatedAt: seatedAt(18 * HOUR + 5 * 60_000),
				coversActual: 5,
			})
			await booking(seatedAt(18 * HOUR), 2, {
				status: 'seated',
				seatedAt: seatedAt(18 * HOUR + 10 * 60_000),
				seatedCovers: 3,
			})
			// A walk-in with only the party size.
			await booking(seatedAt(18 * HOUR), 6, {
				status: 'finished',
				channel: 'walk_in',
				seatedAt: seatedAt(18 * HOUR + 40 * 60_000),
			})
			const db = await getTenantDb(ORG)
			const rows = await reservationsDemandSource.loadBuckets(db, PUBLIC_LOC, {
				fromSeconds: Math.floor(FAR / 1000),
				toSeconds: Math.floor((FAR + 24 * HOUR) / 1000),
				alignSeconds: 0,
			})
			expect(rows.sort((a, b) => a.bucket - b.bucket)).toEqual([
				{ bucket: bucketOf(seatedAt(18 * HOUR)), units: 8 },
				{ bucket: bucketOf(seatedAt(18 * HOUR + 40 * 60_000)), units: 6 },
			])
		})

		it('ignores bookings that never sat, other scopes and times outside the window', async () => {
			await booking(seatedAt(18 * HOUR), 4, { status: 'no_show' })
			await booking(seatedAt(18 * HOUR), 4, { status: 'cancelled' })
			await booking(seatedAt(18 * HOUR), 4, { status: 'booked' })
			await booking(seatedAt(18 * HOUR), 4, {
				status: 'finished',
				locationId: 'loc_other',
				seatedAt: seatedAt(18 * HOUR),
			})
			await booking(seatedAt(18 * HOUR), 4, {
				status: 'finished',
				seatedAt: seatedAt(40 * HOUR),
			})
			const db = await getTenantDb(ORG)
			expect(
				await reservationsDemandSource.loadBuckets(db, PUBLIC_LOC, {
					fromSeconds: Math.floor(FAR / 1000),
					toSeconds: Math.floor((FAR + 24 * HOUR) / 1000),
					alignSeconds: 0,
				}),
			).toEqual([])
		})
	})
})
