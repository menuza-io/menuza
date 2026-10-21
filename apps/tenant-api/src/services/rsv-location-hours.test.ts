import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	type LocationSpecialHour,
	type LocationWeeklyDay,
	type ReservationsContext,
} from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvLocationSettings,
	rsvServices,
	rsvSpecialDays,
	rsvTables,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { publicContext } from '../routes/reservations-public-fixture.ts'
import { createOperatorReservation } from './rsv-booking-service.ts'
import {
	getBookConflicts,
	getDayFeed,
	getMonthCalendarSummary,
	getOperatorAvailability,
} from './rsv-day-feed-service.ts'
import {
	createServiceForLocation,
	updateServiceForLocation,
} from './rsv-setup-crud.ts'
import { validateLocationSetup } from './rsv-setup-service.ts'

const ORG = 'org_loc_hours'
const LOC = 'loc_pub_main' // the id the context fixture uses
let tempDir: string

const DAY_MS = 86_400_000
const dayOffset = (n: number) =>
	new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10)
const DATE = dayOffset(6)
const DAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
] as const

function weekly(
	slots: Array<[string, string]> | null = [['16:00', '23:00']],
	over: Partial<
		Record<(typeof DAYS)[number], Array<[string, string]> | null>
	> = {},
): LocationWeeklyDay[] {
	return DAYS.map((day) => {
		const s = day in over ? over[day]! : slots
		return {
			day,
			isOpen: s !== null,
			slots: (s ?? []).map(([start, end]) => ({ start, end })),
		}
	})
}

function seedHours(
	patch: {
		storeHours?: LocationWeeklyDay[] | null
		specialHours?: LocationSpecialHour[] | null
		isActive?: boolean
	} = {},
) {
	const ctx: ReservationsContext = publicContext(ORG)
	ctx.locations[0] = {
		...ctx.locations[0]!,
		storeHours: weekly(),
		specialHours: null,
		...patch,
	}
	seedReservationsContextForTest(ORG, ctx)
}

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-loc-hours-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	resetReservationsContextCache()
	await provisionTenantDb(ORG)
	const db = await getTenantDb(ORG)
	await db.insert(rsvLocationSettings).values({
		locationId: LOC,
		timeZone: 'UTC',
		dayStartMin: 0,
		intervalMin: 30,
		enabled: true,
		onlineEnabled: true,
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
		id: 'svc_dinner',
		locationId: LOC,
		name: 'Dinner',
		daysMask: 127,
		firstSeatingMin: 17 * 60,
		lastSeatingMin: 21 * 60,
		endMin: 23 * 60,
		intervalMin: 30,
		onlineEnabled: true,
		sort: 0,
	})
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	resetReservationsContextCache()
	rmSync(tempDir, { recursive: true, force: true })
})

const book = (
	date: string,
	time: string,
	extra: Record<string, unknown> = {},
) =>
	createOperatorReservation({
		orgId: ORG,
		locationId: LOC,
		actorId: 'usr_host',
		idempotencyKey: `idem-${date}-${time}-${Math.random()}`,
		input: {
			locationId: LOC,
			date,
			time,
			partySize: 2,
			guest: { firstName: 'Lo', lastName: 'Cation' },
			...extra,
		},
	})

