import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dailyDishClaimState } from '@repo/common/daily-dish-limits'
import { RESTAURANT_ACTIVE_ORDER_STATUSES } from '@repo/common/restaurant-orders'
import {
	destroyTenantDb,
	getTenantDb,
	orderDishDailyClaims,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import {
	adjustDailyDish,
	getOperatorDailyDishStatus,
} from '../services/order-dish-daily-operator.ts'
import { readDailyDishAvailability } from '../services/order-dish-daily-service.ts'
import { insertOrder } from '../services/loyalty-test-fixture.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', () => {
	const findActiveOrganizationById = vi.fn()
	return {
		findActiveOrganizationById,
		lookupActiveOrganization: vi.fn(async (id: string) => {
			const organization = await findActiveOrganizationById(id)
			return organization
				? { status: 'found', organization }
				: { status: 'missing' }
		}),
		resolveOrganizationForBrowserAuth: vi.fn(),
		resolvePublishedOrganization: vi.fn(async () => null),
	}
})

/**
 * Daily dish limits (#409): a dish with a limit of 20 refuses the 21st order,
 * topping up makes it available again, the count starts over with the next
 * business day, an open online cart holds stock until it lapses, and options
 * have their own caps. Real tenant database; the App context is stubbed.
 */

const orgId = 'org_daily_dish_1'
const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const ALL_DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
].map((day) => ({
	day,
	isOpen: true,
	slots: [{ start: '00:00', end: '23:59' }],
}))

type Entry = {
	kind: 'item' | 'option'
	id: string
	name: string
	config: unknown
}

function contextWith(
	entries: Entry[],
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Main Street',
					timezone: 'UTC',
					taxRate: 0,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: false,
						dineIn: false,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: false,
						deliveryTips: false,
						dineInTips: false,
					},
					onlineHours: ALL_DAYS,
				},
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Main',
					menuType: 'regular',
					specialInstructions: true,
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-food',
							displayName: 'Food',
							availabilityStatus: 'available',
							items: [
								{
									id: 'item-special',
									displayName: 'Special',
									price: 10,
									availabilityStatus: 'available',
									modifierGroups: [
										{
											id: 'grp-side',
											name: 'Side',
											selectionType: 'single',
											minSelections: 0,
											maxSelections: 1,
											availabilityStatus: 'available',
											options: [
												{
													id: 'opt-dessert',
													displayName: 'Dessert',
													price: 2,
													availabilityStatus: 'available',
												},
											],
										},
									],
								},
								{
									id: 'item-burger',
									displayName: 'Burger',
									price: 8,
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: true, processor: 'connect' },
		dailyDishLimits: { enabled, entries },
	}
}

const SPECIAL: Entry = {
	kind: 'item',
	id: 'item-special',
	name: 'Special',
	config: { limit: 20, showRemaining: false },
}

function orderBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: { name: 'Rana Khalid', phone: '+1 555 123 4567' },
		lines: [{ itemId: 'item-special', quantity: 1, options: [] }],
		...overrides,
	}
}

