import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	marketingCampaigns,
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
import { ensureShortLink } from '../services/short-links.ts'
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
 * #115 at placement: the order stores where the guest came from, from a strict
 * payload the browser (or the customer app) sends, for up to 7 days.
 */

const orgId = 'org_attribution_1'
const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-03-10T12:00:00.000Z').getTime()
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

const context = {
	orgId,
	dataRegion: 'us',
	menu: {
		organization: {
			id: orgId,
			slug: 'test-org',
			currency: 'USD',
			defaultLocale: 'en',
		},
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
								id: 'item-burger',
								displayName: 'Burger',
								price: 10,
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
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

describe('order attribution at placement (#115)', () => {
	let directory: string
	let app: Hono
	const headers = {
		'content-type': 'application/json',
		origin: 'https://test-org.example.com',
	}
	const postOrder = (body: unknown) =>
		app.request('/orders', {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		})

	async function storedOrder(id: string) {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, id))
		return row!
	}
	async function place(attribution?: unknown) {
		const res = await postOrder(
			orderBody(attribution === undefined ? {} : { attribution }),
		)
		expect(res.status, await res.clone().text()).toBe(201)
		const placed = (await res.json()) as { order: { id: string } }
		return storedOrder(placed.order.id)
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-attribution-'))
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
		vi.setSystemTime(NOW)
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return new Response(JSON.stringify(context), {
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

	it('an order with no attribution is direct', async () => {
		const row = await place()
		expect(row.attributionSource).toBe('direct')
		expect(row.attribution).toBeNull()
	})

	async function broadcast() {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.insert(marketingCampaigns)
			.values({ name: 'Spring brunch', channel: 'email', status: 'Completed' })
			.returning({ id: marketingCampaigns.id })
		return row!.id
	}

	it('stores the campaign, the UTM values and the source of an email click', async () => {
		const campaignId = await broadcast()
		const row = await place({
			utmSource: 'menuza',
			utmMedium: 'email',
			utmCampaign: 'spring-brunch',
			campaignId,
			touchedAt: NOW - 3600_000,
		})
		expect(row.attributionSource).toBe('email')
		expect(row.attribution).toMatchObject({
			utmSource: 'menuza',
			utmMedium: 'email',
			utmCampaign: 'spring-brunch',
			campaignId,
		})
	})

	it('drops a campaign or step id this organization does not have, so a crafted link credits nothing', async () => {
		const row = await place({
			utmSource: 'menuza',
			utmMedium: 'email',
			campaignId: 'someone-elses-campaign',
			stepId: 'step-1',
			touchedAt: NOW - 3600_000,
		})
		expect(row.attribution).not.toHaveProperty('campaignId')
		expect(row.attribution).not.toHaveProperty('stepId')
		// What is left is only the visitor's own UTM source.
		expect(row.attributionSource).toBe('menuza')
	})

	it('a UTM visit two days earlier is still credited, one 8 days earlier is not', async () => {
		const credited = await place({
			utmSource: 'newsletter',
			utmCampaign: 'winter',
			touchedAt: NOW - 2 * DAY,
		})
		expect(credited.attributionSource).toBe('newsletter')
		expect(credited.attribution).toMatchObject({ utmCampaign: 'winter' })
		const stale = await place({
			utmSource: 'newsletter',
			touchedAt: NOW - 8 * DAY,
		})
		expect(stale.attributionSource).toBe('direct')
		expect(stale.attribution).toBeNull()
	})

	it('stores the short-link id when the guest came from one that exists, and drops one that does not', async () => {
		const db = await getTenantDb(orgId)
		const link = await ensureShortLink(db, {
			kind: 'link',
			targetPath: '/menu',
		})
		const campaignId = await broadcast()
		const row = await place({
			shortLinkId: link.id,
			campaignId,
			touchedAt: NOW - 3600_000,
		})
		expect(row.attributionSource).toBe('short_link')
		expect(row.attribution).toMatchObject({
			shortLinkId: link.id,
			campaignId,
		})
		const made = await place({ shortLinkId: 'made-up-id', touchedAt: NOW })
		expect(made.attributionSource).toBe('direct')
		expect(made.attribution).toBeNull()
	})

	it('refuses an oversized value or an unknown field, and places nothing', async () => {
		for (const attribution of [
			{ utmSource: 'x'.repeat(101), touchedAt: NOW },
			{ utmSource: 'a', visitorId: 'v-123', touchedAt: NOW },
			{ ip: '203.0.113.9' },
			{ touchedAt: 'yesterday' },
		]) {
			const res = await postOrder(orderBody({ attribution }))
			expect(res.status, JSON.stringify(attribution)).toBe(400)
		}
		const db = await getTenantDb(orgId)
		expect(await db.select().from(restaurantOrders)).toHaveLength(0)
	})

	it('strips control characters and keeps values to 100 characters', async () => {
		const row = await place({
			utmSource: 'news\u0007letter',
			utmCampaign: 'a'.repeat(100),
			touchedAt: NOW,
		})
		expect(row.attribution).toMatchObject({
			utmSource: 'newsletter',
			utmCampaign: 'a'.repeat(100),
		})
	})

	it('a retry of the same order keeps the first attribution', async () => {
		const body = orderBody({
			attribution: { utmSource: 'first', touchedAt: NOW },
		})
		const first = await postOrder(body)
		const again = await postOrder({
			...body,
			attribution: { utmSource: 'second', touchedAt: NOW },
		})
		const id = ((await first.json()) as { order: { id: string } }).order.id
		expect(again.status).toBeLessThan(500)
		expect((await storedOrder(id)).attributionSource).toBe('first')
	})
})
