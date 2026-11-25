import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { operatorOrderRoutes } from './operator-orders.ts'

/**
 * The operator's Address check on the delivery zones screen (#266): the same
 * coverage the guest quote runs, from the operator's browser, behind the orders
 * token. Nothing is signed, stored or logged.
 */

const SECRET = 'test-operator-secret-key-for-delivery-check-32!!'
const ORG = 'org_dcheck_a'
const ORG_B = 'org_dcheck_b'
const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const LOOP = { lat: 41.8853, lng: -87.6229 }
const ALL_DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
].map((day) => ({ day, isOpen: true, slots: [{ start: '00:00', end: '23:59' }] }))

const zone = (overrides: Record<string, unknown>) => ({
	id: 'zone',
	name: 'Zone',
	provider: 'in_house',
	restriction: 'allowed',
	type: 'radius',
	radius: { value: 5, unit: 'miles' },
	zipCodes: [],
	polygon: [],
	minimumOrder: 0,
	deliveryFee: 3,
	enabled: true,
	...overrides,
})

function context(zones: unknown[], extra: Record<string, unknown> = {}) {
	return {
		orgId: ORG,
		dataRegion: 'us',
		menu: {
			organization: { id: ORG, slug: ORG, currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Loop',
					timezone: 'UTC',
					taxRate: 0,
					prepTime: 15,
					currency: 'USD',
					address: {
						formattedAddress: '123 Demo Street',
						city: 'Chicago',
						state: 'IL',
						postalCode: '60601',
						country: 'US',
						...LOOP,
					},
					fulfillmentOptions: {
						pickup: true,
						delivery: true,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: { pickupTips: true, deliveryTips: true, dineInTips: true },
					scheduling: { scheduledOrdersEnabled: true, advanceOrderDays: 7 },
					deliveryConfig: {
						providers: ['in_house'],
						estimatedDeliveryTimeMin: 30,
						estimatedDeliveryTimeMax: 50,
						zonePriority: 'order',
					},
					deliveryZones: zones,
					onlineHours: ALL_DAYS,
					...extra,
				},
			],
			menus: [],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: false, processor: null },
	}
}

let tempDir: string
let activeContext: unknown
const app = new Hono()
app.route('/operator/orders', operatorOrderRoutes)

async function token(
	claims: Record<string, unknown> = { scope: 'orders:read' },
	orgId = ORG,
) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({ role: 'operator', orgId, ...claims })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject('usr_1')
		.setIssuer(brand.shortName)
		.setAudience('tenant-api-operator')
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(SECRET))
}

const check = async (
	body: Record<string, unknown>,
	claims?: Record<string, unknown>,
	orgId = ORG,
) =>
	app.request('/operator/orders/delivery-check', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			Authorization: `Bearer ${await token(claims, orgId)}`,
		},
		body: JSON.stringify(body),
	})

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'op-delivery-check-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = SECRET
	process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-token-very-long-and-secure-12345'
	process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
	process.env.APP_URL = 'https://app.test'
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as PublishedOrganization)
		await provisionTenantDb(id)
	}
	activeContext = context([
		zone({ id: 'wide', name: 'Wide area', radius: { value: 20, unit: 'miles' }, deliveryFee: 6, minimumOrder: 5 }),
		zone({ id: 'ring', name: 'Free ring', radius: { value: 3, unit: 'miles' }, deliveryFee: 0, minimumOrder: 20 }),
	])
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes('/resources/order-context')
				? new Response(JSON.stringify(activeContext), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					})
				: new Response('not found', { status: 404 }),
		),
	)
})

afterEach(async () => {
	vi.unstubAllGlobals()
	for (const id of [ORG, ORG_B]) await destroyTenantDb(id).catch(() => {})
	rmSync(tempDir, { recursive: true, force: true })
})

