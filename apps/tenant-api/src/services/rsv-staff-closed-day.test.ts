import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvLocationSettings,
	rsvServices,
	rsvSpecialDays,
	rsvTables,
	rsvWaitlistEntries,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	createOperatorReservation,
	createWalkIn,
	updateReservation,
} from './rsv-booking-service.ts'
import { seatWaitlistEntry } from './rsv-waitlist-service.ts'

const ORG = 'org_staff_closed'
const LOC = 'loc_closed'
let tempDir: string

const DAY_MS = 86_400_000
const dayOffset = (n: number) =>
	new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10)
const TODAY = dayOffset(0)
const OPEN_DATE = dayOffset(5)
const CLOSED_DATE = dayOffset(6)

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-staff-closed-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	await provisionTenantDb(ORG)
	const db = await getTenantDb(ORG)
	await db.insert(rsvLocationSettings).values({
		locationId: LOC,
		timeZone: 'UTC',
		dayStartMin: 0,
		intervalMin: 30,
		enabled: true,
		version: 1,
	})
	await db
		.insert(rsvAreas)
		.values({ id: 'area_x', locationId: LOC, name: 'Main', sort: 0 })
	await db.insert(rsvTables).values(
		['t1', 't2', 't3'].map((id) => ({
			id: `tbl_${id}`,
			locationId: LOC,
			areaId: 'area_x',
			label: id,
			minCovers: 1,
			maxCovers: 4,
			resetBufferMin: 0,
		})),
	)
	await db.insert(rsvServices).values({
		id: 'svc_all_day',
		locationId: LOC,
		name: 'All day',
		daysMask: 127,
		firstSeatingMin: 0,
		lastSeatingMin: 22 * 60,
		endMin: 23 * 60 + 30,
		intervalMin: 30,
		sort: 0,
	})
	await db.insert(rsvSpecialDays).values([
		{
			id: 'sp_closed',
			locationId: LOC,
			fromDate: CLOSED_DATE,
			toDate: CLOSED_DATE,
			kind: 'closed',
			name: 'Private event',
		},
	])
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(tempDir, { recursive: true, force: true })
})

let n = 0
const walkIn = (date: string, extra: Record<string, unknown> = {}) =>
	createWalkIn({
		orgId: ORG,
		locationId: LOC,
		actorId: 'usr_host',
		idempotencyKey: `idem-wi-${++n}`,
		input: { locationId: LOC, date, time: '19:00', partySize: 2, ...extra },
	})

describe('staff writes on a closed day need the explicit override', () => {
	it('walk-in: refused without override, allowed with it, unchanged on an open day', async () => {
		await expect(walkIn(CLOSED_DATE)).rejects.toMatchObject({
			status: 409,
			code: 'closed_day',
		})
		const overridden = await walkIn(CLOSED_DATE, {
			overbook: true,
			overbookReason: 'Owner approved',
		})
		expect(overridden.reservation.status).toBe('seated')
		const open = await walkIn(OPEN_DATE)
		expect(open.reservation.status).toBe('seated')
	})

	it('waitlist seat: refused without override, allowed with it, unchanged on an open day', async () => {
		const db = await getTenantDb(ORG)
		const make = async (id: string) => {
			await db.insert(rsvWaitlistEntries).values({
				id,
				locationId: LOC,
				businessDate: TODAY,
				displayName: 'Wanda Waiter',
				partySize: 2,
			})
			return (await db
				.select()
				.from(rsvWaitlistEntries)
				.where(eq(rsvWaitlistEntries.id, id))
				.get())!
		}
		// Today is open: unchanged.
		const openEntry = await make('wl_open')
		const seated = await seatWaitlistEntry({
			orgId: ORG,
			actorId: 'usr_host',
			entry: openEntry,
			input: {},
		})
		expect(seated.reservation.status).toBe('seated')

		// Close today.
		await db.insert(rsvSpecialDays).values({
			id: 'sp_today',
			locationId: LOC,
			fromDate: TODAY,
			toDate: TODAY,
			kind: 'closed',
			name: 'Closed today',
		})
		const refusedEntry = await make('wl_closed')
		await expect(
			seatWaitlistEntry({
				orgId: ORG,
				actorId: 'usr_host',
				entry: refusedEntry,
				input: {},
			}),
		).rejects.toMatchObject({ status: 409, code: 'closed_day' })
		expect(
			(
				await db
					.select()
					.from(rsvWaitlistEntries)
					.where(eq(rsvWaitlistEntries.id, 'wl_closed'))
					.get()
			)?.status,
		).toBe('waiting')
		const allowed = await seatWaitlistEntry({
			orgId: ORG,
			actorId: 'usr_host',
			entry: refusedEntry,
			input: { overbook: true, overbookReason: 'Manager override' },
		})
		expect(allowed.reservation.status).toBe('seated')
	})

	it('move: refused onto a closed day without override, allowed with it, unchanged between open days', async () => {
		const booked = await createOperatorReservation({
			orgId: ORG,
			locationId: LOC,
			actorId: 'usr_host',
			idempotencyKey: 'idem-move-base',
			input: {
				locationId: LOC,
				date: OPEN_DATE,
				time: '19:00',
				partySize: 2,
				guest: { firstName: 'Mo', lastName: 'Ver' },
			},
		})
		const id = booked.reservation.id
		await expect(
			updateReservation({
				orgId: ORG,
				reservationId: id,
				actorId: 'usr_host',
				input: { date: CLOSED_DATE },
			}),
		).rejects.toMatchObject({ status: 409, code: 'closed_day' })

		const openMove = await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: 'usr_host',
			input: { date: dayOffset(7) },
		})
		expect(openMove.reservation.businessDate).toBe(dayOffset(7))

		const overridden = await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: 'usr_host',
			input: {
				date: CLOSED_DATE,
				overbook: true,
				overbookReason: 'Owner approved',
			},
		})
		expect(overridden.reservation.businessDate).toBe(CLOSED_DATE)
	})
})
