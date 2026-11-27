import crypto from 'node:crypto'
import {
	labelResultSchema,
	prepPlanSchema,
	stationPrepDoneResultSchema,
} from '@repo/inventory'
import {
	invItems,
	invLotTakes,
	invPrepLevels,
	invRecipeLines,
	invRecipes,
	invStockLots,
	printDevices,
	printJobs,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createClockHarness,
	ORG_A,
	ORG_B,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import { createPrinter, recordPoll } from '../services/print-service.ts'
import {
	createStationKit,
	ON,
	STOCK_LOC,
	type Kitchen,
	type StationKit,
} from './pos-inventory-fixture.ts'

/**
 * Prep labels (#523): finishing a prep task prints a label with the made and
 * use-by time through the one cloud print path, the Labels screen prints one
 * for any item, the Arabic name shows when there is one, and a location with
 * no label printer online gets the words back for the tablet's own dialog.
 */

const orgs = vi.hoisted(() => new Map<string, TestOrg>())
const printing = vi.hoisted(() => ({ on: true }))

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(async () => null),
	hasScope: vi.fn(async () => true),
	getStaffingFeatures: vi.fn(async () => null),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../services/pos-service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../services/pos-service.ts')>()),
	checkLocation: vi.fn(async () => 'known' as const),
}))
vi.mock('../lib/print-switches.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/print-switches.ts')>()),
	printingEnabled: vi.fn(async () => printing.on),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`
const USE_BY_ON = { ...ON, useBy: true }

describe('labels on Station', () => {
	let h: ClockHarness
	let kit: StationKit
	let k: Kitchen
	let tablet: Awaited<ReturnType<StationKit['station']>>

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		printing.on = true
		vi.stubEnv('POS_ENABLED', '')
		vi.stubEnv('INVENTORY_ENABLED', '')
		invalidateInventoryContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not found', { status: 404 })),
		)
		h = await createClockHarness([ORG_A, ORG_B])
		kit = createStationKit(h)
		kit.enableInventory(ORG_A, USE_BY_ON)
		kit.enableInventory(ORG_B)
		k = await kit.kitchen(ORG_A)
		tablet = await kit.station(ORG_A)
	})
	afterEach(async () => {
		invalidateInventoryContext()
		vi.unstubAllGlobals()
		await h.cleanup()
	})

	const cashier = (
		method: string,
		path: string,
		options: Parameters<StationKit['request']>[2] = {},
	) =>
		kit.request(method, path, {
			secret: tablet.secret,
			session: tablet.cashier.session,
			...options,
		})

	async function seedSauce(extra: Partial<typeof invItems.$inferInsert> = {}) {
		const db = await h.db(ORG_A)
		await db.insert(invItems).values({
			id: 'label_sauce',
			name: 'Garlic sauce',
			kind: 'made',
			baseUnit: 'ml',
			batchCounted: true,
			trackByDate: true,
			shelfLifeHours: 72,
			storageNote: 'Keep at 4 C',
			nameAr: 'صلصة الثوم',
			...extra,
		})
		await db.insert(invRecipes).values({
			id: 'label_sauce_recipe',
			ownerKind: 'made_item',
			ownerId: 'label_sauce',
			version: 1,
			makesQuantity: 1_000_000,
			effectiveFrom: 1,
			createdByKind: 'system',
		})
		await db.insert(invRecipeLines).values({
			recipeId: 'label_sauce_recipe',
			itemId: k.items.tomato.id,
			quantity: 100_000,
		})
		for (let weekday = 0; weekday < 7; weekday++) {
			await db.insert(invPrepLevels).values({
				itemId: 'label_sauce',
				locationId: STOCK_LOC,
				weekday,
				fillUpToQuantity: 2_000_000,
			})
		}
		return db
	}

	async function labelPrinter(
		routes: { labels?: boolean } = { labels: true },
		online = true,
	) {
		const db = await h.db(ORG_A)
		const created = await createPrinter(
			db,
			ORG_A,
			{
				locationId: STOCK_LOC,
				name: 'Label printer',
				protocol: 'star_cloudprnt',
				widthMm: 58,
				copies: 1,
				routes: {
					kitchen: 'off',
					stationIds: [],
					receipts: false,
					isDefault: false,
					deliveryAddress: false,
					arabicFont: false,
					labels: false,
					...routes,
				},
			},
			'user_manager_1',
		)
		if (online) {
			const [row] = await db.select().from(printDevices)
			await recordPoll(db, row!, { status: 'ok', detail: null })
		}
		return created.printer
	}

	async function startTask() {
		const generated = await cashier('POST', '/pos/inventory/prep/generate', {
			body: { locationId: STOCK_LOC },
		})
		const task = prepPlanSchema.parse(generated.body).tasks[0]!
		const started = await cashier(
			'POST',
			`/pos/inventory/prep/tasks/${task.id}/start`,
			{ body: { expectedVersion: task.version } },
		)
		return { id: task.id, version: started.body.version as number }
	}

	const done = (
		task: { id: string; version: number },
		labels?: { copies?: number; quantityLabel?: string },
	) =>
		cashier('POST', `/pos/inventory/prep/tasks/${task.id}/done`, {
			body: {
				expectedVersion: task.version,
				clientId: uid('done'),
				made: { kind: 'batches', count: 2 },
				...(labels ? { labels } : {}),
			},
		})

	const texts = (payload: any) =>
		(payload.blocks as any[]).map((block) =>
			block.t === 'row' ? `${block.left}|${block.right}` : (block.text ?? ''),
		)

	it('finishing a prep task prints a label with the made and use-by time', async () => {
		await seedSauce()
		const printer = await labelPrinter()
		const task = await startTask()
		const finished = await done(task, { copies: 2, quantityLabel: '2 L' })
		expect(finished.status, finished.raw).toBe(200)
		const result = stationPrepDoneResultSchema.parse(finished.body)
		expect(result.status).toBe('done')
		expect(result.label).toMatchObject({
			printed: true,
			jobs: 1,
			label: { nameEn: 'Garlic sauce', kind: 'made', quantityLabel: '2 L', copies: 2 },
		})
		const label = result.label!.label
		// Use-by is the made time plus the 72 hour shelf life.
		expect(label.useByAt! - label.madeAt).toBe(72 * 3_600_000)
		expect(label.madeAtLabel).toMatch(/^\d{2} \w{3} \d{2}:\d{2}$/)
		expect(label.useByLabel).toMatch(/^\d{2} \w{3} \d{2}:\d{2}$/)

		const db = await h.db(ORG_A)
		const jobs = await db.select().from(printJobs)
		expect(jobs).toHaveLength(1)
		expect(jobs[0]).toMatchObject({
			deviceId: printer.id,
			kind: 'label',
			sourceType: 'label',
			locationId: STOCK_LOC,
		})
		const lines = texts(jobs[0]!.payload)
		expect(lines).toContain(`Made|${label.madeAtLabel}`)
		expect(lines).toContain(`Use by|${label.useByLabel}`)
		expect(lines.some((line) => line.startsWith('By|Cora'))).toBe(true)
		expect(lines).toContain('Qty|2 L')
		expect((jobs[0]!.payload as any).widthMm).toBe(58)
		expect((jobs[0]!.payload as any).copies).toBe(2)
	})

	it('shows the Arabic name when the item has one, and only then', async () => {
		await seedSauce()
		await labelPrinter()
		const withName = await cashier('POST', '/pos/inventory/labels', {
			body: {
				requestId: uid('lbl'),
				locationId: STOCK_LOC,
				itemId: 'label_sauce',
				kind: 'made',
			},
		})
		expect(withName.status, withName.raw).toBe(200)
		expect(labelResultSchema.parse(withName.body).label.nameAr).toBe(
			'صلصة الثوم',
		)
		const plain = await cashier('POST', '/pos/inventory/labels', {
			body: {
				requestId: uid('lbl'),
				locationId: STOCK_LOC,
				itemId: k.items.tomato.id,
				kind: 'opened',
			},
		})
		expect(labelResultSchema.parse(plain.body).label).toMatchObject({
			nameEn: 'Tomatoes',
			nameAr: null,
			kind: 'opened',
			useByAt: null,
			useByLabel: null,
		})
		const db = await h.db(ORG_A)
		const jobs = await db.select().from(printJobs)
		expect(jobs).toHaveLength(2)
		const [arabic, latin] = jobs.sort((a, b) => a.createdAt - b.createdAt)
		expect(texts(arabic!.payload)).toContain('صلصة الثوم')
		expect((arabic!.payload as any).rtl).toBe(true)
		expect(texts(latin!.payload)).not.toContain('صلصة الثوم')
		expect(texts(latin!.payload).some((line) => line.startsWith('Opened|'))).toBe(true)
	})

	it('gives the words back for the tablet when no label printer is online', async () => {
		await seedSauce()
		// A printer that is not marked for labels, and a label printer that never connected.
		await labelPrinter({ labels: false })
		const reply = await cashier('POST', '/pos/inventory/labels', {
			body: {
				requestId: uid('lbl'),
				locationId: STOCK_LOC,
				itemId: 'label_sauce',
				kind: 'made',
			},
		})
		expect(reply.status).toBe(200)
		expect(reply.body).toMatchObject({ printed: false, jobs: 0 })
		expect(reply.body.label.nameEn).toBe('Garlic sauce')
		const db = await h.db(ORG_A)
		expect(await db.select().from(printJobs)).toHaveLength(0)
	})

	it('queues nothing while printing is switched off, and prints a repeat press once', async () => {
		await seedSauce()
		await labelPrinter()
		const body = {
			requestId: uid('lbl'),
			locationId: STOCK_LOC,
			itemId: 'label_sauce',
			kind: 'made',
		}
		await cashier('POST', '/pos/inventory/labels', { body })
		await cashier('POST', '/pos/inventory/labels', { body })
		const db = await h.db(ORG_A)
		expect(await db.select().from(printJobs)).toHaveLength(1)
		printing.on = false
		const off = await cashier('POST', '/pos/inventory/labels', {
			body: { ...body, requestId: uid('lbl') },
		})
		expect(off.body).toMatchObject({ printed: false, jobs: 0 })
		expect(await db.select().from(printJobs)).toHaveLength(1)
	})

	it('a task done without asking for labels prints none', async () => {
		await seedSauce()
		await labelPrinter()
		const task = await startTask()
		const finished = await done(task)
		expect(stationPrepDoneResultSchema.parse(finished.body).label ?? null).toBeNull()
		const db = await h.db(ORG_A)
		expect(await db.select().from(printJobs)).toHaveLength(0)
	})

	it('needs the use-by flag and a known item at this location', async () => {
		await seedSauce()
		const missing = await cashier('POST', '/pos/inventory/labels', {
			body: {
				requestId: uid('lbl'),
				locationId: STOCK_LOC,
				itemId: 'nope',
				kind: 'made',
			},
		})
		expect(missing.status).toBe(404)
		const wrong = await cashier('POST', '/pos/inventory/labels', {
			body: {
				requestId: uid('lbl'),
				locationId: 'loc_elsewhere',
				itemId: 'label_sauce',
				kind: 'made',
			},
		})
		expect(wrong.body).toMatchObject({ error: 'wrong_location' })
		seedInventoryContextForTest(ORG_A, { ...ON, useBy: false })
		const off = await cashier('POST', '/pos/inventory/labels', {
			body: {
				requestId: uid('lbl'),
				locationId: STOCK_LOC,
				itemId: 'label_sauce',
				kind: 'made',
			},
		})
		expect(off.status).toBe(403)
		expect(off.body).toMatchObject({ error: 'inventory_disabled' })
	})

	it('a batch made at the till feeds the item stock by use-by date', async () => {
		const db = await seedSauce()
		const task = await startTask()
		const finished = await done(task)
		expect(finished.status, finished.raw).toBe(200)
		const lots = await db
			.select()
			.from(invStockLots)
			.where(eq(invStockLots.itemId, 'label_sauce'))
		expect(lots).toHaveLength(1)
		expect(lots[0]).toMatchObject({ sourceType: 'batch', quantity: 2_000_000 })
		expect(await db.select().from(invLotTakes)).toHaveLength(0)
	})
})