describe('POST /operator/orders/delivery-check (#266)', () => {
	it('names the zone that applies, with its fee and minimum', async () => {
		const response = await check({
			locationId: 'loc-1',
			address: '233 South Wacker Drive, Chicago',
		})
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('private, no-store')
		const body = await response.json()
		expect(body.status).toBe('deliverable')
		// The list is the priority: "Wide area" is first.
		expect(body.quote).toMatchObject({
			zoneId: 'wide',
			zoneName: 'Wide area',
			deliveryFee: 6,
			minimumOrder: 5,
		})
		// Nothing is signed for an operator check.
		expect(body.quote.token).toBeUndefined()
	})

	it('shows the fee at a given order size', async () => {
		activeContext = context([
			zone({
				id: 'stepped',
				name: 'Stepped',
				minimumOrder: 10,
				deliveryFee: 5,
				feeSteps: [
					{ from: 10, fee: 5 },
					{ from: 20, fee: 0 },
				],
			}),
		])
		const body = await (
			await check({ locationId: 'loc-1', address: '233 South Wacker Drive, Chicago', subtotal: 25 })
		).json()
		expect(body.quote.deliveryFee).toBe(0)
	})

	it('gives the reason when delivery is not available', async () => {
		const outside = await (
			await check({ locationId: 'loc-1', address: '350 5th Avenue, New York' })
		).json()
		expect(outside).toMatchObject({ status: 'out_of_range', reason: 'out_of_range' })
		activeContext = context([
			zone({ id: 'wide' }),
			zone({
				id: 'campus',
				name: 'Campus',
				restriction: 'disallowed',
				type: 'zip_code',
				zipCodes: ['60606'],
			}),
		])
		const excluded = await (
			await check({ locationId: 'loc-1', address: '233 South Wacker Drive, Chicago' })
		).json()
		expect(excluded).toMatchObject({
			status: 'out_of_range',
			reason: 'excluded',
			excludedBy: 'Campus',
		})
		activeContext = context([zone({ enabled: false })])
		expect(
			await (
				await check({ locationId: 'loc-1', address: '233 South Wacker Drive, Chicago' })
			).json(),
		).toEqual({ status: 'unavailable', reason: 'no_zones' })
		activeContext = context([zone({ id: 'wide' })])
		const missing = await (
			await check({ locationId: 'loc-1', address: '1 Nonexistent Lane, Atlantis' })
		).json()
		expect(missing).toEqual({ status: 'not_found' })
	})

	it('refuses a missing, forged, wrong-audience or other-organization token', async () => {
		const body = JSON.stringify({ locationId: 'loc-1', address: '233 South Wacker Drive' })
		const call = (headers: Record<string, string>) =>
			app.request('/operator/orders/delivery-check', {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body,
			})
		expect((await call({})).status).toBe(401)
		expect((await call({ Authorization: 'Bearer forged.token.value' })).status).toBe(401)
		const wrongAudience = await new jose.SignJWT({
			role: 'operator',
			orgId: ORG,
			scope: 'orders:read',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuer(brand.shortName)
			.setAudience('someone-else')
			.setExpirationTime('5m')
			.sign(new TextEncoder().encode(SECRET))
		expect((await call({ Authorization: `Bearer ${wrongAudience}` })).status).toBe(401)
		// A token for another organization checks that organization's context only:
		// the context the App returns names ORG, so ORG_B's read is refused.
		const other = await check(
			{ locationId: 'loc-1', address: '233 South Wacker Drive' },
			{ scope: 'orders:read' },
			ORG_B,
		)
		expect(other.status).toBe(503)
		// A token scoped to something else is not an orders token.
		expect(
			(await check({ locationId: 'loc-1', address: '233 South Wacker Drive' }, { scope: 'people' })).status,
		).toBe(403)
	})

	it('keeps a location-limited member to their own locations and rejects a bad body', async () => {
		const outsideScope = await check(
			{ locationId: 'loc-1', address: '233 South Wacker Drive' },
			{ scope: 'orders:read', locationIds: ['loc-other'] },
		)
		expect(outsideScope.status).toBe(404)
		expect((await check({ locationId: 'loc-1' })).status).toBe(400)
		expect(
			(await check({ locationId: 'loc-1', address: '233 South Wacker Drive', extra: 1 })).status,
		).toBe(400)
	})
})
