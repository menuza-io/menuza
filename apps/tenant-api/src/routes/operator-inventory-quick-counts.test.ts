import { addDays } from '@repo/reservations'
import {
	countReviewSchema,
	countSheetSchema,
	countSummarySchema,
	inventoryNotifyEventSchema,
	listCountRunsResultSchema,
	listCountSchedulesResultSchema,
	todaySchema,
	type InventoryNotifyEvent,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invCountScheduleRuns,
	invCountSchedules,
	invCounts,
	invMovements,
	provisionTenantDb,
	staffMembers,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { seedInventoryContextForTest } from '../lib/inventory-context.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { computeFoodCost } from '../services/inventory-food-cost.ts'
import { listCountRunsForStaff } from '../services/inventory-count-schedules-service.ts'
import { getToday } from '../services/inventory-today-service.ts'
import { buildStationCatalog } from '../services/pos-inventory-service.ts'
import { runInventoryTickForOrg } from '../services/inventory-tick-service.ts'
import {
	BASE,
	cid,
	makeClient,
	mintToken,
	setupTenantEnv,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Key items and quick counts (#490), and the weekly count plan with its
 * assignees, overdue alert and "not counted lately" filter (#491): the star on
 * an item, a quick count that only corrects what it counted, schedules that
 * apply from tomorrow, the run on Today and on the till, a quick count left
 * open past its next time closed as not finished, an overdue count told once.
 */

const ORG = 'org_inv_quick'
const LOC = 'loc_quick'
const FEATURES = {
	enabled: true,
	purchasing: false,
	recipes: false,
	prep: false,
	transfers: false,
}

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const app = new Hono()
app.route(BASE, operatorInventoryRoutes)
const call = makeClient(app)

const DAY = 24 * 60 * 60 * 1000
const midnight = Math.floor(Date.now() / DAY) * DAY
/** UTC with a 04:00 day start (no zone is known for the location). */
const at = (hour: number, days = 0) => midnight + days * DAY + hour * 3_600_000
const dateOf = (days: number) =>
	new Date(at(12, days)).toISOString().slice(0, 10)

let env: ReturnType<typeof setupTenantEnv>
let sara: string
let omar: string

const world = {
	steak: '',
	saffron: '',
	rice: '',
	walkIn: '',
	listId: '',
}

async function ok(method: string, path: string, token: string, body?: unknown) {
	const res = await call(method, `${BASE}${path}`, { token, body })
	expect(res.status, `${method} ${path} ${JSON.stringify(res.body)}`).toBe(200)
	return res.body
}

const caller = {
	orgId: ORG,
	region: 'us' as const,
	actor: { kind: 'operator' as const, id: 'user_sara' },
	locationIds: null,
	cost: true,
	purchasing: false,
}

const entry = (
	itemId: string,
	amount: number | null,
	unit = 'kg',
	areaId: string | null = null,
) => ({ clientId: cid('e'), itemId, areaId, amount, unit })

beforeAll(async () => {
	env = setupTenantEnv('inv-quick')
	process.env.APP_URL = 'https://app.example.test'
	syncEnvFromProcess()
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	seedInventoryContextForTest(ORG, FEATURES)
	sara = await mintToken(ORG, { subject: 'user_sara' })
	omar = await mintToken(ORG, { subject: 'user_omar' })

	world.walkIn = (
		await ok('POST', '/storage-areas', sara, {
			locationId: LOC,
			name: 'Walk-in',
		})
	).id
	const make = async (name: string) =>
		await ok('POST', '/items', sara, {
			clientId: cid('item'),
			name,
			category: 'other',
			kind: 'bought',
			baseUnit: 'g',
			place: {
				locationId: LOC,
				countUnit: 'kg',
				areaIds: [world.walkIn],
				orderBelowQuantity: null,
				fillUpToQuantity: null,
			},
		})
	world.steak = (await make('Quick steak')).id
	world.saffron = (await make('Quick saffron')).id
	world.rice = (await make('Quick rice')).id
	for (const [itemId, quantity] of [
		[world.steak, 10_000_000],
		[world.saffron, 500_000],
		[world.rice, 20_000_000],
	] as const) {
		await ok('POST', '/deliveries', sara, {
			clientId: cid('del'),
			locationId: LOC,
			supplierId: null,
			currency: 'SAR',
			lines: [{ itemId, quantity, lineTotalMinor: quantity / 1000 }],
		})
	}
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('key items (#490)', () => {
	it('stars an item: it becomes a key item and the stock list filters to key items', async () => {
		for (const id of [world.steak, world.saffron]) {
			const detail = await ok('GET', `/items/${id}?locationId=${LOC}`, sara)
			const updated = await ok(
				'PATCH',
				`/items/${id}?locationId=${LOC}`,
				sara,
				{
					expectedVersion: detail.version,
					isKey: true,
				},
			)
			expect(updated.isKey).toBe(true)
		}
		const keys = await ok('GET', `/items?locationId=${LOC}&key=true`, sara)
		expect(
			keys.items.map((item: { name: string }) => item.name).sort(),
		).toEqual(['Quick saffron', 'Quick steak'])
		const all = await ok('GET', `/items?locationId=${LOC}`, sara)
		expect(all.total).toBe(3)
		expect(
			all.items.find((item: { name: string }) => item.name === 'Quick rice')
				.isKey,
		).toBe(false)
	})
})

describe('quick counts (#490)', () => {
	it('counts only key items, and approving changes only the counted items', async () => {
		const started = countSummarySchema.parse(
			await ok('POST', '/counts', sara, {
				clientId: cid('count'),
				locationId: LOC,
				listId: null,
				kind: 'quick',
			}),
		)
		expect(started).toMatchObject({ kind: 'quick', itemTotal: 2 })

		// A full count is its own count: both can be open together.
		const full = countSummarySchema.parse(
			await ok('POST', '/counts', sara, {
				clientId: cid('count'),
				locationId: LOC,
				listId: null,
			}),
		)
		expect(full).toMatchObject({ kind: 'full', itemTotal: 3 })
		await ok('POST', `/counts/${full.id}/cancel`, sara, {
			expectedVersion: full.version,
		})
		// A second quick count while one is being counted is refused.
		const again = await call('POST', `${BASE}/counts`, {
			token: omar,
			body: {
				clientId: cid('count'),
				locationId: LOC,
				listId: null,
				kind: 'quick',
			},
		})
		expect(again.status).toBe(409)
		expect(again.body).toMatchObject({
			code: 'count_in_progress',
			countId: started.id,
		})

		const sheet = countSheetSchema.parse(
			await ok('GET', `/counts/${started.id}`, sara),
		)
		const names = sheet.areas.flatMap((area) =>
			area.items.map((item) => item.name),
		)
		expect(names.sort()).toEqual(['Quick saffron', 'Quick steak'])
		expect(
			sheet.areas.flatMap((area) => area.items).every((i) => i.isKey),
		).toBe(true)

		// Steak counted at 9 kg (10 on hand); saffron not counted at all.
		await ok('POST', `/counts/${started.id}/entries`, sara, {
			entries: [entry(world.steak, 9, 'kg', world.walkIn)],
		})
		const sent = await ok('POST', `/counts/${started.id}/send`, sara, {
			expectedVersion: started.version,
		})
		const review = countReviewSchema.parse(
			await ok('GET', `/counts/${started.id}/review`, sara),
		)
		expect(review.notCounted).toBe(1)
		// The money gap of the key items since the last count is shown.
		expect(review.keyDifferenceValueMinor).toBe(-1000)
		const approved = await ok('POST', `/counts/${started.id}/approve`, sara, {
			expectedVersion: sent.version,
		})
		expect(approved.adjustedItems).toBe(1)

		const db = await getTenantDb(ORG)
		const onHand = async (itemId: string) =>
			(
				await db
					.select()
					.from(invMovements)
					.where(
						and(
							eq(invMovements.itemId, itemId),
							eq(invMovements.locationId, LOC),
						),
					)
			).reduce((sum, row) => sum + row.quantity, 0)
		expect(await onHand(world.steak)).toBe(9_000_000)
		expect(await onHand(world.saffron)).toBe(500_000)
		expect(await onHand(world.rice)).toBe(20_000_000)

		// Food cost still uses full counts: one approved quick count is no period.
		expect(
			(await computeFoodCost(db, { locationId: LOC, targetBp: 3000 })).state,
		).toBe('need_two_counts')
	})
})

describe('count schedules and the weekly plan (#490, #491)', () => {
	let scheduleId = ''

	it('creates a quick count at close with an assignee; it applies from tomorrow', async () => {
		const created = await ok('POST', '/count-schedules', sara, {
			clientId: cid('sched'),
			locationId: LOC,
			kind: 'quick',
			listId: null,
			slot: 'close',
			timeLocal: '22:00',
			weekdays: [0, 1, 2, 3, 4, 5, 6],
			assignee: { kind: 'member', id: 'user_omar' },
		})
		scheduleId = created.id
		expect(created).toMatchObject({
			kind: 'quick',
			slot: 'close',
			timeLocal: '22:00',
			assignee: { kind: 'member', id: 'user_omar' },
		})
		const listed = listCountSchedulesResultSchema.parse(
			await ok('GET', `/count-schedules?locationId=${LOC}`, sara),
		)
		expect(listed.schedules).toHaveLength(1)

		const today = listCountRunsResultSchema.parse(
			await ok('GET', `/count-runs?locationId=${LOC}`, sara),
		)
		expect(today.runs).toEqual([])
		const tomorrow = listCountRunsResultSchema.parse(
			await ok(
				'GET',
				`/count-runs?locationId=${LOC}&date=${addDays(today.date, 1)}`,
				sara,
			),
		)
		expect(tomorrow.runs).toHaveLength(1)
		expect(tomorrow.runs[0]).toMatchObject({
			kind: 'quick',
			slot: 'close',
			status: 'due',
			assignee: { kind: 'member', id: 'user_omar' },
		})
	})

	it('shows the close count on Today at its set time, with the person responsible', async () => {
		const db = await getTenantDb(ORG)
		const tomorrow = dateOf(1)
		const early = todaySchema.parse(
			await getToday(db, {
				locationId: LOC,
				caller,
				now: at(21, 1),
			}),
		)
		expect(early.date).toBe(tomorrow)
		expect(early.attention.some((a) => a.kind === 'scheduled_count_due')).toBe(
			false,
		)
		const due = todaySchema.parse(
			await getToday(db, { locationId: LOC, caller, now: at(22, 1) + 60_000 }),
		)
		expect(
			due.attention.find((a) => a.kind === 'scheduled_count_due'),
		).toMatchObject({
			countKind: 'quick',
			slot: 'close',
			assignee: { kind: 'member', id: 'user_omar' },
			late: false,
			dueAt: at(22, 1),
		})
		// The week ahead lists it too.
		expect(
			due.week.filter((w) => w.kind === 'count' && w.countKind === 'quick')
				.length,
		).toBeGreaterThanOrEqual(1)
	})

	it('shows the count on the till at its time and to its assignee (Station catalog, my schedule)', async () => {
		const db = await getTenantDb(ORG)
		// A staff member who is also the member "user_omar" (the roster keeps the login id).
		await db.insert(staffMembers).values({
			id: 'staff_omar',
			firstName: 'Omar',
			lastName: 'Test',
			userId: 'user_omar',
		})
		const catalog = await buildStationCatalog(db, {
			orgId: ORG,
			region: 'us',
			locationId: LOC,
			deviceId: 'dev_quick',
			ordersEnabled: false,
			anyStaffCanReceive: false,
			now: at(22, 1) + 60_000,
		})
		expect(catalog.dueCounts).toHaveLength(1)
		expect(catalog.dueCounts![0]).toMatchObject({
			kind: 'quick',
			slot: 'close',
			assignee: { kind: 'member', id: 'user_omar' },
			late: false,
		})
		expect(catalog.items.find((item) => item.id === world.steak)?.isKey).toBe(
			true,
		)

		// ...and sees it on "my schedule".
		const mine = await listCountRunsForStaff(db, {
			staffId: 'staff_omar',
			userId: 'user_omar',
			now: at(22, 1) + 60_000,
		})
		expect(mine.map((run) => run.kind)).toContain('quick')
		expect(mine[0]).toMatchObject({
			assignee: { kind: 'member', id: 'user_omar' },
		})
		const someoneElse = await listCountRunsForStaff(db, {
			staffId: 'staff_other',
			userId: null,
			now: at(22, 1) + 60_000,
		})
		expect(someoneElse).toEqual([])
		// The till is told which staff member the member assignee is.
		expect(catalog.dueCounts![0]!.assigneeStaffId).toBe('staff_omar')
	})

	it('applies a plan change from tomorrow: the day already planned keeps its assignee', async () => {
		const db = await getTenantDb(ORG)
		// Today's run is stored first, then the plan changes.
		const before = await ok('GET', `/count-schedules?locationId=${LOC}`, sara)
		const patched = await ok('PATCH', `/count-schedules/${scheduleId}`, sara, {
			expectedVersion: before.schedules[0].version,
			assignee: { kind: 'member', id: 'user_sara' },
			timeLocal: '23:00',
		})
		expect(patched.effectiveFrom).toBe(
			addDays((await ok('GET', `/count-runs?locationId=${LOC}`, sara)).date, 1),
		)
		expect(patched.assignee).toEqual({ kind: 'member', id: 'user_sara' })
		// Stale versions are refused.
		const stale = await call('PATCH', `${BASE}/count-schedules/${scheduleId}`, {
			token: sara,
			body: {
				expectedVersion: before.schedules[0].version,
				timeLocal: '21:00',
			},
		})
		expect(stale.status).toBe(409)
		void db
	})

	it('a count started for a due run claims it, and a started run never alerts', async () => {
		const db = await getTenantDb(ORG)
		const today = dateOf(0)
		const businessToday = (
			await ok('GET', `/count-runs?locationId=${LOC}`, sara)
		).date as string
		void today
		await db.insert(invCountSchedules).values({
			id: 'sched_today',
			locationId: LOC,
			kind: 'full',
			listId: null,
			slot: 'opening',
			timeLocal: '05:00',
			weekdays: [0, 1, 2, 3, 4, 5, 6],
			assigneeKind: 'staff',
			assigneeId: 'staff_omar',
			effectiveFrom: businessToday,
		})
		const full = countSummarySchema.parse(
			await ok('POST', '/counts', sara, {
				clientId: cid('count'),
				locationId: LOC,
				listId: null,
			}),
		)
		const claimed = await db
			.select()
			.from(invCountScheduleRuns)
			.where(eq(invCountScheduleRuns.scheduleId, 'sched_today'))
			.get()
		expect(claimed).toMatchObject({
			status: 'started',
			countId: full.id,
			assigneeKind: 'staff',
			assigneeId: 'staff_omar',
		})
		expect(full.scheduleRunId).toBe(claimed!.id)
		await ok('POST', `/counts/${full.id}/cancel`, sara, {
			expectedVersion: full.version,
		})
		// Enough of this schedule: later steps look only at the close count.
		await db
			.update(invCountSchedules)
			.set({ archivedAt: Date.now() })
			.where(eq(invCountSchedules.id, 'sched_today'))
	})

	it('tells the manager once when a count is not started an hour after it was due', async () => {
		const events: InventoryNotifyEvent[] = []
		const post = vi.fn(async (event: InventoryNotifyEvent) => {
			events.push(event)
			return { status: 'delivered' as const }
		})
		// 23:00 tomorrow: the close count (changed to 23:00 from tomorrow) was due.
		const tomorrow = dateOf(1)
		void tomorrow
		const db = await getTenantDb(ORG)
		const runs = await db.select().from(invCountScheduleRuns)
		expect(runs.length).toBeGreaterThanOrEqual(1)

		// Half an hour after the 23:00 due time: not yet.
		let result = await runInventoryTickForOrg(ORG, {
			now: at(23, 1) + 30 * 60_000,
			post,
		})
		expect(result.countOverdueAlerts).toBe(0)
		expect(events).toEqual([])
		// An hour after: told once.
		result = await runInventoryTickForOrg(ORG, {
			now: at(24, 1) + 5 * 60_000,
			post,
		})
		const overdue = events.filter((e) => e.kind === 'inventory_count_overdue')
		expect(overdue).toHaveLength(1)
		expect(inventoryNotifyEventSchema.parse(overdue[0])).toMatchObject({
			kind: 'inventory_count_overdue',
			locationId: LOC,
			countOverdue: {
				countKind: 'quick',
				slot: 'close',
				assigneeKind: 'member',
				assigneeId: 'user_sara',
			},
		})
		expect(JSON.stringify(overdue[0])).not.toMatch(/name|phone|amount/i)
		// A later tick never tells again for the same count.
		await runInventoryTickForOrg(ORG, { now: at(26, 1), post })
		expect(
			events.filter((e) => e.kind === 'inventory_count_overdue'),
		).toHaveLength(1)
	})

	it('closes a quick count left open past its next scheduled time as not finished, never merged', async () => {
		const db = await getTenantDb(ORG)
		const quick = countSummarySchema.parse(
			await ok('POST', '/counts', sara, {
				clientId: cid('count'),
				locationId: LOC,
				listId: null,
				kind: 'quick',
			}),
		)
		await ok('POST', `/counts/${quick.id}/entries`, sara, {
			entries: [entry(world.saffron, 0.1, 'kg', world.walkIn)],
		})
		const post = vi.fn(async () => ({ status: 'delivered' as const }))
		const result = await runInventoryTickForOrg(ORG, {
			now: at(23, 3),
			post,
		})
		expect(result.countsNotFinished).toBe(1)
		const row = await db
			.select()
			.from(invCounts)
			.where(eq(invCounts.id, quick.id))
			.get()
		expect(row?.status).toBe('cancelled')
		// Nothing was merged into stock.
		const moves = await db
			.select()
			.from(invMovements)
			.where(
				and(
					eq(invMovements.sourceType, 'count'),
					eq(invMovements.sourceId, quick.id),
				),
			)
		expect(moves).toEqual([])
	})
})

describe('items not counted lately (#491)', () => {
	it('filters items not counted in 14 days and Today counts them', async () => {
		// The quick count approved above counted steak; saffron and rice never were
		// (the saffron entry went into a count closed as not finished).
		const stale = await ok(
			'GET',
			`/items?locationId=${LOC}&notCounted=true`,
			sara,
		)
		expect(
			stale.items.map((item: { name: string }) => item.name).sort(),
		).toEqual(['Quick rice', 'Quick saffron'])
		const counted = await ok('GET', `/items?locationId=${LOC}`, sara)
		const steak = counted.items.find(
			(item: { name: string }) => item.name === 'Quick steak',
		)
		expect(steak.lastCountedAt).toEqual(expect.any(Number))

		const db = await getTenantDb(ORG)
		// Far in the future everything is over 14 days.
		const today = todaySchema.parse(
			await getToday(db, { locationId: LOC, caller, now: at(12, 20) }),
		)
		expect(today.metrics.notCountedItems).toBe(3)
		const now = todaySchema.parse(
			await getToday(db, { locationId: LOC, caller, now: Date.now() }),
		)
		expect(now.metrics.notCountedItems).toBe(2)
	})
})
