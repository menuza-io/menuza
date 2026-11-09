import crypto from 'node:crypto'
import {
	INVENTORY_FEATURES_OFF,
	INVENTORY_POS_ERROR_CODES,
	STATION_ERROR_HANDLING,
} from '@repo/inventory'
import {
	invItems,
	invPrepLevels,
	invPrepTasks,
	invRecipeLines,
	invRecipes,
	staffMembers,
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
import {
	createStationKit,
	mintInventoryOperator,
	mintTerminalOperator,
	moneyKeys,
	ON,
	STOCK_LOC,
	type Kitchen,
	type StationKit,
} from './pos-inventory-fixture.ts'

/**
 * Every `/pos/inventory/*` route against the envelope: no or a bad device, a
 * revoked one, no or a bad staff session, the wrong location, a terminal or
 * organization without Stock, the kill switches, an old contract, and another
 * organization's terminal. Whatever the route, the refusal is the same code
 * and no response ever carries money.
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

type Route = {
	name: string
	method: 'GET' | 'POST'
	path: string
	body?: unknown
	/** Names the terminal's location in the request, so a different one is `wrong_location`. */
	named?: (location: string) => { path: string; body?: unknown }
	/** Needs the receive permission (a till manager, by default). */
	receive?: boolean
	/** Answers 503 `upload_not_configured` on a node with no object storage (it still passed the envelope). */
	photo?: boolean
}

