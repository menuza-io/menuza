import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvAreas,
	rsvBlocks,
	rsvLocationSettings,
	rsvServices,
	rsvTables,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getOperatorAvailability } from './rsv-day-feed-service.ts'

const ORG = 'org_op_availability'
const LOC = 'loc_opav'
let tempDir: string

// A date a few days ahead so the host search never skips slots as past.
const DAY_MS = 86_400_000
const DATE = new Date(Date.now() + 5 * DAY_MS).toISOString().slice(0, 10)
const at = (hhmm: string) => Date.parse(`${DATE}T${hhmm}:00Z`)

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-opav-'))
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
	await db.insert(rsvAreas).values([
		{ id: 'area_solo', locationId: LOC, name: 'Solo', sort: 0 },
		{ id: 'area_room', locationId: LOC, name: 'Room', sort: 1 },
	])
	await db.insert(rsvTables).values([
		{
			id: 'tbl_solo',
			locationId: LOC,
			areaId: 'area_solo',
			label: 'S1',
			minCovers: 1,
			maxCovers: 4,
			resetBufferMin: 0,
		},
		{
			id: 'tbl_room_1',
			locationId: LOC,
			areaId: 'area_room',
			label: 'R1',
			minCovers: 1,
			maxCovers: 4,
			resetBufferMin: 0,
		},
		{
			id: 'tbl_room_2',
			locationId: LOC,
			areaId: 'area_room',
			label: 'R2',
			minCovers: 1,
			maxCovers: 4,
			resetBufferMin: 0,
		},
	])
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
	rmSync(tempDir, { recursive: true, force: true })
})

async function slots(areaId: string) {
	const db = await getTenantDb(ORG)
	const avail = await getOperatorAvailability(db, LOC, {
		date: DATE,
		partySize: 2,
		serviceId: 'svc_dinner',
		areaId,
	})
	return avail
}

const free = (a: Awaited<ReturnType<typeof slots>>) =>
	a.slots.filter((s) => s.available).map((s) => s.time)

describe('getOperatorAvailability goes through the public engine', () => {
	it('opens every seating when nothing blocks (control)', async () => {
		const avail = await slots('area_solo')
		expect(free(avail)).toContain('19:00')
		expect(
			avail.slots.find((s) => s.time === '19:00')!.suggestedTableIds,
		).toEqual(['tbl_solo'])
		expect(avail).toMatchObject({ closed: false, onlineClosed: false })
	})

	it('a table block removes the slots it overlaps', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvBlocks).values({
			id: 'blk_table',
			locationId: LOC,
			tableId: 'tbl_solo',
			businessDate: DATE,
			startAt: at('19:00'),
			endAt: at('20:00'),
		})
		const avail = await slots('area_solo')
		const open = free(avail)
		expect(open).not.toContain('19:00')
		expect(open).not.toContain('19:30')
		expect(open).toContain('17:00')
		expect(open).toContain('21:00')
		expect(avail.slots.find((s) => s.time === '19:00')).toMatchObject({
			available: false,
			suggestedTableIds: [],
		})
	})

	it('a room-wide block removes the slots of every table in the room', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvBlocks).values({
			id: 'blk_room',
			locationId: LOC,
			areaId: 'area_room',
			businessDate: DATE,
			startAt: at('19:00'),
			endAt: at('20:00'),
		})
		const room = free(await slots('area_room'))
		expect(room).not.toContain('19:00')
		expect(room).not.toContain('19:30')
		expect(room).toContain('17:00')
		// Another room is unaffected.
		expect(free(await slots('area_solo'))).toContain('19:00')
	})
})
