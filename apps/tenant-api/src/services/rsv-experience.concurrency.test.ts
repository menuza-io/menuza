import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	rsvHolds,
	rsvReservations,
	rsvTableOccupancies,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
	dateAhead,
	PUBLIC_LOC,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import {
	createExperience,
	createExperienceSchedule,
	publishExperience,
} from './rsv-experience-service.ts'
import { createHold } from './rsv-hold-service.ts'
import { bookFromHold } from './rsv-public-booking-service.ts'

const TEST_DIR = fs.mkdtempSync(
	path.join(os.tmpdir(), 'rsv-experience-concurrency-test-'),
)
process.env.TENANT_DB_DIR = TEST_DIR

const ORG_ID = 'org_rsv_experience_race'
const DAY = dateAhead(12)
const H19 = 19 * 60

const token = (n: string | number) => `hash_${n}_`.padEnd(64, 'x')

async function publishedExperience(
	slug: string,
	usesTables: boolean,
	cap: number,
) {
	const db = await getTenantDb(ORG_ID)
	const base = { orgId: ORG_ID, actorId: 'usr_race', locationId: PUBLIC_LOC }
	const created = await createExperience(db, {
		...base,
		input: {
			slug,
			kind: 'ticketed',
			nameI18n: { en: slug },
			priceMinor: null,
			pricePerCover: true,
			partyMin: 1,
			partyMax: 8,
			usesTables,
			exclusive: false,
			sort: 0,
		},
	})
	await createExperienceSchedule(db, {
		...base,
		experienceId: created.id,
		input: {
			fromDate: DAY,
			toDate: DAY,
			daysMask: 127,
			seatingMins: [H19],
			turnMin: 90,
			coversCapPerSeating: cap,
			areaIds: null,
			serviceId: null,
		},
	})
	await publishExperience(db, { ...base, experienceId: created.id })
	return created.id
}

function holdFor(experienceId: string, key: string, partySize = 2) {
	return createHold({
		orgId: ORG_ID,
		locationId: PUBLIC_LOC,
		slot: { date: DAY, localMin: H19, partySize },
		experienceId,
		tokenHash: token(key),
		source: 'web',
		ipHash: `ip_${key}`,
	})
}

describe('Experience cap races on a real SQLite file', () => {
	beforeAll(async () => {
		await seedPublicOrg(ORG_ID, { seedContext: false })
	})
	afterAll(async () => {
		await destroyTenantDb(ORG_ID)
		fs.rmSync(TEST_DIR, { recursive: true, force: true })
	})

	it('never oversells a cover-capped pool under 20 concurrent holds', async () => {
		const exp = await publishedExperience('pool-race', false, 8)
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				holdFor(exp, `pool_${i}`).then(
					() => 'ok' as const,
					(error: { status?: number; code?: string }) => error,
				),
			),
		)
		const winners = results.filter((r) => r === 'ok')
		expect(winners).toHaveLength(4)
		for (const loser of results.filter((r) => r !== 'ok') as Array<{
			status?: number
			code?: string
		}>) {
			expect(loser.status).toBe(409)
			expect(loser.code).toBe('slot_unavailable')
		}
		const db = await getTenantDb(ORG_ID)
		const live = await db
			.select()
			.from(rsvHolds)
			.where(and(eq(rsvHolds.experienceId, exp), eq(rsvHolds.status, 'active')))
			.all()
		expect(live.reduce((sum, h) => sum + h.partySize, 0)).toBe(8)
	})

	it('books held covers once and keeps the cap when holds convert concurrently', async () => {
		const exp = await publishedExperience('pool-convert', false, 6)
		const keys = [0, 1, 2]
		await Promise.all(keys.map((i) => holdFor(exp, `conv_${i}`)))
		// A fourth hold is refused: three live holds already use the cap.
		await expect(holdFor(exp, 'conv_extra')).rejects.toMatchObject({
			code: 'slot_unavailable',
		})
		const booked = await Promise.all(
			keys.map((i) =>
				bookFromHold({
					orgId: ORG_ID,
					holdTokenHash: token(`conv_${i}`),
					input: {
						guest: {
							firstName: `Conv${i}`,
							lastName: 'Guest',
							phone: `+1415557${String(2000 + i)}`,
							email: null,
							locale: 'en',
						},
						smsOptIn: false,
						marketing: false,
					},
					client: 'web',
					channel: 'online',
					customerId: null,
					ipHash: `ip_conv_${i}`,
					idempotencyKey: `conv-key-${i}-abcdefghij`,
					requestHash: `req_conv_${i}`,
				}),
			),
		)
		expect(new Set(booked.map((b) => b.reservationId)).size).toBe(3)
		const db = await getTenantDb(ORG_ID)
		const rows = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.experienceId, exp))
			.all()
		expect(rows.reduce((sum, r) => sum + r.partySize, 0)).toBe(6)
		await expect(holdFor(exp, 'conv_after')).rejects.toMatchObject({
			code: 'slot_unavailable',
		})
	})

	it('gives a table experience the last fitting table to exactly one of ten holds', async () => {
		const exp = await publishedExperience('tables-race', true, 40)
		const results = await Promise.all(
			Array.from({ length: 10 }, (_, i) =>
				holdFor(exp, `tbl_${i}`, 2).then(
					() => 'ok' as const,
					(error: { code?: string }) => error,
				),
			),
		)
		const winners = results.filter((r) => r === 'ok').length
		// Only the 2-top seats a party of two (the 4 and 12 tops have higher minimums).
		expect(winners).toBe(1)
		const db = await getTenantDb(ORG_ID)
		const occ = await db
			.select()
			.from(rsvTableOccupancies)
			.where(eq(rsvTableOccupancies.active, true))
			.all()
		const perTable = new Map<string, number>()
		for (const o of occ.filter((row) => row.holdId)) {
			perTable.set(o.tableId, (perTable.get(o.tableId) ?? 0) + 1)
		}
		const expHolds = await db
			.select({ id: rsvHolds.id })
			.from(rsvHolds)
			.where(eq(rsvHolds.experienceId, exp))
			.all()
		expect(expHolds).toHaveLength(1)
		expect(perTable.get('tbl_pub_2')).toBe(1)
		expect(perTable.size).toBe(1)
	})
})
