import {
	prepLevelsSchema,
	prepPlanSchema,
	prepTaskSchema,
} from '@repo/inventory'
import { addDays, currentBusinessDate, dayOfWeek } from '@repo/reservations'
import {
	destroyTenantDb,
	getTenantDb,
	invMovements,
	invPrepTasks,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import { runInventoryTickForOrg } from '../services/inventory-tick-service.ts'
import { insertPosSale } from '../services/loyalty-test-fixture.ts'
import {
	BASE,
	cid,
	makeClient,
	mintToken,
	READ,
	RECIPE,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Prep: the weekday levels, the day's plan (fill up to, what is on hand, how
 * busy the weekday is, whole batches), what a cook does with a task, and who
 * may see and do what.
 */

const ORG = 'org_inv_prep_a'
const ORG_B = 'org_inv_prep_b'
const LOC = 'loc_prep'

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

let env: ReturnType<typeof setupTenantEnv>
let full: string
let readOnly: string
let prepOff: string
let scoped: string
let tokenB: string
const features = { prep: true, recipes: true }
const today = currentBusinessDate(Date.now(), 'UTC', 240)
const world = { sauce: '', garlic: '' }

beforeAll(async () => {
	env = setupTenantEnv('inv-prep')
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: id,
		})
		await provisionTenantDb(id)
	}
	full = await mintToken(ORG, {
		grants: [READ, UPDATE, RECIPE],
		features,
	})
	readOnly = await mintToken(ORG, {
		scope: 'read',
		grants: [READ],
		features,
	})
	prepOff = await mintToken(ORG, { features: { prep: false, recipes: true } })
	scoped = await mintToken(ORG, { locationIds: ['loc_elsewhere'], features })
	tokenB = await mintToken(ORG_B, { features })

	const garlic = await call('POST', `${BASE}/items`, {
		token: full,
		body: {
			clientId: cid('item'),
			name: 'Garlic',
			category: 'produce',
			kind: 'bought',
			baseUnit: 'g',
		},
	})
	world.garlic = garlic.body.id
	const sauce = await call('POST', `${BASE}/items`, {
		token: full,
		body: {
			clientId: cid('item'),
			name: 'Garlic sauce',
			category: 'sauces',
			kind: 'made',
			baseUnit: 'ml',
		},
	})
	expect(sauce.status, JSON.stringify(sauce.body)).toBe(200)
	world.sauce = sauce.body.id
	// One batch makes 4 L from 400 g of garlic.
	const recipe = await call('PUT', `${BASE}/recipes`, {
		token: full,
		body: {
			ownerKind: 'made_item',
			ownerId: world.sauce,
			expectedVersion: 0,
			makes: { amount: 4, unit: 'l' },
			lines: [{ itemId: world.garlic, amount: 400, unit: 'g' }],
		},
	})
	expect(recipe.status, JSON.stringify(recipe.body)).toBe(200)
	// Garlic stock to make batches from.
	const adjust = await call('POST', `${BASE}/items/${world.garlic}/adjust`, {
		token: full,
		body: {
			clientId: cid('adj'),
			locationId: LOC,
			quantity: 5_000_000,
			reason: 'correction',
		},
	})
	expect(adjust.status, JSON.stringify(adjust.body)).toBe(200)
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

const plan = async (token = full, query = '') =>
	prepPlanSchema.parse(
		(await call('GET', `${BASE}/prep?locationId=${LOC}${query}`, { token }))
			.body,
	)
const generate = (token = full, body: Record<string, unknown> = {}) =>
	call('POST', `${BASE}/prep/generate`, {
		token,
		body: { locationId: LOC, ...body },
	})
async function setLevels(
	weekdays: (number | null)[],
	extra: Record<string, unknown> = {},
) {
	const levels = await call('GET', `${BASE}/prep/levels?locationId=${LOC}`, {
		token: full,
	})
	const item = prepLevelsSchema
		.parse(levels.body)
		.items.find((entry) => entry.itemId === world.sauce)!
	return call('PUT', `${BASE}/prep/levels`, {
		token: full,
		body: {
			locationId: LOC,
			itemId: world.sauce,
			stationId: null,
			weekdays,
			expectedVersion: item.version,
			...extra,
		},
	})
}
const everyDay = (quantity: number | null) =>
	Array.from({ length: 7 }, () => quantity)