describe('daily dish limits', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown

	async function postOrder(body: unknown) {
		return app.request('/orders', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
			},
			body: JSON.stringify(body),
		})
	}

	const placeSpecial = (
		quantity: number,
		extra: Record<string, unknown> = {},
	) =>
		postOrder(
			orderBody({
				lines: [{ itemId: 'item-special', quantity, options: [] }],
				...extra,
			}),
		)

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-daily-dish-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv(
			'TENANT_OPERATOR_TOKEN',
			'test-operator-token-very-long-and-secure-12345',
		)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'))
		activeContext = contextWith([SPECIAL])
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return new Response(JSON.stringify(activeContext), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				}
				return new Response('not found', { status: 404 })
			}),
		)
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org' ? (ORG as never) : null,
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === orgId ? (ORG as never) : null,
		)
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		vi.useRealTimers()
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('refuses the 21st order of a dish limited to 20', async () => {
		expect((await placeSpecial(20)).status).toBe(201)
		const refused = await placeSpecial(1)
		expect(refused.status).toBe(422)
		const body = await refused.json()
		expect(body.error).toBe('daily_dish_sold_out')
		expect(body.message).toContain('Special')
		expect(body.details.short).toEqual([
			{ key: 'item:item-special', kind: 'item', id: 'item-special' },
		])
	})

	it('refuses an order that is larger than what is left without taking a unit', async () => {
		expect((await placeSpecial(18)).status).toBe(201)
		const refused = await placeSpecial(3)
		expect(refused.status).toBe(422)
		// Nothing was claimed by the refused order, so the last two are still there.
		expect((await placeSpecial(2)).status).toBe(201)
	})

	it('lets two guests race for the last unit and gives it to exactly one', async () => {
		expect((await placeSpecial(19)).status).toBe(201)
		const results = await Promise.all([placeSpecial(1), placeSpecial(1)])
		expect(results.map((r) => r.status).sort()).toEqual([201, 422])
	})

	it('makes a sold-out dish available again when a manager tops up', async () => {
		expect((await placeSpecial(20)).status).toBe(201)
		expect((await placeSpecial(1)).status).toBe(422)

		const topped = await adjustDailyDish({
			orgId,
			locationId: 'loc-1',
			key: 'item:item-special',
			change: { addUnits: 3 },
			userId: 'user-1',
		})
		expect(topped).toMatchObject({
			ok: true,
			data: { remaining: 3, toppedUpUnits: 3, soldUnits: 20 },
		})
		expect((await placeSpecial(3)).status).toBe(201)
		expect((await placeSpecial(1)).status).toBe(422)
	})

	it('sets the amount left, up or down, without touching the limit', async () => {
		expect((await placeSpecial(5)).status).toBe(201)
		const set = await adjustDailyDish({
			orgId,
			locationId: 'loc-1',
			key: 'item:item-special',
			change: { amountLeft: 2 },
			userId: null,
		})
		expect(set).toMatchObject({ ok: true, data: { remaining: 2, limit: 20 } })
		expect((await placeSpecial(3)).status).toBe(422)
		expect((await placeSpecial(2)).status).toBe(201)

		const raised = await adjustDailyDish({
			orgId,
			locationId: 'loc-1',
			key: 'item:item-special',
			change: { amountLeft: 9 },
			userId: null,
		})
		expect(raised).toMatchObject({ ok: true, data: { remaining: 9 } })
	})

	it('refuses a top-up for a dish with no daily limit', async () => {
		const result = await adjustDailyDish({
			orgId,
			locationId: 'loc-1',
			key: 'item:item-burger',
			change: { addUnits: 5 },
			userId: null,
		})
		expect(result).toMatchObject({
			ok: false,
			failure: { status: 404, code: 'daily_limit_not_found' },
		})
	})

	it('starts again at the location business day, not at midnight', async () => {
		expect((await placeSpecial(20)).status).toBe(201)
		// Day start defaults to 04:00: 03:00 the next morning is still yesterday.
		vi.setSystemTime(new Date('2026-03-11T03:00:00.000Z'))
		expect((await placeSpecial(1)).status).toBe(422)
		vi.setSystemTime(new Date('2026-03-11T04:30:00.000Z'))
		expect((await placeSpecial(1)).status).toBe(201)
	})

	it("does not carry yesterday's top-up into the next business day", async () => {
		await adjustDailyDish({
			orgId,
			locationId: 'loc-1',
			key: 'item:item-special',
			change: { addUnits: 10 },
			userId: null,
		})
		vi.setSystemTime(new Date('2026-03-11T05:00:00.000Z'))
		const status = await getOperatorDailyDishStatus({
			orgId,
			locationId: 'loc-1',
		})
		expect(status).toMatchObject({
			ok: true,
			data: {
				rows: [{ key: 'item:item-special', toppedUpUnits: 0, remaining: 20 }],
			},
		})
	})

	it('holds stock for an unpaid online order and gives it back when the hold lapses', async () => {
		const online = await placeSpecial(20, { paymentMethod: 'online' })
		expect(online.status).toBe(201)
		// 20 held, none sold: the dish is already spoken for.
		expect((await placeSpecial(1)).status).toBe(422)
		const status = await getOperatorDailyDishStatus({
			orgId,
			locationId: 'loc-1',
		})
		expect(status).toMatchObject({
			data: { rows: [{ heldUnits: 20, soldUnits: 0, remaining: 0 }] },
		})

		// The hold lapses (15 minutes by default): the next placement sweeps it.
		vi.setSystemTime(new Date('2026-03-10T13:00:00.000Z'))
		expect((await placeSpecial(1)).status).toBe(201)
	})

	it('gives the units back when an order is cancelled', async () => {
		const placed = await placeSpecial(20)
		const { order } = await placed.json()
		expect((await placeSpecial(1)).status).toBe(422)
		const db = await getTenantDb(orgId)
		await db
			.update(restaurantOrders)
			.set({ status: 'cancelled' })
			.where(eq(restaurantOrders.id, order.id))
		expect((await placeSpecial(20)).status).toBe(201)
	})

	it('caps a modifier option on its own, counting its quantity per line', async () => {
		activeContext = contextWith([
			{
				kind: 'option',
				id: 'opt-dessert',
				name: 'Dessert',
				config: { limit: 4 },
			},
		])
		const withDessert = (quantity: number) =>
			postOrder(
				orderBody({
					lines: [
						{
							itemId: 'item-special',
							quantity,
							options: [{ groupId: 'grp-side', optionId: 'opt-dessert' }],
						},
					],
				}),
			)
		expect((await withDessert(3)).status).toBe(201)
		const refused = await withDessert(2)
		expect(refused.status).toBe(422)
		expect((await refused.json()).details.short).toEqual([
			{ key: 'option:opt-dessert', kind: 'option', id: 'opt-dessert' },
		])
		// The dish itself has no cap, and the option is not in this order.
		expect((await placeSpecial(10)).status).toBe(201)
		expect((await withDessert(1)).status).toBe(201)
	})

	it('applies a per-location override and lets null lift the cap', async () => {
		activeContext = contextWith([
			{
				kind: 'item',
				id: 'item-special',
				name: 'Special',
				config: { limit: 2, byLocation: { 'loc-1': null } },
			},
		])
		expect((await placeSpecial(10)).status).toBe(201)
		activeContext = contextWith([
			{
				kind: 'item',
				id: 'item-special',
				name: 'Special',
				config: { limit: 50, byLocation: { 'loc-1': 2 } },
			},
		])
		expect((await placeSpecial(3)).status).toBe(422)
	})

	it('ignores every cap while the flag is off', async () => {
		activeContext = contextWith([SPECIAL], { enabled: false })
		expect((await placeSpecial(50)).status).toBe(201)
	})

	it('takes a lowered limit at once, and counts units already sold', async () => {
		expect((await placeSpecial(10)).status).toBe(201)
		activeContext = contextWith([
			{ ...SPECIAL, config: { limit: 12, showRemaining: false } },
		])
		expect((await placeSpecial(3)).status).toBe(422)
		expect((await placeSpecial(2)).status).toBe(201)
	})

	it('names how many are left only when the operator allows it', async () => {
		activeContext = contextWith([
			{ ...SPECIAL, config: { limit: 5, showRemaining: true } },
		])
		expect((await placeSpecial(3)).status).toBe(201)
		const refused = await placeSpecial(4)
		const body = await refused.json()
		expect(body.message).toContain('Only 2')
		expect(body.details.short[0].remaining).toBe(2)

		activeContext = contextWith([
			{ ...SPECIAL, config: { limit: 5, showRemaining: false } },
		])
		const hidden = await (await placeSpecial(4)).json()
		expect(hidden.message).not.toMatch(/\b2\b/)
		expect(hidden.details.short[0].remaining).toBeUndefined()
	})

	it('tells a guest page only what the operator chose to show', async () => {
		const db = await getTenantDb(orgId)
		const context = contextWith([
			{ ...SPECIAL, config: { limit: 10, showRemaining: true } },
			{
				kind: 'item',
				id: 'item-burger',
				name: 'Burger',
				config: { limit: 4, showRemaining: false },
			},
		])
		activeContext = context
		const availability = () =>
			readDailyDishAvailability(db, context as never, 'loc-1', new Date())
		const placeBurger = (quantity: number) =>
			postOrder(
				orderBody({
					lines: [{ itemId: 'item-burger', quantity, options: [] }],
				}),
			)

		expect((await placeSpecial(2)).status).toBe(201)
		// 8 of 10 left: not low yet, so no number is shown.
		expect(await availability()).toEqual({})

		expect((await placeSpecial(6)).status).toBe(201)
		expect((await placeBurger(3)).status).toBe(201)
		// 2 of 10 left and the operator allows it: shown. The burger has 1 of 4
		// left but "Only N left" is off for it, so its number never leaves the region.
		expect(await availability()).toEqual({
			'item:item-special': { remaining: 2, showRemaining: true },
		})

		expect((await placeSpecial(2)).status).toBe(201)
		expect((await placeBurger(1)).status).toBe(201)
		// Sold out is always shown, whatever the setting.
		expect(await availability()).toEqual({
			'item:item-special': { remaining: 0, showRemaining: false },
			'item:item-burger': { remaining: 0, showRemaining: false },
		})
	})
})

