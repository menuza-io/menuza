import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
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
 * Modifier discounts on a real priced order: the order route prices the pizza
 * and its toppings, and the engine must see each topping as its own choice.
 */

const orgId = 'org_discounts_modifiers'
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

const target = {
	scope: 'modifiers' as const,
	itemIds: [],
	categoryIds: [],
	excludeItemIds: [],
	excludeCategoryIds: [],
	modifierGroupIds: ['grp-toppings'],
	modifierOptionIds: [],
}

function menuContext(discounts: unknown[]) {
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
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: true,
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
							id: 'cat-pizza',
							displayName: 'Pizza',
							availabilityStatus: 'available',
							items: [
								{
									id: 'item-sized',
									displayName: 'Margherita',
									price: 9,
									availabilityStatus: 'available',
									variations: {
										groups: [
											{
												id: 'grp-size',
												name: '{"en":"Size","ar":"الحجم"}',
												values: [
													{
														id: 'val-large',
														name: '{"en":"Large","ar":"كبير"}',
													},
													{ id: 'val-small', name: 'Small' },
												],
											},
										],
										variants: [
											{
												id: 'var-large',
												valueIds: ['val-large'],
												price: 14,
												availabilityStatus: 'available',
											},
											{
												id: 'var-small',
												valueIds: ['val-small'],
												price: 9,
												availabilityStatus: 'available',
											},
										],
									},
								},
								{
									id: 'item-pizza',
									displayName: 'Pizza',
									price: 12,
									availabilityStatus: 'available',
									modifierGroups: [
										{
											id: 'grp-toppings',
											name: 'Toppings',
											selectionType: 'multiple',
											minSelections: 0,
											maxSelections: 5,
											availabilityStatus: 'available',
											options: [
												{
													id: 'opt-pep',
													displayName: 'Pepperoni',
													price: 1.5,
													availabilityStatus: 'available',
												},
												{
													id: 'opt-mush',
													displayName: 'Mushroom',
													price: 1,
													availabilityStatus: 'available',
												},
												{
													id: 'opt-olive',
													displayName: 'Olives',
													price: 0.8,
													availabilityStatus: 'available',
												},
											],
										},
									],
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
		discounts: {
			features: { automatic: true, coupons: true },
			discounts,
			codes: [],
		},
	}
}

const THREE_TOPPINGS = [
	{ groupId: 'grp-toppings', optionId: 'opt-pep' },
	{ groupId: 'grp-toppings', optionId: 'opt-mush' },
	{ groupId: 'grp-toppings', optionId: 'opt-olive' },
]

function quoteBody(options = THREE_TOPPINGS) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		tipPercent: 0,
		lines: [{ itemId: 'item-pizza', quantity: 1, options }],
	}
}

describe('modifier discounts on a priced order', () => {
	let directory: string
	let app: Hono
	let activeContext: Record<string, unknown>

	async function quote(body: unknown) {
		const response = await app.request('/orders/quote', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
			},
			body: JSON.stringify(body),
		})
		expect(response.status).toBe(200)
		return response.json()
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discounts-modifiers-'))
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
		vi.stubEnv('DISCOUNTS_ENABLED', 'true')
		activeContext = menuContext([])
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return Response.json(activeContext)
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
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {
			// The directory is already gone when a test failed mid-setup.
		}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('gives the two dearest toppings free', async () => {
		activeContext = menuContext([
			makeDiscount({
				id: 'disc_toppings',
				name: 'Two toppings free',
				percentBp: 10_000,
				target,
				quantityRule: { kind: 'per_item', quantity: 2 },
			}),
		])
		const quoted = await quote(quoteBody())
		// 12.00 + 1.50 + 1.00 + 0.80, and the 1.50 and 1.00 are free.
		expect(quoted.subtotalMinor).toBe(1530)
		expect(quoted.totalDiscountMinor).toBe(250)
		expect(quoted.totalMinor).toBe(1280)
	})

	it('discounts nothing when the pizza has no toppings', async () => {
		activeContext = menuContext([
			makeDiscount({
				id: 'disc_toppings',
				percentBp: 10_000,
				target,
				quantityRule: { kind: 'per_item', quantity: 2 },
			}),
		])
		const quoted = await quote(quoteBody([]))
		expect(quoted.totalDiscountMinor).toBe(0)
	})

	it('a set price replaces the pizza, not the toppings on it', async () => {
		activeContext = menuContext([
			makeDiscount({
				id: 'disc_price',
				name: 'Pizza for ten',
				valueType: 'fixed_price',
				percentBp: null,
				amountMinor: 1000,
				currency: 'USD',
				target: {
					scope: 'items',
					itemIds: ['item-pizza'],
					categoryIds: [],
					excludeItemIds: [],
					excludeCategoryIds: [],
				},
			}),
		])
		const quoted = await quote(quoteBody())
		// 12.00 becomes 10.00; the 3.30 of toppings is still charged.
		expect(quoted.totalDiscountMinor).toBe(200)
		expect(quoted.totalMinor).toBe(1330)
	})

	it('a variant matches by name across the menu, in any language', async () => {
		activeContext = menuContext([
			makeDiscount({
				id: 'disc_large',
				name: 'Large for ten',
				nameI18n: { en: 'Large for ten', ar: 'الكبير بعشرة' },
				valueType: 'fixed_price',
				percentBp: null,
				amountMinor: 1000,
				currency: 'USD',
				target: {
					scope: 'categories',
					itemIds: [],
					categoryIds: ['cat-pizza'],
					excludeItemIds: [],
					excludeCategoryIds: [],
					variants: [{ group: 'size', values: ['large'] }],
				},
			}),
		])
		const sized = (variantId: string) => ({
			...quoteBody([]),
			lines: [{ itemId: 'item-sized', variantId, quantity: 1, options: [] }],
		})
		// 14.00 becomes 10.00; the small is left alone.
		const large = await quote(sized('var-large'))
		expect(large.totalDiscountMinor).toBe(400)
		// The quote carries the translated names for the guest's language.
		expect(large.discounts[0]?.nameI18n).toEqual({
			en: 'Large for ten',
			ar: 'الكبير بعشرة',
		})
		expect((await quote(sized('var-small'))).totalDiscountMinor).toBe(0)
	})

	it('a spend ladder gives the step the order reaches', async () => {
		activeContext = menuContext([
			makeDiscount({
				id: 'disc_ladder',
				name: 'Spend more, save more',
				percentBp: null,
				currency: 'USD',
				target: {
					scope: 'order',
					itemIds: [],
					categoryIds: [],
					excludeItemIds: [],
					excludeCategoryIds: [],
				},
				tiers: {
					basis: 'spend',
					steps: [
						{ at: 1000, percentBp: 1000, amountMinor: null },
						{ at: 5000, percentBp: 2500, amountMinor: null },
					],
				},
			}),
		])
		// 15.30 reaches the 10.00 step: 10% of 15.30, rounded down.
		const one = await quote(quoteBody())
		expect(one.totalDiscountMinor).toBe(153)
		// Six pizzas reach the 50.00 step: 25%.
		const many = await quote({
			...quoteBody([]),
			lines: [{ itemId: 'item-pizza', quantity: 5, options: [] }],
		})
		expect(many.subtotalMinor).toBe(6000)
		expect(many.totalDiscountMinor).toBe(1500)
		// Below the first step there is nothing.
		const none = await quote({
			...quoteBody([]),
			lines: [
				{
					itemId: 'item-sized',
					variantId: 'var-small',
					quantity: 1,
					options: [],
				},
			],
		})
		expect(none.totalDiscountMinor).toBe(0)
	})
})