describe('staff channel on a location-closed day', () => {
	const closedDate = (note = 'Christmas'): LocationSpecialHour[] => [
		{ id: 'sh1', date: DATE, isOpen: false, slots: [], note },
	]

	it('refuses with closed_day and the location source, allows the explicit override', async () => {
		seedHours({ specialHours: closedDate() })
		await expect(book(DATE, '19:00')).rejects.toMatchObject({
			status: 409,
			code: 'closed_day',
			details: { source: 'location_hours', reason: 'Christmas' },
		})
		const overridden = await book(DATE, '19:00', {
			overbook: true,
			overbookReason: 'Owner approved',
		})
		expect(overridden.reservation.status).toBeTruthy()
		expect(overridden.warnings.map((w) => w.code)).toContain('closed_day')
	})

	it('treats an inactive location like a closed day', async () => {
		seedHours({ isActive: false })
		await expect(book(DATE, '19:00')).rejects.toMatchObject({
			code: 'closed_day',
		})
	})

	it('a staff booking outside the open hours succeeds with a warning', async () => {
		seedHours({ storeHours: weekly([['18:00', '20:00']]) })
		const inside = await book(DATE, '19:00')
		expect(inside.warnings.map((w) => w.code)).not.toContain(
			'outside_location_hours',
		)
		const outside = await book(DATE, '21:00')
		expect(outside.warnings.map((w) => w.code)).toContain(
			'outside_location_hours',
		)
	})

	it('malformed hours fail open for staff too', async () => {
		const ctx = publicContext(ORG)
		// A malformed value parses to null in the context schema; simulate that result.
		ctx.locations[0] = { ...ctx.locations[0]!, storeHours: null }
		seedReservationsContextForTest(ORG, ctx)
		const res = await book(DATE, '19:00')
		expect(res.warnings).toEqual([])
	})

	it('operator availability lists slots flagged outside_location_hours on a closed day', async () => {
		seedHours({ specialHours: closedDate() })
		const db = await getTenantDb(ORG)
		const avail = await getOperatorAvailability(db, LOC, {
			date: DATE,
			partySize: 2,
			serviceId: 'svc_dinner',
		})
		expect(avail.closed).toBe(true)
		expect(avail.dayState).toMatchObject({
			state: 'closed',
			closedSource: 'location_hours',
			closedLabel: 'Closed: Christmas (from location hours)',
		})
		expect(avail.slots.length).toBeGreaterThan(0)
		expect(
			avail.slots.every((s) => s.warnings?.includes('outside_location_hours')),
		).toBe(true)
	})

	it('operator availability flags only the slots outside partial hours', async () => {
		seedHours({ storeHours: weekly([['17:00', '19:00']]) })
		const db = await getTenantDb(ORG)
		const avail = await getOperatorAvailability(db, LOC, {
			date: DATE,
			partySize: 2,
			serviceId: 'svc_dinner',
		})
		const flagged = (t: string) =>
			avail.slots.find((s) => s.time === t)?.warnings?.[0]
		expect(flagged('18:30')).toBeUndefined()
		expect(flagged('20:00')).toBe('outside_location_hours')
		// Outside-hours slots are still bookable for staff (not a pacing problem).
		expect(avail.slots.find((s) => s.time === '20:00')?.pacingWarning).toBe(
			false,
		)
	})
})

describe('reservations-only closure keeps its own semantics', () => {
	it('closed special day on an open location says Reservations as the source', async () => {
		seedHours()
		const db = await getTenantDb(ORG)
		await db.insert(rsvSpecialDays).values({
			id: 'sp1',
			locationId: LOC,
			fromDate: DATE,
			toDate: DATE,
			kind: 'closed',
			name: 'Buyout',
		})
		await expect(book(DATE, '19:00')).rejects.toMatchObject({
			code: 'closed_day',
			details: { source: 'reservation_special_day' },
		})
		const feed = await getDayFeed(db, ORG, LOC, DATE)
		expect(feed).toMatchObject({
			dayState: 'closed',
			closedSource: 'reservation_special_day',
			closedLabel: 'Closed: Buyout (Reservations)',
		})
	})
})