describe('prep levels', () => {
	it('lists made items with their weekday levels, the stations and the batch size', async () => {
		const res = await call('GET', `${BASE}/prep/levels?locationId=${LOC}`, {
			token: full,
		})
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const levels = prepLevelsSchema.parse(res.body)
		expect(levels.stations).toEqual([{ id: 'kitchen', name: 'Kitchen' }])
		expect(levels.items).toHaveLength(1)
		expect(levels.items[0]).toMatchObject({
			itemId: world.sauce,
			name: 'Garlic sauce',
			baseUnit: 'ml',
			weekdays: [null, null, null, null, null, null, null],
			usual: null,
			batchSize: 4_000_000,
			version: 0,
		})
	})

	it('saves the weekdays and the station, and refuses a stale version, an unknown station and a bought item', async () => {
		const saved = await setLevels(
			[6_000_000, null, 3_000_000, null, null, null, 8_000_000],
			{ stationId: 'kitchen' },
		)
		expect(saved.status, JSON.stringify(saved.body)).toBe(200)
		expect(saved.body).toMatchObject({
			itemId: world.sauce,
			stationId: 'kitchen',
			weekdays: [6_000_000, null, 3_000_000, null, null, null, 8_000_000],
			version: 1,
		})
		const stale = await call('PUT', `${BASE}/prep/levels`, {
			token: full,
			body: {
				locationId: LOC,
				itemId: world.sauce,
				stationId: null,
				weekdays: everyDay(1_000_000),
				expectedVersion: 0,
			},
		})
		expect(stale.status).toBe(409)
		expect(stale.body.code).toBe('stale_version')
		const unknownStation = await setLevels(everyDay(1_000_000), {
			stationId: 'nowhere',
			expectedVersion: 1,
		})
		expect(unknownStation.status).toBe(400)
		const bought = await call('PUT', `${BASE}/prep/levels`, {
			token: full,
			body: {
				locationId: LOC,
				itemId: world.garlic,
				stationId: null,
				weekdays: everyDay(1_000_000),
				expectedVersion: 0,
			},
		})
		expect(bought.status).toBe(400)
		expect(bought.body.code).toBe('not_a_made_item')
	})
})

describe('the day plan', () => {
	it('is not generated until asked, then plans whole batches up to the weekday level', async () => {
		await setLevels(everyDay(6_000_000))
		const before = await plan()
		expect(before).toMatchObject({
			date: today,
			generated: false,
			canGenerate: true,
			tasks: [],
		})
		const res = await generate()
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const made = prepPlanSchema.parse(res.body)
		expect(made.generated).toBe(true)
		// Fill up to 6 L, nothing on hand, a batch makes 4 L: two batches, 8 L.
		expect(made.tasks).toHaveLength(1)
		expect(made.tasks[0]).toMatchObject({
			itemId: world.sauce,
			itemName: 'Garlic sauce',
			plannedQuantity: 8_000_000,
			batchSize: 4_000_000,
			batches: 2,
			status: 'todo',
			explain: {
				fillUpTo: 6_000_000,
				target: 6_000_000,
				onHand: 0,
				demandBp: 10_000,
			},
		})
		// A second call answers the same and writes no second task.
		const again = prepPlanSchema.parse((await generate()).body)
		expect(again.tasks).toHaveLength(1)
		expect(again.tasks[0]!.id).toBe(made.tasks[0]!.id)
	})

	it('refreshes untouched tasks when stock changes, and drops them when nothing is needed', async () => {
		const adjust = (quantity: number) =>
			call('POST', `${BASE}/items/${world.sauce}/adjust`, {
				token: full,
				body: {
					clientId: cid('adj'),
					locationId: LOC,
					quantity,
					reason: 'correction',
				},
			})
		expect((await adjust(2_000_000)).status).toBe(200)
		const less = prepPlanSchema.parse((await generate()).body)
		// Needs 4 L now: one batch.
		expect(less.tasks[0]).toMatchObject({
			plannedQuantity: 4_000_000,
			batches: 1,
			explain: { onHand: 2_000_000 },
		})
		expect((await adjust(5_000_000)).status).toBe(200)
		const enough = prepPlanSchema.parse((await generate()).body)
		expect(enough).toMatchObject({ generated: true, tasks: [] })
		// Back to normal for the tests that follow.
		expect((await adjust(-7_000_000)).status).toBe(200)
		const back = prepPlanSchema.parse((await generate()).body)
		expect(back.tasks[0]!.plannedQuantity).toBe(8_000_000)
	})

	it('uses the weekday level when one is set, and nudges by how busy the weekday is', async () => {
		const weekday = dayOfWeek(today)
		const levels = everyDay(6_000_000)
		levels[weekday] = 3_000_000
		await setLevels(levels)
		expect(
			prepPlanSchema.parse((await generate()).body).tasks[0]!.explain,
		).toMatchObject({ fillUpTo: 3_000_000, target: 3_000_000 })

		// Four weeks of sales where this weekday sells double.
		const dish = {
			itemId: 'dish_any',
			quantity: 1,
			baseCents: 100,
			options: [],
		}
		for (let n = 1; n <= 28; n++) {
			const date = addDays(today, -n)
			const units = dayOfWeek(date) === weekday ? 20 : 10
			await insertPosSale(ORG, {
				locationId: LOC,
				businessDate: date,
				lines: [{ ...dish, id: `l${n}`, name: 'Dish', quantity: units }],
			})
		}
		const busy = prepPlanSchema.parse((await generate()).body)
		const bp = busy.tasks[0]!.explain.demandBp
		// The weekday sells about 1.8x the mean, capped at 2x: well above normal.
		expect(bp).toBeGreaterThan(15_000)
		expect(busy.demand.known).toBe(true)
		expect(busy.tasks[0]!.explain.target).toBe(
			Math.round((3_000_000 * bp) / 10_000),
		)
	})
})