describe('claim state follows the order (trigger parity)', () => {
	let directory: string
	const claimOrg = 'org_daily_dish_trigger'

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-daily-trigger-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		await provisionTenantDb(claimOrg)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(claimOrg)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
	})

	it('keeps the SQL trigger and the shared function in step for every status and payment', async () => {
		const db = await getTenantDb(claimOrg)
		const statuses = [
			'pending_acceptance',
			'accepted',
			'preparing',
			'ready',
			'completed',
			'cancelled',
			'expired',
			'payment_review',
		]
		const methods = ['handoff', 'online'] as const
		const payments = [
			'unpaid',
			'pending',
			'paid',
			'failed',
			'expired',
			'review',
			'not_required',
		]
		const id = await insertOrder(claimOrg, {
			id: 'ord_trigger',
			status: 'accepted',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
		})
		const stamp = Date.now()
		await db.insert(orderDishDailyClaims).values({
			orderId: id,
			locationId: 'loc-1',
			businessDate: '2026-03-10',
			catalogKey: 'item:a',
			units: 1,
			state: 'sold',
			createdAt: stamp,
			updatedAt: stamp,
		})
		for (const status of statuses) {
			for (const paymentMethod of methods) {
				for (const paymentStatus of payments) {
					await db
						.update(restaurantOrders)
						.set({ status, paymentMethod, paymentStatus } as never)
						.where(eq(restaurantOrders.id, id))
					const [claim] = await db
						.select({ state: orderDishDailyClaims.state })
						.from(orderDishDailyClaims)
						.where(eq(orderDishDailyClaims.orderId, id))
					expect(
						claim!.state,
						`${status} / ${paymentMethod} / ${paymentStatus}`,
					).toBe(dailyDishClaimState({ status, paymentMethod, paymentStatus }))
				}
			}
		}
	})

	it('releases exactly the statuses the order lifecycle says release capacity', () => {
		for (const status of [
			...RESTAURANT_ACTIVE_ORDER_STATUSES,
			'cancelled',
			'expired',
			'payment_review',
		]) {
			const live = (
				RESTAURANT_ACTIVE_ORDER_STATUSES as readonly string[]
			).includes(status)
			expect(
				dailyDishClaimState({
					status,
					paymentMethod: 'handoff',
					paymentStatus: 'paid',
				}) !== 'released',
			).toBe(live)
		}
	})
})
