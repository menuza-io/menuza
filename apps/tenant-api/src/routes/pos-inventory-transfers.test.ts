import crypto from 'node:crypto'
import {
	stationCatalogSchema,
	stationLogDishWasteResultSchema,
	stationTransferResultSchema,
	transferDetailSchema,
} from '@repo/inventory'
import {
	invRecipeLines,
	invRecipes,
	invMovements,
	invWaste,
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
import { invalidateInventoryContext } from '../lib/inventory-context.ts'
import { BASE, makeClient } from './inventory-test-utils.ts'
import {
	createStationKit,
	mintInventoryOperator,
	moneyKeys,
	ON,
	STOCK_LOC,
	type Kitchen,
	type StationKit,
} from './pos-inventory-fixture.ts'

/**
 * Transfers on the Station Stock app (#515) and a whole dish as waste from its
 * picker (#517): the lists come in the catalogue, send and receive go through
 * idempotent routes behind the till manager rule, a short line is missing in
 * transit and the App sees it received, no answer carries a price, a branch
 * only asks for what the sender offers (#526), and a dish is logged and undone
 * as a group.
 */

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

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
const CENTRAL = 'loc_central_kitchen'

describe('/pos/inventory transfers and dish waste', () => {
	let h: ClockHarness
	let kit: StationKit
	let k: Kitchen
	let tablet: Awaited<ReturnType<StationKit['station']>>
	let operator: string
	let call: ReturnType<typeof makeClient>

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		vi.stubEnv('POS_ENABLED', '')
		vi.stubEnv('INVENTORY_ENABLED', '')
		invalidateInventoryContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not found', { status: 404 })),
		)
		h = await createClockHarness([ORG_A, ORG_B])
		kit = createStationKit(h)
		kit.enableInventory(ORG_A, { ...ON, transfers: true, recipes: true })
		kit.enableInventory(ORG_B)
		k = await kit.kitchen(ORG_A)
		tablet = await kit.station(ORG_A)
		operator = await mintInventoryOperator(ORG_A, {
			features: { transfers: true, recipes: true },
		})
		call = makeClient(h.app)
	})
	afterEach(async () => {
		invalidateInventoryContext()
		vi.unstubAllGlobals()
		await h.cleanup()
	})

	const as =
		(who: 'cashier' | 'manager' = 'cashier') =>
		(
			method: string,
			path: string,
			options: Parameters<StationKit['request']>[2] = {},
		) =>
			kit.request(method, path, {
				secret: tablet.secret,
				session: tablet[who].session,
				...options,
			})
	const cashier = as('cashier')
	const manager = as('manager')
	const op = (method: string, path: string, body?: unknown) =>
		call(method, `${BASE}${path}`, { token: operator, body })

	const line = (itemId: string, amount: number, unit = 'kg') => ({
		itemId,
		amount,
		unit,
	})

	/** The office plans a transfer, sends it, and the tablet's catalogue lists it. */
	async function office(
		kind: 'transfer' | 'request',
		from: string,
		to: string,
	) {
		const made = await op('POST', '/transfers', {
			clientId: uid('t'),
			kind,
			fromLocationId: from,
			toLocationId: to,
			lines: [line(k.items.tomato.id, 2), line(k.items.chicken.id, 1)],
		})
		expect(made.status, JSON.stringify(made.body)).toBe(200)
		return transferDetailSchema.parse(made.body)
	}

	const catalog = async () => {
		const reply = await manager(
			'GET',
			`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
		)
		expect(reply.status, reply.raw).toBe(200)
		return { reply, catalog: stationCatalogSchema.parse(reply.body) }
	}

	const stockAt = async (itemId: string, locationId: string) => {
		const db = await h.db(ORG_A)
		const rows = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.itemId, itemId))
		return rows
			.filter((row) => row.locationId === locationId)
			.reduce((sum, row) => sum + row.quantity, 0)
	}

	it('lists transfers in the catalogue with quantities only, and a branch receives one: the App shows it received, a short line is missing in transit', async () => {
		const planned = await office('transfer', CENTRAL, STOCK_LOC)
		const sent = await op('POST', `/transfers/${planned.id}/send`, {
			expectedVersion: planned.version,
		})
		expect(sent.status, JSON.stringify(sent.body)).toBe(200)
		const onTheWay = transferDetailSchema.parse(sent.body)

		const { reply, catalog: cat } = await catalog()
		expect(cat.settings.transfersEnabled).toBe(true)
		const listed = cat.transfers!.find((t) => t.id === planned.id)!
		expect(listed).toMatchObject({
			status: 'sent',
			fromLocationId: CENTRAL,
			toLocationId: STOCK_LOC,
			version: onTheWay.version,
		})
		expect(listed.lines.map((l) => [l.itemName, l.sentQuantity])).toEqual([
			['Tomatoes', 2_000_000],
			['Chicken thigh', 1_000_000],
		])
		// No price, value, cost or on-hand figure anywhere in the catalogue.
		expect(moneyKeys(reply.body)).toEqual([])
		expect(JSON.stringify(reply.body)).not.toMatch(/onHandAtSender/)

		// A cashier may not receive: the same till manager rule as deliveries.
		const refused = await cashier(
			'POST',
			`/pos/inventory/transfers/${planned.id}/receive`,
			{
				body: {
					clientId: uid('r'),
					locationId: STOCK_LOC,
					expectedVersion: onTheWay.version,
				},
			},
		)
		expect([refused.status, refused.body.error]).toEqual([
			403,
			'receive_needs_manager',
		])

		// The manager ticks what arrived: 1.5 of the 2 kg tomatoes, all the chicken.
		const clientId = uid('r')
		const body = {
			clientId,
			locationId: STOCK_LOC,
			expectedVersion: onTheWay.version,
			lines: [line(k.items.tomato.id, 1.5), line(k.items.chicken.id, 1)],
		}
		const received = await manager(
			'POST',
			`/pos/inventory/transfers/${planned.id}/receive`,
			{ body },
		)
		expect(received.status, received.raw).toBe(200)
		expect(stationTransferResultSchema.parse(received.body)).toMatchObject({
			id: planned.id,
			status: 'received',
			missingLines: 1,
			duplicate: false,
		})
		expect(moneyKeys(received.body)).toEqual([])

		// The App sees it received, with half a kilo missing in transit.
		const office2 = transferDetailSchema.parse(
			(await op('GET', `/transfers/${planned.id}`)).body,
		)
		expect(office2.status).toBe('received')
		expect(office2.missingLines).toBe(1)
		expect(office2.lines.find((l) => l.itemName === 'Tomatoes')).toMatchObject({
			sentQuantity: 2_000_000,
			receivedQuantity: 1_500_000,
			missingQuantity: 500_000,
		})
		expect(await stockAt(k.items.tomato.id, STOCK_LOC)).toBe(1_500_000)

		// The tablet's retry after a lost answer is the same answer and no second movement.
		const again = await manager(
			'POST',
			`/pos/inventory/transfers/${planned.id}/receive`,
			{ body },
		)
		expect(again.status, again.raw).toBe(200)
		expect(again.body).toMatchObject({ id: planned.id, duplicate: true })
		expect(await stockAt(k.items.tomato.id, STOCK_LOC)).toBe(1_500_000)

		// It leaves the open lists; the catalogue still shows it, finished, for two days.
		const after = (await catalog()).catalog.transfers!.find(
			(t) => t.id === planned.id,
		)!
		expect(after.status).toBe('received')
		expect(
			after.lines.find((l) => l.itemName === 'Tomatoes')!.missingQuantity,
		).toBe(500_000)
	})

	it('sends from the tablet, and a send that conflicts with an App edit is refused as stale', async () => {
		const planned = await office('transfer', STOCK_LOC, CENTRAL)
		// The App edits the planned transfer after the tablet read it.
		const edited = await op('PATCH', `/transfers/${planned.id}`, {
			expectedVersion: planned.version,
			lines: [line(k.items.tomato.id, 1)],
		})
		expect(edited.status, JSON.stringify(edited.body)).toBe(200)

		const stale = await manager(
			'POST',
			`/pos/inventory/transfers/${planned.id}/send`,
			{
				body: {
					clientId: uid('s'),
					locationId: STOCK_LOC,
					expectedVersion: planned.version,
				},
			},
		)
		expect([stale.status, stale.body.error]).toEqual([409, 'stale_version'])
		expect(await stockAt(k.items.tomato.id, STOCK_LOC)).toBe(0)

		// With what it read now, the send goes through and fixes the quantities.
		const fresh = transferDetailSchema.parse(edited.body)
		const sent = await manager(
			'POST',
			`/pos/inventory/transfers/${planned.id}/send`,
			{
				body: {
					clientId: uid('s'),
					locationId: STOCK_LOC,
					expectedVersion: fresh.version,
					lines: [line(k.items.tomato.id, 0.5)],
				},
			},
		)
		expect(sent.status, sent.raw).toBe(200)
		expect(sent.body).toMatchObject({ status: 'sent' })
		expect(await stockAt(k.items.tomato.id, STOCK_LOC)).toBe(-500_000)
		// Once sent it is closed for the sending place, and a send of someone else's transfer is not found.
		const other = await office('transfer', CENTRAL, STOCK_LOC)
		const wrong = await manager(
			'POST',
			`/pos/inventory/transfers/${other.id}/send`,
			{
				body: {
					clientId: uid('s'),
					locationId: STOCK_LOC,
					expectedVersion: other.version,
				},
			},
		)
		expect([wrong.status, wrong.body.error]).toEqual([404, 'not_found'])
	})

	it('makes a branch request from the tablet, and keeps out what the sender does not offer (#526)', async () => {
		// The central kitchen switches one item off for branches.
		const off = await op('PUT', `/transfer-terms/${k.items.lemon.id}`, {
			locationId: CENTRAL,
			expectedVersion: 0,
			branchRequestable: false,
		})
		expect(off.status, JSON.stringify(off.body)).toBe(200)
		const { catalog: cat } = await catalog()
		expect(cat.transferBlocked).toEqual([
			{ fromLocationId: CENTRAL, itemIds: [k.items.lemon.id] },
		])
		expect(cat.transferItems!.map((i) => i.name)).toContain('Lemons')

		const refused = await manager('POST', '/pos/inventory/transfers', {
			body: {
				clientId: uid('q'),
				locationId: STOCK_LOC,
				fromLocationId: CENTRAL,
				lines: [line(k.items.tomato.id, 3), line(k.items.lemon.id, 1, 'piece')],
			},
		})
		expect([refused.status, refused.body.error]).toEqual([
			409,
			'item_not_requestable',
		])

		const clientId = uid('q')
		const made = await manager('POST', '/pos/inventory/transfers', {
			body: {
				clientId,
				locationId: STOCK_LOC,
				fromLocationId: CENTRAL,
				lines: [line(k.items.tomato.id, 3)],
				note: 'For Friday',
			},
		})
		expect(made.status, made.raw).toBe(201)
		expect(made.body).toMatchObject({ status: 'requested' })
		expect(moneyKeys(made.body)).toEqual([])
		// The office sees a request made by this branch.
		const seen = transferDetailSchema.parse(
			(await op('GET', `/transfers/${made.body.id}`)).body,
		)
		expect(seen).toMatchObject({
			kind: 'request',
			fromLocationId: CENTRAL,
			toLocationId: STOCK_LOC,
			note: 'For Friday',
		})
		// A tap repeated after a lost answer is the same request.
		const again = await manager('POST', '/pos/inventory/transfers', {
			body: {
				clientId,
				locationId: STOCK_LOC,
				fromLocationId: CENTRAL,
				lines: [line(k.items.tomato.id, 3)],
				note: 'For Friday',
			},
		})
		expect(again.status, again.raw).toBeLessThan(300)
		expect(again.body.id).toBe(made.body.id)
		// A cashier may not ask, a request names two different places, and another
		// terminal's place is not this one.
		const cash = await cashier('POST', '/pos/inventory/transfers', {
			body: {
				clientId: uid('q'),
				locationId: STOCK_LOC,
				fromLocationId: CENTRAL,
				lines: [line(k.items.tomato.id, 3)],
			},
		})
		expect(cash.status).toBe(403)
		const wrongPlace = await manager('POST', '/pos/inventory/transfers', {
			body: {
				clientId: uid('q'),
				locationId: CENTRAL,
				fromLocationId: STOCK_LOC,
				lines: [line(k.items.tomato.id, 3)],
			},
		})
		expect([wrongPlace.status, wrongPlace.body.error]).toEqual([
			403,
			'wrong_location',
		])
	})

	it('refuses a missing device, contract or sign-in before anything else, on every new route', async () => {
		const planned = await office('transfer', CENTRAL, STOCK_LOC)
		const routes = [
			{
				path: `/pos/inventory/transfers/${planned.id}/send`,
				body: {
					clientId: uid('s'),
					locationId: STOCK_LOC,
					expectedVersion: 1,
				},
			},
			{
				path: `/pos/inventory/transfers/${planned.id}/receive`,
				body: {
					clientId: uid('r'),
					locationId: STOCK_LOC,
					expectedVersion: 1,
				},
			},
			{
				path: '/pos/inventory/transfers',
				body: {
					clientId: uid('q'),
					locationId: STOCK_LOC,
					fromLocationId: CENTRAL,
					lines: [line(k.items.tomato.id, 1)],
				},
			},
			{
				path: '/pos/inventory/waste/dish',
				body: {
					clientId: uid('d'),
					locationId: STOCK_LOC,
					menuItemId: 'dish_x',
					quantity: 1,
					reason: 'dropped',
				},
			},
			{
				path: '/pos/inventory/waste/dishes/someone/undo',
				body: { clientId: uid('u') },
			},
		]
		for (const route of routes) {
			// No terminal secret.
			const noDevice = await kit.request('POST', route.path, {
				session: tablet.manager.session,
				body: route.body,
			})
			expect([noDevice.status, route.path]).toEqual([401, route.path])
			// A terminal but no person.
			const noSession = await kit.request('POST', route.path, {
				secret: tablet.secret,
				body: route.body,
			})
			expect([noSession.status, noSession.body.error, route.path]).toEqual([
				401,
				'staff_session_required',
				route.path,
			])
			// No contract header, and one from the future.
			const old = await as('manager')('POST', route.path, {
				body: route.body,
				contract: null,
			})
			expect([old.status, old.body.error, route.path]).toEqual([
				400,
				'contract_too_old',
				route.path,
			])
			const future = await as('manager')('POST', route.path, {
				body: route.body,
				contract: 99,
			})
			expect([future.status, future.body.error, route.path]).toEqual([
				400,
				'contract_unsupported',
				route.path,
			])
			// An unreadable body is refused without echoing it.
			const bad = await as('manager')('POST', route.path, {
				rawBody: '{ not json',
			})
			expect([bad.status, bad.body.error, route.path]).toEqual([
				400,
				'invalid_request',
				route.path,
			])
			expect(bad.raw).not.toContain('not json')
		}
	})

	it('is off without the transfers flag: no lists in the catalogue and every route refused', async () => {
		kit.enableInventory(ORG_A, { ...ON, transfers: false })
		invalidateInventoryContext()
		kit.enableInventory(ORG_A, { ...ON, transfers: false })
		const { catalog: cat } = await catalog()
		expect(cat.transfers).toBeUndefined()
		expect(cat.settings.transfersEnabled).toBeUndefined()
		const reply = await manager('POST', '/pos/inventory/transfers', {
			body: {
				clientId: uid('q'),
				locationId: STOCK_LOC,
				fromLocationId: CENTRAL,
				lines: [line(k.items.tomato.id, 1)],
			},
		})
		expect([reply.status, reply.body.error]).toEqual([
			403,
			'inventory_disabled',
		])
	})

	describe('a whole dish as waste from the picker (#517)', () => {
		async function recipe(dishId: string, quantity: number) {
			const db = await h.db(ORG_A)
			const id = `rec_${dishId}`
			await db.insert(invRecipes).values({
				id,
				ownerKind: 'menu_item',
				ownerId: dishId,
				version: 1,
				effectiveFrom: 1,
				createdByKind: 'system',
			})
			await db.insert(invRecipeLines).values({
				recipeId: id,
				itemId: k.items.tomato.id,
				quantity,
			})
		}
		const dish = (
			who: 'cashier' | 'manager',
			extra: Record<string, unknown> = {},
		) =>
			as(who)('POST', '/pos/inventory/waste/dish', {
				body: {
					clientId: uid('dish'),
					locationId: STOCK_LOC,
					menuItemId: 'dish_salad',
					quantity: 2,
					reason: 'dropped',
					...extra,
				},
			})

		it('writes grouped ingredient rows against this terminal and undoes the whole group, only by the person who logged it', async () => {
			await recipe('dish_salad', 100_000)
			const made = await dish('cashier')
			expect(made.status, made.raw).toBe(200)
			const result = stationLogDishWasteResultSchema.parse(made.body)
			expect(result).toMatchObject({
				entries: 1,
				basis: 'recipe',
				duplicate: false,
			})
			expect(moneyKeys(made.body)).toEqual([])
			const rows = await kit.wasteRows(ORG_A, tablet.deviceId)
			const mine = rows.filter((row) => row.groupId === result.id)
			expect(mine).toHaveLength(1)
			// 2 dishes x 100 g, against this terminal, "dropped".
			expect(mine[0]).toMatchObject({
				quantity: 200_000,
				reason: 'dropped',
				dishRef: 'dish_salad',
				source: 'station',
			})
			expect(await stockAt(k.items.tomato.id, STOCK_LOC)).toBe(-200_000)

			// Not the manager's to undo: it is the cashier's own entry.
			const other = await as('manager')(
				'POST',
				`/pos/inventory/waste/dishes/${result.id}/undo`,
				{ body: { clientId: uid('u') } },
			)
			expect([other.status, other.body.error]).toEqual([404, 'not_found'])
			const undone = await cashier(
				'POST',
				`/pos/inventory/waste/dishes/${result.id}/undo`,
				{ body: { clientId: uid('u') } },
			)
			expect(undone.status, undone.raw).toBe(200)
			expect(await stockAt(k.items.tomato.id, STOCK_LOC)).toBe(0)
			const db = await h.db(ORG_A)
			expect(
				(
					await db
						.select()
						.from(invWaste)
						.where(eq(invWaste.groupId, result.id))
				).filter((row) => row.reversesId !== null),
			).toHaveLength(1)
			const twice = await cashier(
				'POST',
				`/pos/inventory/waste/dishes/${result.id}/undo`,
				{ body: { clientId: uid('u') } },
			)
			expect([twice.status, twice.body.error]).toEqual([409, 'already_undone'])
		})

		it('refuses a dish with no recipe, a system reason and a terminal without the recipes flag', async () => {
			const none = await dish('cashier', { menuItemId: 'dish_nothing' })
			expect([none.status, none.body.error]).toEqual([409, 'recipe_missing'])
			const system = await dish('cashier', {
				menuItemId: 'dish_salad',
				reason: 'cancelled_after_cooking',
			})
			expect([system.status, system.body.error]).toEqual([
				400,
				'reason_not_allowed',
			])
			invalidateInventoryContext()
			kit.enableInventory(ORG_A, { ...ON, recipes: false })
			const off = await dish('cashier', { menuItemId: 'dish_salad' })
			expect([off.status, off.body.error]).toEqual([403, 'inventory_disabled'])
			const { catalog: cat } = await catalog()
			expect(cat.settings.dishWasteEnabled).toBeUndefined()
		})
	})
})