describe('what a cook does with a task', () => {
	it('starts a task, then done records a batch and closes it, once', async () => {
		await setLevels(everyDay(6_000_000))
		const made = prepPlanSchema.parse((await generate()).body)
		const task = made.tasks[0]!
		const start = await call('POST', `${BASE}/prep/tasks/${task.id}/start`, {
			token: full,
			body: { expectedVersion: task.version },
		})
		expect(start.status, JSON.stringify(start.body)).toBe(200)
		const started = prepTaskSchema.parse(start.body)
		expect(started.status).toBe('in_progress')
		expect(started.startedAt).not.toBeNull()
		// A screen that is behind (someone changed the task): stale.
		const stale = await call('POST', `${BASE}/prep/tasks/${task.id}/skip`, {
			token: full,
			body: { expectedVersion: task.version },
		})
		expect(stale.status).toBe(409)
		expect(stale.body.code).toBe('stale_version')
		// A second tap on Start answers the started task.
		const again = await call('POST', `${BASE}/prep/tasks/${task.id}/start`, {
			token: full,
			body: { expectedVersion: task.version },
		})
		expect(again.status).toBe(200)
		expect(prepTaskSchema.parse(again.body)).toMatchObject({
			status: 'in_progress',
			version: started.version,
		})

		const clientId = cid('done')
		const done = await call('POST', `${BASE}/prep/tasks/${task.id}/done`, {
			token: full,
			body: {
				expectedVersion: started.version,
				clientId,
				made: { kind: 'batches', count: 2 },
			},
		})
		expect(done.status, JSON.stringify(done.body)).toBe(200)
		const finished = prepTaskSchema.parse(done.body)
		expect(finished).toMatchObject({ status: 'done', madeQuantity: 8_000_000 })
		expect(finished.doneAt).not.toBeNull()

		// Stock moved: the sauce went in, the garlic came out.
		const db = await getTenantDb(ORG)
		const sauceMoves = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.itemId, world.sauce))
		expect(sauceMoves.reduce((sum, row) => sum + row.quantity, 0)).toBe(
			8_000_000,
		)
		const garlicMoves = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.itemId, world.garlic))
		// 5 kg adjusted in, two batches of 400 g out.
		expect(garlicMoves.reduce((sum, row) => sum + row.quantity, 0)).toBe(
			5_000_000 - 800_000,
		)
		const [row] = await db
			.select()
			.from(invPrepTasks)
			.where(eq(invPrepTasks.id, task.id))
		expect(row?.batchSourceId).toBeTruthy()

		// A repeat of the same tap answers the first result and moves nothing.
		const repeat = await call('POST', `${BASE}/prep/tasks/${task.id}/done`, {
			token: full,
			body: {
				expectedVersion: started.version,
				clientId,
				made: { kind: 'batches', count: 2 },
			},
		})
		expect(repeat.status).toBe(200)
		expect(
			(
				await db
					.select()
					.from(invMovements)
					.where(eq(invMovements.itemId, world.sauce))
			).length,
		).toBe(sauceMoves.length)
		// A closed task cannot be done or skipped again.
		const closed = await call('POST', `${BASE}/prep/tasks/${task.id}/skip`, {
			token: full,
			body: { expectedVersion: finished.version },
		})
		expect(closed.status).toBe(409)
		expect(closed.body.code).toBe('task_closed')
		// A regenerated plan leaves a done task as it is.
		const after = prepPlanSchema.parse((await generate()).body)
		expect(after.tasks.find((entry) => entry.id === task.id)?.status).toBe(
			'done',
		)
	})

	it('skips a task, and refuses done for an item with no recipe', async () => {
		const db = await getTenantDb(ORG)
		const [row] = await db.select().from(invPrepTasks)
		// The first test left a done task; make another made item with no recipe.
		const plain = await call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name: 'Pickles',
				category: 'sauces',
				kind: 'made',
				baseUnit: 'g',
			},
		})
		const levels = await call('GET', `${BASE}/prep/levels?locationId=${LOC}`, {
			token: full,
		})
		const pickles = prepLevelsSchema
			.parse(levels.body)
			.items.find((entry) => entry.itemId === plain.body.id)!
		await call('PUT', `${BASE}/prep/levels`, {
			token: full,
			body: {
				locationId: LOC,
				itemId: plain.body.id,
				stationId: null,
				weekdays: everyDay(2_000_000),
				expectedVersion: pickles.version,
			},
		})
		const made = prepPlanSchema.parse((await generate()).body)
		const task = made.tasks.find((entry) => entry.itemId === plain.body.id)!
		// Without a recipe there is no batch to round to: the plan is the target.
		expect(task.plannedQuantity).toBe(task.explain.target)
		expect(task.explain.fillUpTo).toBe(2_000_000)
		expect(task.batchSize).toBeNull()
		const noRecipe = await call('POST', `${BASE}/prep/tasks/${task.id}/done`, {
			token: full,
			body: {
				expectedVersion: task.version,
				clientId: cid('done'),
				made: { kind: 'amount', amount: 2, unit: 'kg' },
			},
		})
		expect(noRecipe.status).toBe(409)
		expect(noRecipe.body.code).toBe('recipe_empty')
		// Nothing half-done: the task is as it was.
		const unchanged = await plan()
		expect(unchanged.tasks.find((entry) => entry.id === task.id)?.status).toBe(
			'todo',
		)
		const skip = await call('POST', `${BASE}/prep/tasks/${task.id}/skip`, {
			token: full,
			body: { expectedVersion: task.version },
		})
		expect(skip.status).toBe(200)
		expect(prepTaskSchema.parse(skip.body).status).toBe('skipped')
		expect(row).toBeDefined()
	})
})