describe('/pos/inventory security', () => {
	let h: ClockHarness
	let kit: StationKit
	let k: Kitchen
	let tablet: Awaited<ReturnType<StationKit['station']>>
	let countId: string
	let wasteId: string
	let deliveryId: string
	let routes: Route[]

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
		kit.enableInventory(ORG_A)
		kit.enableInventory(ORG_B)
		k = await kit.kitchen(ORG_A)
		tablet = await kit.station(ORG_A)

		// Real records to point the routes at.
		const call = (path: string, body: unknown) =>
			kit.request('POST', path, {
				secret: tablet.secret,
				session: tablet.manager.session,
				body,
			})
		countId = (
			await call('/pos/inventory/counts', {
				clientId: uid('start'),
				locationId: STOCK_LOC,
				listId: k.list.id,
			})
		).body.count.id
		wasteId = (
			await call('/pos/inventory/waste', {
				entries: [
					{
						clientId: uid('waste'),
						locationId: STOCK_LOC,
						itemId: k.items.tomato.id,
						amount: 1,
						unit: 'kg',
						reason: 'spoiled',
					},
				],
			})
		).body.accepted[0].id
		deliveryId = (
			await call('/pos/inventory/deliveries', {
				clientId: uid('delivery'),
				locationId: STOCK_LOC,
				supplierId: k.supplier.id,
				lines: [{ itemId: k.items.tomato.id, quantity: 1_000_000 }],
			})
		).body.id

		// A made item with a recipe and three prep tasks (start, done, skip), so
		// every prep route has a real record to act on.
		const seedDb = await h.db(ORG_A)
		const day = (offset: number) =>
			new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
		await seedDb.insert(invItems).values({
			id: 'sec_sauce',
			name: 'Security sauce',
			kind: 'made',
			baseUnit: 'ml',
			batchCounted: true,
		})
		await seedDb.insert(invRecipes).values({
			id: 'sec_sauce_recipe',
			ownerKind: 'made_item',
			ownerId: 'sec_sauce',
			version: 1,
			makesQuantity: 1_000_000,
			effectiveFrom: 1,
			createdByKind: 'system',
		})
		await seedDb.insert(invRecipeLines).values({
			recipeId: 'sec_sauce_recipe',
			itemId: k.items.tomato.id,
			quantity: 100_000,
		})
		// A level for every weekday, so planning today keeps the seeded tasks.
		for (let weekday = 0; weekday < 7; weekday++) {
			await seedDb.insert(invPrepLevels).values({
				itemId: 'sec_sauce',
				locationId: STOCK_LOC,
				weekday,
				fillUpToQuantity: 1_000_000,
			})
		}
		for (const [id, offset] of [
			['sec_task_start', -1],
			['sec_task_done', 0],
			['sec_task_skip', 1],
		] as const) {
			await seedDb.insert(invPrepTasks).values({
				id,
				locationId: STOCK_LOC,
				businessDate: day(offset),
				itemId: 'sec_sauce',
				plannedQuantity: 1_000_000,
				fillUpToQuantity: 1_000_000,
				onHandQuantity: 0,
			})
		}

		const entry = () => ({
			clientId: uid('entry'),
			itemId: k.items.tomato.id,
			areaId: k.areas.walkin.id,
			amount: 1,
			unit: 'kg',
		})
		routes = [
			{
				name: 'catalog',
				method: 'GET',
				path: `/pos/inventory/catalog?locationId=${STOCK_LOC}`,
				named: (location) => ({
					path: `/pos/inventory/catalog?locationId=${location}`,
				}),
			},
			{
				name: 'start count',
				method: 'POST',
				path: '/pos/inventory/counts',
				body: { clientId: uid('start'), locationId: STOCK_LOC, listId: null },
				named: (location) => ({
					path: '/pos/inventory/counts',
					body: { clientId: uid('start'), locationId: location, listId: null },
				}),
			},
			{
				name: 'count sheet',
				method: 'GET',
				path: `/pos/inventory/counts/${countId}`,
			},
			{
				name: 'count entries',
				method: 'POST',
				path: `/pos/inventory/counts/${countId}/entries`,
				body: { entries: [entry()] },
			},
			{
				name: 'send count',
				method: 'POST',
				path: `/pos/inventory/counts/${countId}/send`,
				body: { clientId: uid('send') },
			},
			{
				name: 'waste',
				method: 'POST',
				path: '/pos/inventory/waste',
				body: {
					entries: [
						{
							clientId: uid('waste'),
							locationId: STOCK_LOC,
							itemId: k.items.tomato.id,
							amount: 1,
							unit: 'kg',
							reason: 'spoiled',
						},
					],
				},
				named: (location) => ({
					path: '/pos/inventory/waste',
					body: {
						entries: [
							{
								clientId: uid('waste'),
								locationId: location,
								itemId: k.items.tomato.id,
								amount: 1,
								unit: 'kg',
								reason: 'spoiled',
							},
						],
					},
				}),
			},
			{
				name: 'dish waste',
				method: 'POST',
				path: '/pos/inventory/waste/dishes',
				body: {
					clientId: uid('dish'),
					locationId: STOCK_LOC,
					lines: [{ itemId: 'sec_dish', quantity: 1 }],
				},
				named: (location) => ({
					path: '/pos/inventory/waste/dishes',
					body: {
						clientId: uid('dish'),
						locationId: location,
						lines: [{ itemId: 'sec_dish', quantity: 1 }],
					},
				}),
			},
			{
				name: 'prep plan',
				method: 'GET',
				path: `/pos/inventory/prep?locationId=${STOCK_LOC}`,
				named: (location) => ({
					path: `/pos/inventory/prep?locationId=${location}`,
				}),
			},
			{
				name: 'prep generate',
				method: 'POST',
				path: '/pos/inventory/prep/generate',
				body: { locationId: STOCK_LOC },
				named: (location) => ({
					path: '/pos/inventory/prep/generate',
					body: { locationId: location },
				}),
			},
			{
				name: 'prep start',
				method: 'POST',
				path: '/pos/inventory/prep/tasks/sec_task_start/start',
				body: { expectedVersion: 1 },
			},
			{
				name: 'prep done',
				method: 'POST',
				path: '/pos/inventory/prep/tasks/sec_task_done/done',
				body: {
					expectedVersion: 1,
					clientId: uid('prep'),
					made: { kind: 'batches', count: 1 },
				},
			},
			{
				name: 'prep skip',
				method: 'POST',
				path: '/pos/inventory/prep/tasks/sec_task_skip/skip',
				body: { expectedVersion: 1 },
			},
			{
				name: 'undo waste',
				method: 'POST',
				path: `/pos/inventory/waste/${wasteId}/undo`,
				body: { clientId: uid('undo') },
			},
			{
				name: 'delivery',
				method: 'POST',
				path: '/pos/inventory/deliveries',
				receive: true,
				body: {
					clientId: uid('delivery'),
					locationId: STOCK_LOC,
					supplierId: k.supplier.id,
					lines: [{ itemId: k.items.tomato.id, quantity: 1_000_000 }],
				},
				named: (location) => ({
					path: '/pos/inventory/deliveries',
					body: {
						clientId: uid('delivery'),
						locationId: location,
						supplierId: k.supplier.id,
						lines: [{ itemId: k.items.tomato.id, quantity: 1_000_000 }],
					},
				}),
			},
			{
				name: 'delivery photo',
				method: 'POST',
				path: `/pos/inventory/deliveries/${deliveryId}/photo`,
				receive: true,
				photo: true,
				body: { contentType: 'image/jpeg', sizeBytes: 1000 },
			},
			{
				name: 'delivery photo confirm',
				method: 'POST',
				path: `/pos/inventory/deliveries/${deliveryId}/photo/confirm`,
				receive: true,
				photo: true,
				body: {
					key: `inventory-invoices/${ORG_A}/${deliveryId}/00000000-0000-4000-8000-000000000000.jpg`,
				},
			},
		]
	})
	afterEach(async () => {
		invalidateInventoryContext()
		vi.unstubAllGlobals()
		await h.cleanup()
	})

	const send = (
		route: Route,
		options: Parameters<StationKit['request']>[2] = {},
	) =>
		kit.request(route.method, route.path, {
			...(route.body === undefined ? {} : { body: route.body }),
			...options,
		})
	const full = (options: Parameters<StationKit['request']>[2] = {}) => ({
		secret: tablet.secret,
		session: tablet.manager.session,
		...options,
	})

	/** Refused with this code and its contract status, `private, no-store`, and nothing else in the body. */
	function expectRefusal(
		reply: Awaited<ReturnType<StationKit['request']>>,
		code: keyof typeof STATION_ERROR_HANDLING,
		label: string,
	) {
		expect(reply.status, `${label}: ${reply.raw}`).toBe(
			STATION_ERROR_HANDLING[code].status,
		)
		expect(reply.body?.error, label).toBe(code)
		expect(reply.headers.get('cache-control'), label).toBe('private, no-store')
	}

	it('serves every route to a paired terminal with a signed-in person (the baseline the refusals depart from)', async () => {
		for (const route of routes) {
			const reply = await send(route, full())
			if (route.photo) {
				// Past the whole envelope; this node simply has no object storage.
				expectRefusal(reply, 'upload_not_configured', route.name)
				continue
			}
			expect(reply.status, `${route.name}: ${reply.raw}`).toBe(200)
			expect(reply.headers.get('cache-control')).toBe('private, no-store')
			expect(moneyKeys(reply.body), route.name).toEqual([])
		}
	})

	describe('the device', () => {
		it('refuses a request with no device secret, or one that is not one', async () => {
			for (const route of routes) {
				expectRefusal(
					await send(route, { session: tablet.manager.session }),
					'invalid_device',
					`${route.name} without a secret`,
				)
				for (const authorization of [
					'Bearer nonsense',
					'Bearer ',
					'Basic abc',
					`Bearer ${tablet.secret.slice(0, -1)}X`,
					`Bearer ${tablet.secret.replace(/\.[^.]*$/, '.AAAA')}`,
				]) {
					expectRefusal(
						await send(route, {
							authorization,
							session: tablet.manager.session,
						}),
						'invalid_device',
						`${route.name} with ${authorization.slice(0, 20)}`,
					)
				}
			}
		})

		it('never takes an operator or inventory token, or a kiosk secret, for a terminal', async () => {
			const tokens = [
				await mintInventoryOperator(ORG_A),
				`${await mintTerminalOperator(ORG_A)}`,
			]
			for (const route of routes) {
				for (const token of tokens) {
					expectRefusal(
						await send(route, {
							authorization: `Bearer ${token}`,
							session: tablet.manager.session,
						}),
						'invalid_device',
						route.name,
					)
				}
			}
			// And the other way round: a terminal secret is not an operator's.
			const operatorRoute = await kit.request(
				'GET',
				`/operator/inventory/items?locationId=${STOCK_LOC}`,
				{ secret: tablet.secret },
			)
			expect(operatorRoute.status).toBe(401)
		})

		it('refuses a revoked terminal with device_revoked, before anything else is looked at', async () => {
			const removed = await h.app.request(
				`/operator/pos/terminals/${tablet.deviceId}`,
				{
					method: 'DELETE',
					headers: {
						authorization: `Bearer ${await mintTerminalOperator(ORG_A)}`,
					},
				},
			)
			expect(removed.status, await removed.text()).toBeLessThan(300)
			for (const route of routes) {
				for (const session of [tablet.manager.session, undefined]) {
					expectRefusal(
						await send(route, { secret: tablet.secret, session }),
						'device_revoked',
						route.name,
					)
				}
			}
		})

		it('refuses another organization’s terminal and session, and shows it nothing of this one', async () => {
			const other = await kit.station(ORG_B)
			for (const route of routes) {
				// B's terminal with A's session.
				expectRefusal(
					await send(route, {
						secret: other.secret,
						session: tablet.manager.session,
					}),
					'staff_session_invalid',
					`${route.name} (A's session at B's terminal)`,
				)
				// A's terminal with B's session.
				expectRefusal(
					await send(route, {
						secret: tablet.secret,
						session: other.manager.session,
					}),
					'staff_session_invalid',
					`${route.name} (B's session at A's terminal)`,
				)
			}
			// With its own session B's terminal reaches nothing of A's records.
			for (const path of [
				`/pos/inventory/counts/${countId}`,
				`/pos/inventory/counts/${countId}/entries`,
				`/pos/inventory/counts/${countId}/send`,
				`/pos/inventory/waste/${wasteId}/undo`,
				`/pos/inventory/deliveries/${deliveryId}/photo`,
				`/pos/inventory/deliveries/${deliveryId}/photo/confirm`,
			]) {
				const route = routes.find((r) => r.path === path)!
				const reply = await send(route, {
					secret: other.secret,
					session: other.manager.session,
				})
				expectRefusal(reply, 'not_found', `${route.name} across organizations`)
			}
			const catalog = await kit.request(
				'GET',
				`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
				{ secret: other.secret, session: other.cashier.session },
			)
			expect(catalog.status).toBe(200)
			expect(catalog.body.items).toEqual([])
			expect(catalog.body.suppliers).toEqual([])
			expect(catalog.body.counts).toEqual([])
			expect(catalog.raw).not.toContain(k.items.tomato.id)
		})
	})

	describe('the signed-in person', () => {
		it('needs a Pos-Staff-Session, a genuine one, for this terminal and a person still working here', async () => {
			for (const route of routes) {
				expectRefusal(
					await send(route, { secret: tablet.secret }),
					'staff_session_required',
					`${route.name} without a session`,
				)
				for (const session of [
					'garbage',
					`${tablet.manager.session}x`,
					tablet.manager.session.split('.').slice(0, 2).join('.'),
					// The device secret, an operator token and an inventory token are not sessions.
					tablet.secret,
					await mintInventoryOperator(ORG_A),
				]) {
					expectRefusal(
						await send(route, { secret: tablet.secret, session }),
						'staff_session_invalid',
						`${route.name} with ${session.slice(0, 12)}`,
					)
				}
			}
		})

		it('refuses another terminal’s session, and the session of someone who has since left', async () => {
			const second = await kit.station(ORG_A, { terminalCode: 'K2' })
			for (const route of routes) {
				expectRefusal(
					await send(route, {
						secret: tablet.secret,
						session: second.manager.session,
					}),
					'staff_session_invalid',
					`${route.name} with the other terminal's session`,
				)
			}
			// The cashier is removed from the roster: the session dies with it.
			const db = await h.db(ORG_A)
			await db
				.update(staffMembers)
				.set({ status: 'terminated' })
				.where(eq(staffMembers.id, tablet.cashier.staffId))
			for (const route of routes) {
				expectRefusal(
					await send(route, {
						secret: tablet.secret,
						session: tablet.cashier.session,
					}),
					'staff_session_invalid',
					route.name,
				)
			}
			// Others at the same terminal are unaffected.
			expect((await send(routes[0]!, full())).status).toBe(200)
		})

		it('needs a till manager for deliveries and their photos, and nothing more than a session for the rest', async () => {
			for (const route of routes) {
				const reply = await send(route, {
					secret: tablet.secret,
					session: tablet.cashier.session,
				})
				if (route.receive) {
					expectRefusal(reply, 'receive_needs_manager', route.name)
				} else {
					// Past the envelope: a 200, or a 404 for the manager's own waste entry.
					expect([200, 404], `${route.name}: ${reply.raw}`).toContain(
						reply.status,
					)
				}
			}
		})
	})

	describe('the location', () => {
		it('answers wrong_location when a request names another location, before the session is looked at', async () => {
			const named = routes.filter((route) => route.named)
			expect(named.map((route) => route.name)).toEqual([
				'catalog',
				'start count',
				'waste',
				'dish waste',
				'prep plan',
				'prep generate',
				'delivery',
			])
			for (const route of named) {
				const wrong = route.named!('loc_elsewhere')
				for (const session of [tablet.manager.session, undefined]) {
					const reply = await kit.request(route.method, wrong.path, {
						secret: tablet.secret,
						session,
						...(wrong.body === undefined ? {} : { body: wrong.body }),
					})
					expectRefusal(
						reply,
						'wrong_location',
						`${route.name} ${session ? 'with' : 'without'} a session`,
					)
				}
			}
		})

		it('answers a plain 404 for records of another location, never "forbidden"', async () => {
			const elsewhere = await k.world.ok('POST', '/counts', {
				clientId: uid('op'),
				locationId: 'loc_elsewhere',
				listId: null,
			})
			const reply = await kit.request(
				'GET',
				`/pos/inventory/counts/${elsewhere.id}`,
				full(),
			)
			expectRefusal(reply, 'not_found', 'a count elsewhere')
			expect(reply.raw).toBe(JSON.stringify({ error: 'not_found' }))
		})

		it('says inventory_needs_location for a terminal with no location', async () => {
			await kit.setDevice(ORG_A, tablet.deviceId, { locationId: null })
			for (const route of routes) {
				expectRefusal(
					await send(route, full()),
					'inventory_needs_location',
					route.name,
				)
			}
		})
	})

	describe('Stock switched off', () => {
		it('refuses a terminal without the Stock app, whatever the session', async () => {
			await kit.setDevice(ORG_A, tablet.deviceId, { inventoryEnabled: false })
			for (const route of routes) {
				for (const session of [tablet.manager.session, undefined]) {
					expectRefusal(
						await send(route, { secret: tablet.secret, session }),
						'inventory_not_enabled',
						route.name,
					)
				}
			}
		})

		it('refuses a terminal that does not require staff sign-in', async () => {
			await kit.setDevice(ORG_A, tablet.deviceId, { signInRequired: false })
			for (const route of routes) {
				expectRefusal(
					await send(route, full()),
					'inventory_needs_sign_in',
					route.name,
				)
			}
		})

		it('refuses an organization whose inventory flag is off, and fails closed when it cannot be read', async () => {
			seedInventoryContextForTest(ORG_A, { ...INVENTORY_FEATURES_OFF })
			for (const route of routes) {
				expectRefusal(
					await send(route, full()),
					'inventory_disabled',
					route.name,
				)
			}
			invalidateInventoryContext(ORG_A)
			for (const route of routes) {
				expectRefusal(
					await send(route, full()),
					'service_unavailable',
					route.name,
				)
			}
			// It opens again once the flag is on.
			seedInventoryContextForTest(ORG_A, ON)
			expect((await send(routes[0]!, full())).status).toBe(200)
		})

		it('answers 503 inventory_unavailable under the node kill switch (INVENTORY_ENABLED=false)', async () => {
			vi.stubEnv('INVENTORY_ENABLED', 'false')
			for (const route of routes) {
				expectRefusal(
					await send(route, full()),
					'inventory_unavailable',
					route.name,
				)
			}
			vi.stubEnv('INVENTORY_ENABLED', '')
			expect((await send(routes[0]!, full())).status).toBe(200)
		})

		it('answers 503 pos_disabled when terminals are switched off on the node (POS_ENABLED=false)', async () => {
			vi.stubEnv('POS_ENABLED', 'false')
			for (const route of routes) {
				expectRefusal(await send(route, full()), 'pos_disabled', route.name)
			}
		})
	})

	describe('the contract version', () => {
		it('refuses a tablet older than the oldest the region serves, and reads a missing header as 1', async () => {
			for (const route of routes) {
				expectRefusal(
					await send(route, full({ contract: 0 })),
					'contract_too_old',
					route.name,
				)
				expectRefusal(
					await send(route, full({ contract: 'two' })),
					'invalid_request',
					`${route.name} with a malformed header`,
				)
				const missing = await send(route, full({ contract: null }))
				expect(missing.status, `${route.name}: ${missing.raw}`).toBe(
					route.photo ? 503 : 200,
				)
			}
			// Versions 1 and 2 are both served.
			expect((await send(routes[0]!, full({ contract: 1 }))).status).toBe(200)
			expect((await send(routes[0]!, full({ contract: 2 }))).status).toBe(200)
		})

		it('answers contract_unsupported to a tablet newer than the region, on every route', async () => {
			for (const route of routes) {
				for (const contract of [3, 99, 999999]) {
					expectRefusal(
						await send(route, full({ contract })),
						'contract_unsupported',
						`${route.name} with contract ${contract}`,
					)
				}
			}
		})
	})

	describe('what a refusal says', () => {
		it('uses only the contract’s codes and statuses and never repeats what was sent', async () => {
			const secretish = 'ECHO-ME-7d1f'
			const attempts = [
				...routes.map((route) =>
					send(route, { secret: tablet.secret, session: secretish }),
				),
				...routes.map((route) =>
					send(route, { authorization: `Bearer ${secretish}` }),
				),
				...routes
					.filter((route) => route.method === 'POST')
					.map((route) =>
						kit.request('POST', route.path, {
							...full(),
							body: { [secretish]: secretish },
						}),
					),
			]
			for (const reply of await Promise.all(attempts)) {
				expect(reply.status).toBeGreaterThanOrEqual(400)
				const code = reply.body?.error as keyof typeof STATION_ERROR_HANDLING
				expect(INVENTORY_POS_ERROR_CODES).toContain(code)
				expect(reply.status).toBe(STATION_ERROR_HANDLING[code].status)
				expect(reply.raw).not.toContain(secretish)
				expect(reply.headers.get('cache-control')).toBe('private, no-store')
			}
		})
	})

	describe('CORS', () => {
		it('lets a listed Station origin call /pos/inventory with the contract and session headers, and nobody else', async () => {
			vi.stubEnv('POS_ORIGINS', 'https://pos.example.test')
			const headers =
				'authorization, content-type, if-none-match, pos-inventory-contract, pos-staff-session'
			const preflight = (origin: string) =>
				h.app.request('/pos/inventory/catalog', {
					method: 'OPTIONS',
					headers: {
						Origin: origin,
						'Access-Control-Request-Method': 'GET',
						'Access-Control-Request-Headers': headers,
					},
				})
			const ok = await preflight('https://pos.example.test')
			expect(ok.status).toBe(204)
			expect(ok.headers.get('access-control-allow-origin')).toBe(
				'https://pos.example.test',
			)
			expect(ok.headers.get('access-control-allow-headers')).toBe(headers)
			expect((await preflight('https://evil.example.test')).status).toBe(403)

			const reply = await h.app.request(
				`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
				{
					headers: {
						Origin: 'https://pos.example.test',
						Authorization: `Bearer ${tablet.secret}`,
						'Pos-Staff-Session': tablet.manager.session,
					},
				},
			)
			expect(reply.status).toBe(200)
			expect(reply.headers.get('access-control-allow-origin')).toBe(
				'https://pos.example.test',
			)
			const refused = await h.app.request(
				`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
				{ headers: { Origin: 'https://evil.example.test' } },
			)
			expect(refused.headers.get('access-control-allow-origin')).toBeNull()
		})
	})

	describe('no money', () => {
		it('never carries a money, price or cost field in any answer, errors included', async () => {
			// Give the office real prices to leak: priced items, a priced delivery, a paid one.
			await k.world.ok('POST', '/deliveries', {
				clientId: uid('office'),
				locationId: STOCK_LOC,
				supplierId: k.supplier.id,
				currency: 'SAR',
				lines: [
					{
						itemId: k.items.tomato.id,
						quantity: 2_000_000,
						lineTotalMinor: 1_800,
					},
				],
			})
			const seen: unknown[] = []
			const all = [
				...routes,
				{
					name: 'a refusal',
					method: 'GET' as const,
					path: '/pos/inventory/counts/nothing',
				},
			]
			for (const route of all) {
				const reply = await send(route, full())
				seen.push(reply.body)
				expect(moneyKeys(reply.body), route.name).toEqual([])
				expect(reply.raw, route.name).not.toMatch(/SAR|"currency"/)
			}
			const catalog = await kit.request(
				'GET',
				`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
				full(),
			)
			expect(seen.length).toBe(all.length)
		})
	})
})
