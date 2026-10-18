import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	rsvAreas,
	rsvExperiences,
	rsvHolds,
	rsvReservations,
	rsvTableOccupancies,
	rsvTables,
	RSV_RESERVATION_STATUS_VALUES,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import { createHold } from './rsv-hold-service.ts'
import {
	archiveExperience,
	createExperience,
	createExperienceSchedule,
	publishExperience,
} from './rsv-experience-service.ts'
import {
	getExperienceForBooking,
	loadBookedCoversBySeating,
} from './rsv-experience-engine.ts'
import { getPublicExperienceAvailability } from './rsv-experience-public.ts'
import {
	bookFromHold,
	guestModifyReservation,
} from './rsv-public-booking-service.ts'
import {
	getPublicAvailability,
	listBookableLocations,
} from './rsv-public-service.ts'
import { CAPACITY_STATUSES } from './rsv-public-engine.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-experience-test-'))
process.env.TENANT_DB_DIR = TEST_DIR

const ORG_ID = 'org_rsv_experience'
const ACTOR = 'usr_exp_operator'
const HOUR = 60
const H19 = 19 * HOUR
const H20 = 20 * HOUR
const H21 = 21 * HOUR

let seq = 0
const nextId = () => ++seq

async function makeExperience(options: {
	date: string
	seatings: number[]
	usesTables?: boolean
	exclusive?: boolean
	capSeating?: number | null
	capDay?: number | null
	turnMin?: number
	areaIds?: string[] | null
	serviceId?: string | null
	partyMax?: number
	publish?: boolean
}) {
	const db = await getTenantDb(ORG_ID)
	const slug = `exp-${nextId()}`
	const base = { orgId: ORG_ID, actorId: ACTOR, locationId: PUBLIC_LOC }
	const created = await createExperience(db, {
		...base,
		input: {
			slug,
			kind: 'ticketed',
			nameI18n: { en: `Experience ${slug}` },
			priceMinor: 7500,
			pricePerCover: true,
			partyMin: 1,
			partyMax: options.partyMax ?? 8,
			usesTables: options.usesTables ?? true,
			exclusive: options.exclusive ?? false,
			sort: 0,
		},
	})
	await createExperienceSchedule(db, {
		...base,
		experienceId: created.id,
		input: {
			fromDate: options.date,
			toDate: options.date,
			daysMask: 127,
			seatingMins: options.seatings,
			turnMin: options.turnMin ?? 90,
			coversCapPerSeating: options.capSeating ?? null,
			coversCapPerDay: options.capDay ?? null,
			areaIds: options.areaIds ?? null,
			serviceId: options.serviceId ?? null,
		},
	})
	if (options.publish !== false) {
		await publishExperience(db, { ...base, experienceId: created.id })
	}
	return created.id
}

function bookingInput(n: number) {
	return {
		guest: {
			firstName: `Exp${n}`,
			lastName: 'Guest',
			phone: `+1415556${String(1000 + n)}`,
			email: null,
			locale: 'en',
		},
		smsOptIn: false,
		marketing: false,
	}
}

async function hold(
	experienceId: string,
	date: string,
	localMin: number,
	partySize: number,
	n = nextId(),
) {
	return createHold({
		orgId: ORG_ID,
		locationId: PUBLIC_LOC,
		slot: { date, localMin, partySize },
		experienceId,
		tokenHash: `hash_${n}_`.padEnd(64, 'x'),
		source: 'web',
		ipHash: `ip_${n}`,
	})
}

async function book(
	experienceId: string,
	date: string,
	localMin: number,
	partySize: number,
) {
	const n = nextId()
	await hold(experienceId, date, localMin, partySize, n)
	return bookFromHold({
		orgId: ORG_ID,
		holdTokenHash: `hash_${n}_`.padEnd(64, 'x'),
		input: bookingInput(n),
		client: 'web',
		channel: 'online',
		customerId: null,
		ipHash: `ip_${n}`,
		idempotencyKey: `idem-${n}-abcdefghij`,
		requestHash: `req_${n}`,
	})
}