describe('access', () => {
	it('lets a read token see the plan and the levels but change nothing', async () => {
		expect(
			(await call('GET', `${BASE}/prep?locationId=${LOC}`, { token: readOnly }))
				.status,
		).toBe(200)
		expect(
			(
				await call('GET', `${BASE}/prep/levels?locationId=${LOC}`, {
					token: readOnly,
				})
			).status,
		).toBe(200)
		expect((await generate(readOnly)).status).toBe(403)
	})

	it('needs the prep flag, a location of the token and the right organization', async () => {
		const off = await call('GET', `${BASE}/prep?locationId=${LOC}`, {
			token: prepOff,
		})
		expect(off.status).toBe(403)
		expect(off.body.code).toBe('feature_disabled')
		const elsewhere = await call('GET', `${BASE}/prep?locationId=${LOC}`, {
			token: scoped,
		})
		expect(elsewhere.status).toBe(403)
		// Another organization has no such task.
		const db = await getTenantDb(ORG)
		const [row] = await db.select().from(invPrepTasks)
		const cross = await call('POST', `${BASE}/prep/tasks/${row!.id}/skip`, {
			token: tokenB,
			body: { expectedVersion: 1 },
		})
		expect(cross.status).toBe(404)
	})

	it('only plans yesterday, today and tomorrow', async () => {
		for (const date of [addDays(today, -2), addDays(today, 2)]) {
			const res = await call(
				'GET',
				`${BASE}/prep?locationId=${LOC}&date=${date}`,
				{ token: full },
			)
			expect(res.status).toBe(400)
		}
		expect(
			(
				await call(
					'GET',
					`${BASE}/prep?locationId=${LOC}&date=${addDays(today, 1)}`,
					{ token: full },
				)
			).status,
		).toBe(200)
	})
})

// Keep the grants import used: the write grant gates prep, the read grant only reads.
void UPDATE

describe('the morning tick', () => {
	afterEach(() => {
		vi.useRealTimers()
		invalidateInventoryContext()
	})

	it('plans the day for a location once, from the morning on', async () => {
		await setLevels(everyDay(6_000_000))
		// Noon UTC on a day nobody planned yet: the location is past 07:00.
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2027-03-10T12:00:00Z'))
		// The flags cache and tokens are checked against the clock too.
		seedInventoryContextForTest(ORG, {
			enabled: true,
			purchasing: false,
			recipes: true,
			prep: true,
			transfers: false,
		})

		const fresh = await mintToken(ORG, {
			grants: [READ, UPDATE, RECIPE],
			features,
		})
		const before = await plan(fresh)
		expect(before).toMatchObject({ date: '2027-03-10', generated: false })
		await runInventoryTickForOrg(ORG, {
			now: Date.now(),
			post: async () => ({ status: 'delivered' }),
		})
		const after = await plan(fresh)
		expect(after.generated).toBe(true)
		// The sauce is stocked from the earlier tests; the pickles still need making.
		expect(after.tasks.length).toBeGreaterThan(0)
		const ids = after.tasks.map((task) => task.id)
		// A second tick plans nothing new.
		await runInventoryTickForOrg(ORG, {
			now: Date.now(),
			post: async () => ({ status: 'delivered' }),
		})
		expect((await plan(fresh)).tasks.map((task) => task.id)).toEqual(ids)
	})
})