describe('host stand day feed, month calendar and conflicts', () => {
	it('day feed reports the location closure fields and an open day as open', async () => {
		const db = await getTenantDb(ORG)
		seedHours()
		expect(await getDayFeed(db, ORG, LOC, DATE)).toMatchObject({
			dayState: 'open',
			closedSource: null,
			closedReason: null,
		})
		seedHours({
			specialHours: [
				{ id: 'sh', date: DATE, isOpen: false, slots: [], note: 'Holiday' },
			],
		})
		const closed = await getDayFeed(db, ORG, LOC, DATE)
		expect(closed).toMatchObject({
			dayState: 'closed',
			closedSource: 'location_hours',
			closedReason: 'Holiday',
			closedLabel: 'Closed: Holiday (from location hours)',
		})
		// The ETag moves with the effective state so a cached open feed is not reused.
		seedHours()
		const open = await getDayFeed(db, ORG, LOC, DATE)
		expect(open.etag).not.toBe(closed.etag)
	})

	it('month summary marks location-closed days with the source', async () => {
		const db = await getTenantDb(ORG)
		seedHours({
			specialHours: [
				{ id: 'sh', date: DATE, isOpen: false, slots: [], note: 'Holiday' },
			],
		})
		const month = DATE.slice(0, 7)
		const summary = await getMonthCalendarSummary(db, ORG, LOC, month)
		expect(summary.daysByDate[DATE]).toMatchObject({
			closed: true,
			closedSource: 'location_hours',
			closedReason: 'Holiday',
			capacityCovers: 0,
		})
	})

	it('month capacity reads the Monday-first service mask (bit 0 = Monday)', async () => {
		const db = await getTenantDb(ORG)
		seedHours()
		await db
			.update(rsvServices)
			.set({ daysMask: 1 }) // Monday only
			.where(eq(rsvServices.id, 'svc_dinner'))
		const month = DATE.slice(0, 7)
		const summary = await getMonthCalendarSummary(db, ORG, LOC, month)
		const weekdayOf = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay()
		const dates = Object.keys(summary.daysByDate)
		const monday = dates.find((d) => weekdayOf(d) === 1)!
		const tuesday = dates.find((d) => weekdayOf(d) === 2)!
		const sunday = dates.find((d) => weekdayOf(d) === 0)!
		// 3 tables x 4 seats = 12 seats; a day with one service has 2 turns, none has 1.
		expect(summary.daysByDate[monday]!.capacityCovers).toBe(24)
		expect(summary.daysByDate[tuesday]!.capacityCovers).toBe(12)
		expect(summary.daysByDate[sunday]!.capacityCovers).toBe(12)
	})

	it('service setup converts Sunday-first daysOfWeek to the Monday-first mask', async () => {
		const db = await getTenantDb(ORG)
		const created = await createServiceForLocation(db, {
			actorId: 'usr_host',
			locationId: LOC,
			name: 'Brunch',
			daysOfWeek: [1], // Monday
			firstSeatingMin: 600,
			lastSeatingMin: 720,
			endMin: 840,
		})
		expect(created.daysMask).toBe(1)
		const updated = await updateServiceForLocation(db, created.id, {
			actorId: 'usr_host',
			locationId: LOC,
			daysOfWeek: [0, 6], // Sunday + Saturday
		})
		expect(updated.service.daysMask).toBe(0b1100000)
	})

	it('existing bookings on a newly closed day are listed as conflicts', async () => {
		const db = await getTenantDb(ORG)
		seedHours()
		const made = await book(DATE, '19:00')
		const before = await getBookConflicts(db, ORG, LOC, DATE)
		expect(
			before.conflicts.filter((c) => c.kind === 'outside_service_hours'),
		).toHaveLength(0)
		seedHours({
			specialHours: [{ id: 'sh', date: DATE, isOpen: false, slots: [] }],
		})
		const after = await getBookConflicts(db, ORG, LOC, DATE)
		expect(after.conflicts).toContainEqual(
			expect.objectContaining({
				kind: 'outside_service_hours',
				reservationId: made.reservation.id,
			}),
		)
	})
})

describe('setup validation against location hours', () => {
	it('warns about services outside the weekly hours, closed weekdays, inactive and missing hours', async () => {
		const db = await getTenantDb(ORG)
		seedHours({ storeHours: weekly([['17:00', '19:00']], { monday: null }) })
		const result = await validateLocationSetup(db, ORG, LOC)
		const codes = result.warnings.map((w) => w.code)
		expect(codes).toContain('service_on_closed_weekday')
		expect(codes).toContain('service_outside_location_hours')
		expect(
			result.warnings.find((w) => w.code === 'service_on_closed_weekday')
				?.details,
		).toEqual({ serviceName: 'Dinner', day: 'monday' })

		seedHours({ isActive: false })
		expect(
			(await validateLocationSetup(db, ORG, LOC)).warnings.map((w) => w.code),
		).toContain('location_inactive')

		seedHours({ storeHours: null })
		const none = await validateLocationSetup(db, ORG, LOC)
		expect(none.warnings.map((w) => w.code)).toContain('location_no_hours')
	})

	it('adds an info note (not a warning) for a redundant closed special day', async () => {
		const db = await getTenantDb(ORG)
		seedHours({
			specialHours: [{ id: 'sh', date: DATE, isOpen: false, slots: [] }],
		})
		await db.insert(rsvSpecialDays).values({
			id: 'sp_red',
			locationId: LOC,
			fromDate: DATE,
			toDate: DATE,
			kind: 'closed',
			name: 'Closed',
		})
		const result = await validateLocationSetup(db, ORG, LOC)
		expect(result.infos).toEqual([
			expect.objectContaining({
				code: 'special_day_redundant_closed',
				entityId: 'sp_red',
				severity: 'info',
			}),
		])
		expect(result.warnings.map((w) => w.code)).not.toContain(
			'special_day_redundant_closed',
		)
	})

	it('adds no hours checks when the context is unknown (fail open)', async () => {
		const db = await getTenantDb(ORG)
		resetReservationsContextCache()
		const result = await validateLocationSetup(db, ORG, LOC)
		expect(result.warnings.map((w) => w.code)).not.toContain(
			'location_no_hours',
		)
	})
})