async function refused(promise: Promise<unknown>) {
	return promise.then(
		() => null,
		(error: { status?: number; code?: string }) => error,
	)
}

async function availability(
	date: string,
	partySize: number,
	experienceId?: string,
) {
	const db = await getTenantDb(ORG_ID)
	const [location] = await listBookableLocations(
		db,
		publicContext(ORG_ID, { experiences: true }),
	)
	if (experienceId) {
		return getPublicExperienceAvailability(db, {
			locationId: PUBLIC_LOC,
			experienceId,
			date,
			partySize,
			location: location!,
			features: { online: true, experiences: true },
		})
	}
	return getPublicAvailability(db, {
		locationId: PUBLIC_LOC,
		date,
		partySize,
		location: location!,
		features: { waitlist: false, online: true },
	})
}

const times = (result: { slots: Array<{ time: string }> }) =>
	result.slots.map((s) => s.time)

describe('Experience availability, caps and tables', () => {
	beforeAll(async () => {
		await seedPublicOrg(ORG_ID, { seedContext: false })
	})
	afterAll(async () => {
		await destroyTenantDb(ORG_ID)
		fs.rmSync(TEST_DIR, { recursive: true, force: true })
	})

	it('uses the shared capacity statuses, all of which are DB statuses', () => {
		for (const status of CAPACITY_STATUSES) {
			expect(RSV_RESERVATION_STATUS_VALUES).toContain(status)
		}
	})

	it('enforces the per-seating cover cap exactly at 8 and keeps other seatings open', async () => {
		const date = dateAhead(3)
		const exp = await makeExperience({
			date,
			seatings: [H19, H21],
			usesTables: false,
			capSeating: 8,
		})
		const before = await availability(date, 2, exp)
		expect(times(before)).toEqual(['19:00', '21:00'])

		await book(exp, date, H19, 6)
		await book(exp, date, H19, 2)

		expect((await refused(hold(exp, date, H19, 1)))?.code).toBe(
			'slot_unavailable',
		)
		const after = await availability(date, 2, exp)
		expect(times(after)).toEqual(['21:00'])
		expect(after.soldOut.map((s) => s.time)).toEqual(['19:00'])
		await expect(book(exp, date, H21, 2)).resolves.toBeTruthy()

		const db = await getTenantDb(ORG_ID)
		const rows = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.experienceId, exp))
			.all()
		expect(rows.filter((r) => r.localStartMin === H19)).toHaveLength(2)
		expect(rows.every((r) => r.experienceId === exp)).toBe(true)
	})

	it('counts a live hold against the cap before it is booked', async () => {
		const date = dateAhead(4)
		const exp = await makeExperience({
			date,
			seatings: [H19],
			usesTables: false,
			capSeating: 4,
		})
		await hold(exp, date, H19, 4)
		expect((await refused(hold(exp, date, H19, 1)))?.code).toBe(
			'slot_unavailable',
		)
		const db = await getTenantDb(ORG_ID)
		const covers = await loadBookedCoversBySeating(db, {
			experienceId: exp,
			businessDate: date,
			now: Date.now(),
		})
		expect(covers.get(H19)).toBe(4)
	})

	it('binds the per-day cap across seatings', async () => {
		const date = dateAhead(5)
		const exp = await makeExperience({
			date,
			seatings: [H19, H21],
			usesTables: false,
			capSeating: 8,
			capDay: 10,
		})
		await book(exp, date, H19, 6)
		await book(exp, date, H21, 4)
		expect((await refused(hold(exp, date, H19, 1)))?.code).toBe(
			'slot_unavailable',
		)
		expect((await refused(hold(exp, date, H21, 1)))?.code).toBe(
			'slot_unavailable',
		)
		expect(times(await availability(date, 1, exp))).toEqual([])
		// Regular table availability for the same evening is untouched.
		const regular = await availability(date, 2)
		expect(times(regular)).toContain('19:00')
		expect(times(regular)).toContain('20:00')
	})

	it('hides an exclusive window from regular search but not a non-exclusive one', async () => {
		const date = dateAhead(6)
		const e1 = await makeExperience({
			date,
			seatings: [H19],
			exclusive: true,
			turnMin: 60,
			capSeating: 8,
		})
		await makeExperience({
			date,
			seatings: [H20],
			exclusive: false,
			turnMin: 60,
			capSeating: 8,
		})
		const regular = times(await availability(date, 2))
		expect(regular).not.toContain('19:00')
		expect(regular).toContain('20:00')
		// Only the exclusive window's own search can book it.
		expect(times(await availability(date, 2, e1))).toEqual(['19:00'])
		await expect(book(e1, date, H19, 2)).resolves.toBeTruthy()
		// A regular hold cannot reach the hidden window either.
		const db = await getTenantDb(ORG_ID)
		void db
		expect(
			(
				await refused(
					createHold({
						orgId: ORG_ID,
						locationId: PUBLIC_LOC,
						slot: { date, localMin: H19, partySize: 2 },
						tokenHash: 'hash_regular_excl'.padEnd(64, '0'),
						source: 'web',
						ipHash: 'ip_regular_excl',
					}),
				)
			)?.code,
		).toBe('slot_unavailable')
	})

	it('keeps regular and experience pools independent outside the exclusive window', async () => {
		const date = dateAhead(7)
		const e1 = await makeExperience({
			date,
			seatings: [H19],
			exclusive: true,
			turnMin: 60,
			capSeating: 2,
		})
		await book(e1, date, H19, 2)
		await expect(book(e1, date, H19, 1)).rejects.toMatchObject({
			code: 'slot_unavailable',
		})
		const regular = await availability(date, 2)
		expect(times(regular)).toContain('20:00')
		// 17:30 ends exactly when the exclusive window starts; 18:00 would overlap it.
		expect(times(regular)).toContain('17:30')
		expect(times(regular)).not.toContain('18:00')
		const n = nextId()
		await createHold({
			orgId: ORG_ID,
			locationId: PUBLIC_LOC,
			slot: { date, localMin: H20, partySize: 2 },
			tokenHash: `hash_${n}_`.padEnd(64, 'x'),
			source: 'web',
			ipHash: `ip_${n}`,
		})
		const db = await getTenantDb(ORG_ID)
		const holds = await db.select().from(rsvHolds).all()
		const regularHold = holds.find(
			(h) => h.localStartMin === H20 && h.businessDate === date,
		)
		expect(regularHold?.experienceId).toBeNull()
	})

	it('runs a table-less experience as a 20 cover pool with no occupancy rows', async () => {
		const date = dateAhead(8)
		const exp = await makeExperience({
			date,
			seatings: [H19],
			usesTables: false,
			capSeating: 20,
			partyMax: 8,
		})
		const regularBefore = times(await availability(date, 2))
		const ids: string[] = []
		for (const size of [5, 5, 5, 5]) {
			const r = await book(exp, date, H19, size)
			ids.push(r.reservationId)
		}
		expect((await refused(hold(exp, date, H19, 1)))?.code).toBe(
			'slot_unavailable',
		)
		const db = await getTenantDb(ORG_ID)
		const occ = await db.select().from(rsvTableOccupancies).all()
		expect(
			occ.filter((o) => o.reservationId && ids.includes(o.reservationId)),
		).toHaveLength(0)
		const poolHolds = await db
			.select({ id: rsvHolds.id })
			.from(rsvHolds)
			.where(eq(rsvHolds.experienceId, exp))
			.all()
		expect(poolHolds.length).toBeGreaterThanOrEqual(4)
		const holdIds = new Set(poolHolds.map((h) => h.id))
		expect(occ.filter((o) => o.holdId && holdIds.has(o.holdId))).toHaveLength(0)
		expect(times(await availability(date, 2))).toEqual(regularBefore)
	})

	it('draws a table experience only from its areas and service, never other areas', async () => {
		const db = await getTenantDb(ORG_ID)
		await db.insert(rsvAreas).values({
			id: 'area_bar',
			locationId: PUBLIC_LOC,
			name: 'Bar',
			sort: 1,
			onlineBookable: true,
			guestSelectable: true,
		})
		await db.insert(rsvTables).values({
			id: 'tbl_bar_2',
			locationId: PUBLIC_LOC,
			areaId: 'area_bar',
			label: 'B2',
			minCovers: 1,
			maxCovers: 2,
			onlineBookable: true,
			resetBufferMin: 0,
		})
		const date = dateAhead(9)
		const exp = await makeExperience({
			date,
			seatings: [H19, 23 * HOUR],
			areaIds: ['area_bar'],
			serviceId: 'svc_pub_dinner',
			capSeating: 8,
		})
		// 23:00 is after the dinner service: never offered.
		expect(times(await availability(date, 2, exp))).toEqual(['19:00'])

		const first = await book(exp, date, H19, 2)
		const occ = await db
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.reservationId, first.reservationId))
			.all()
		expect(occ.map((o) => o.tableId)).toEqual(['tbl_bar_2'])

		// The bar table is gone; main-room tables are free but off limits.
		expect((await refused(hold(exp, date, H19, 2)))?.code).toBe(
			'slot_unavailable',
		)
		const reservation = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, first.reservationId))
			.get()
		expect(reservation?.serviceId).toBe('svc_pub_dinner')
		expect(reservation?.assignment).toBe('locked')
		// Regular guests still book the main room at the same time.
		const regular = await availability(date, 2)
		expect(times(regular)).toContain('19:00')
	})

	it('never offers or holds a draft or archived experience to guests', async () => {
		const date = dateAhead(11)
		const draft = await makeExperience({
			date,
			seatings: [H19],
			usesTables: false,
			capSeating: 8,
			publish: false,
		})
		await expect(availability(date, 2, draft)).rejects.toMatchObject({
			status: 404,
		})
		expect((await refused(hold(draft, date, H19, 2)))?.code).toBe(
			'slot_unavailable',
		)
		const db = await getTenantDb(ORG_ID)
		await expect(
			getExperienceForBooking(db, {
				locationId: PUBLIC_LOC,
				experienceId: draft,
			}),
		).rejects.toMatchObject({ status: 404 })
	})

	it('archiving keeps existing bookings and their experience id', async () => {
		const date = dateAhead(12)
		const exp = await makeExperience({
			date,
			seatings: [H19],
			usesTables: false,
			capSeating: 8,
		})
		const booked = await book(exp, date, H19, 2)
		const db = await getTenantDb(ORG_ID)
		await archiveExperience(db, {
			orgId: ORG_ID,
			actorId: ACTOR,
			locationId: PUBLIC_LOC,
			experienceId: exp,
		})
		const row = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, booked.reservationId))
			.get()
		expect(row?.experienceId).toBe(exp)
		expect(row?.status).toBe('booked')
		const experience = await db
			.select()
			.from(rsvExperiences)
			.where(eq(rsvExperiences.id, exp))
			.get()
		expect(experience?.status).toBe('archived')
		await expect(availability(date, 2, exp)).rejects.toMatchObject({
			status: 404,
		})
	})

	it('refuses a party outside the experience range', async () => {
		const date = dateAhead(13)
		const exp = await makeExperience({
			date,
			seatings: [H19],
			usesTables: false,
			capSeating: 8,
			partyMax: 4,
		})
		expect((await refused(hold(exp, date, H19, 5)))?.code).toBe(
			'party_size_invalid',
		)
		await expect(availability(date, 5, exp)).rejects.toMatchObject({
			status: 400,
		})
	})

	it('does not let a guest move an experience booking into a regular slot', async () => {
		const date = dateAhead(14)
		const exp = await makeExperience({
			date,
			seatings: [H19],
			usesTables: false,
			capSeating: 8,
		})
		const booked = await book(exp, date, H19, 2)
		await expect(
			guestModifyReservation({
				orgId: ORG_ID,
				reservationId: booked.reservationId,
				input: { localMin: H20 },
			}),
		).rejects.toMatchObject({ status: 409 })
	})
})
