import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customerAddresses,
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	signDeliveryQuote,
	type DeliveryQuotePayload,
} from '../lib/delivery-quote-token.ts'
import { setGeocoderForTesting } from '../lib/geocoder.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { erasePerson } from '../services/person-erasure-service.ts'
import { customerAddressRoutes } from './customer-addresses.ts'
import { publicDeliveryRoutes } from './delivery.ts'

const orgId = 'org_saved_addresses_1'
const jwtSecret = 'test-jwt-secret-123456789'
const hmacSecret = 'test-hmac-secret-123456789'

const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}

vi.mock('../lib/origin.ts', () => {
	const make = (id: string, slug: string) => ({
		id,
		slug,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	})
	const orgs: Record<string, ReturnType<typeof make>> = {
		org_saved_addresses_1: make('org_saved_addresses_1', 'test-org'),
		org_saved_addresses_2: make('org_saved_addresses_2', 'other-org'),
	}
	return {
		findActiveOrganizationById: vi.fn(async (id: string) => orgs[id] ?? null),
		lookupActiveOrganization: vi.fn(async (id: string) =>
			orgs[id]
				? { status: 'found', organization: orgs[id] }
				: { status: 'not_found' },
		),
		resolveOrganizationForBrowserAuth: vi.fn(
			async (_origin: unknown, identity?: { slug?: string }) =>
				identity?.slug === 'test-org' ? orgs.org_saved_addresses_1 : null,
		),
		resolvePublishedOrganization: vi.fn(async () => null),
	}
})

const STORE = { lat: 41.8853, lng: -87.6229 }
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

function zone(overrides: Record<string, unknown> = {}) {
	return {
		id: 'zone-1',
		name: 'Standard Delivery Area',
		provider: 'in_house',
		restriction: 'allowed',
		type: 'radius',
		radius: { value: 5, unit: 'miles' },
		zipCodes: [],
		polygon: [],
		minimumOrder: 15,
		deliveryFee: 3.99,
		enabled: true,
		...overrides,
	}
}

function menuContext(zones: unknown[]) {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Demo Bistro',
					timezone: 'UTC',
					taxRate: 0,
					prepTime: 15,
					currency: 'USD',
					address: {
						formattedAddress: '123 Demo Street, Chicago, IL, 60601, US',
						city: 'Chicago',
						state: 'IL',
						postalCode: '60601',
						country: 'US',
						...STORE,
					},
					fulfillmentOptions: { pickup: true, delivery: true, dineIn: false },
					scheduling: { scheduledOrdersEnabled: true, advanceOrderDays: 7 },
					deliveryConfig: {
						providers: ['in_house'],
						estimatedDeliveryTimeMin: 30,
						estimatedDeliveryTimeMax: 50,
					},
					deliveryZones: zones,
					onlineHours: ALL_DAYS,
				},
			],
			menus: [],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: false, processor: null },
	}
}

function quotePayload(
	overrides: Partial<DeliveryQuotePayload> = {},
): DeliveryQuotePayload {
	return {
		orgId,
		locationId: 'loc-1',
		lat: 41.8789,
		lng: -87.6359,
		formatted: '233 South Wacker Drive, Chicago, IL 60606, USA',
		line1: '233 South Wacker Drive',
		city: 'Chicago',
		state: 'IL',
		postalCode: '60606',
		country: 'US',
		unit: 'Suite 4',
		exp: Date.now() + 60 * 60 * 1000,
		...overrides,
	}
}

let app: Hono
let tempDir: string
let activeContext: unknown
let aliceId: string
let bobId: string
let alice: string
let bob: string

async function tokenFor(customerId: string) {
	return new SignJWT({
		customerId,
		orgId,
		orgSlug: 'test-org',
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api')
		.setIssuer('menuza')
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(jwtSecret))
}

function call(
	method: string,
	url: string,
	options: { bearer?: string | null; body?: unknown } = {},
) {
	const bearer = options.bearer === undefined ? alice : options.bearer
	return app.request(url, {
		method,
		headers: {
			'content-type': 'application/json',
			origin: 'https://test-org.example.com',
			...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
		},
		...(options.body !== undefined
			? { body: JSON.stringify(options.body) }
			: {}),
	})
}

async function save(
	overrides: Record<string, unknown> = {},
	payload: Partial<DeliveryQuotePayload> = {},
	bearer: string | null = alice,
) {
	const quoteToken = await signDeliveryQuote(quotePayload(payload))
	return call('POST', '/customer/addresses', {
		bearer,
		body: {
			locationId: 'loc-1',
			quoteToken,
			label: 'Home',
			...overrides,
		},
	})
}

async function quoteAddress(addressId: string, bearer: string | null = alice) {
	return call('POST', '/delivery/quote', {
		bearer,
		body: { slug: 'test-org', locationId: 'loc-1', addressId },
	})
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-addresses-'))
	vi.stubEnv('TENANT_DB_DIR', tempDir)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('JWT_SECRET', jwtSecret)
	vi.stubEnv('AUTH_HMAC_SECRET', hmacSecret)
	vi.stubEnv('APP_URL', 'https://app.test')
	vi.stubEnv(
		'INTERNAL_COMMAND_TOKEN',
		'test-internal-token-very-long-and-secure-12345',
	)
	vi.stubEnv('GOOGLE_MAPS_API_KEY', '')
	syncEnvFromProcess()
	activeContext = menuContext([zone()])
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
	await provisionTenantDb(orgId)
	const db = await getTenantDb(orgId)
	const [a] = await db
		.insert(customers)
		.values({
			name: 'Alice Example',
			phone: '+15555550301',
			phoneVerified: true,
		})
		.returning()
	const [b] = await db
		.insert(customers)
		.values({ name: 'Bob Example', phone: '+15555550302', phoneVerified: true })
		.returning()
	aliceId = a!.id
	bobId = b!.id
	alice = await tokenFor(aliceId)
	bob = await tokenFor(bobId)
	app = new Hono()
	app.route('/customer/addresses', customerAddressRoutes)
	app.route('/delivery', publicDeliveryRoutes)
})

afterEach(async () => {
	setGeocoderForTesting(undefined)
	await destroyTenantDb(orgId)
	fs.rmSync(tempDir, { recursive: true, force: true })
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe('POST /customer/addresses (#113)', () => {
	it('needs a customer token', async () => {
		expect(
			(await call('GET', '/customer/addresses', { bearer: null })).status,
		).toBe(401)
		expect((await save({}, {}, null)).status).toBe(401)
	})

	it('saves a geocoded address from its quote token and never returns the point', async () => {
		const response = await save({ notes: 'Gate code 4411' })
		expect(response.status).toBe(201)
		const { address } = (await response.json()) as {
			address: Record<string, unknown>
		}
		expect(address).toMatchObject({
			label: 'Home',
			line1: '233 South Wacker Drive',
			unit: 'Suite 4',
			city: 'Chicago',
			postalCode: '60606',
			notes: 'Gate code 4411',
			isDefault: true,
		})
		expect(address).not.toHaveProperty('lat')
		expect(address).not.toHaveProperty('lng')
		const list = (await (await call('GET', '/customer/addresses')).json()) as {
			addresses: unknown[]
			limit: number
		}
		expect(list.addresses).toHaveLength(1)
		expect(list.limit).toBe(10)
		// The stored point is the one the signed token carried.
		const db = await getTenantDb(orgId)
		const [row] = await db.select().from(customerAddresses)
		expect(row).toMatchObject({
			lat: 41.8789,
			lng: -87.6359,
			customerId: aliceId,
		})
	})

	it('refuses free text: only a signed, unexpired quote for this organization and location', async () => {
		const forged = await call('POST', '/customer/addresses', {
			body: {
				locationId: 'loc-1',
				quoteToken: 'dq1.e30.' + 'A'.repeat(43),
				label: 'Home',
			},
		})
		expect(forged.status).toBe(422)
		expect(((await forged.json()) as { error: string }).error).toBe(
			'invalid_quote_token',
		)
		expect((await save({}, { exp: Date.now() - 1000 })).status).toBe(422)
		expect((await save({}, { orgId: 'another-org' })).status).toBe(422)
		expect((await save({}, { locationId: 'loc-2' })).status).toBe(422)
		// A body with an address typed by hand has no place to put it.
		const typed = await call('POST', '/customer/addresses', {
			body: { label: 'Home', address: '1 Main St', lat: 1, lng: 2 },
		})
		expect(typed.status).toBe(400)
	})

	it('keeps notes to 280 characters', async () => {
		expect((await save({ notes: 'x'.repeat(281) })).status).toBe(400)
		expect((await save({ notes: 'x'.repeat(280) })).status).toBe(201)
	})

	it('allows up to 10 addresses per customer, per customer', async () => {
		for (let i = 0; i < 10; i += 1) {
			expect((await save({ label: `Place ${i}` })).status).toBe(201)
		}
		const over = await save({ label: 'Eleventh' })
		expect(over.status).toBe(409)
		expect(((await over.json()) as { error: string }).error).toBe(
			'address_limit_reached',
		)
		// Another guest has their own ten.
		expect((await save({ label: 'Bobs' }, {}, bob)).status).toBe(201)
	})

	it('keeps exactly one default: new default, make default, delete the default', async () => {
		const first = (await (await save({ label: 'Home' })).json()) as {
			address: { id: string; isDefault: boolean }
		}
		const second = (await (await save({ label: 'Work' })).json()) as {
			address: { id: string; isDefault: boolean }
		}
		expect(first.address.isDefault).toBe(true)
		expect(second.address.isDefault).toBe(false)
		const third = (await (
			await save({ label: 'Mum', makeDefault: true })
		).json()) as { address: { id: string; isDefault: boolean } }
		expect(third.address.isDefault).toBe(true)
		const defaults = async () => {
			const list = (await (
				await call('GET', '/customer/addresses')
			).json()) as {
				addresses: Array<{ id: string; label: string; isDefault: boolean }>
			}
			return list.addresses.filter((a) => a.isDefault).map((a) => a.label)
		}
		expect(await defaults()).toEqual(['Mum'])
		const patched = await call(
			'PATCH',
			`/customer/addresses/${first.address.id}`,
			{
				body: { isDefault: true, label: 'House' },
			},
		)
		expect(patched.status).toBe(200)
		expect(await defaults()).toEqual(['House'])
		// Deleting the default promotes the newest remaining one.
		expect(
			(await call('DELETE', `/customer/addresses/${first.address.id}`)).status,
		).toBe(200)
		expect(await defaults()).toEqual(['Mum'])
	})

	it('renames and edits the unit and notes, clearing them with null', async () => {
		const { address } = (await (
			await save({ notes: 'ring twice' })
		).json()) as {
			address: { id: string }
		}
		const patched = (await (
			await call('PATCH', `/customer/addresses/${address.id}`, {
				body: { label: 'Work', unit: 'Floor 9', notes: null },
			})
		).json()) as {
			address: { label: string; unit: string | null; notes: string | null }
		}
		expect(patched.address).toMatchObject({
			label: 'Work',
			unit: 'Floor 9',
			notes: null,
		})
		expect(
			(await call('PATCH', `/customer/addresses/${address.id}`, { body: {} }))
				.status,
		).toBe(400)
	})
})

describe("another guest's address id answers 404", () => {
	it('on read-by-patch, delete and quote, the same body as an id that does not exist', async () => {
		const { address } = (await (await save({ label: 'Home' })).json()) as {
			address: { id: string }
		}
		const patch = await call('PATCH', `/customer/addresses/${address.id}`, {
			bearer: bob,
			body: { label: 'Mine now' },
		})
		const missingPatch = await call('PATCH', '/customer/addresses/nope', {
			bearer: bob,
			body: { label: 'x' },
		})
		expect(patch.status).toBe(404)
		expect(await patch.json()).toEqual(await missingPatch.json())
		const del = await call('DELETE', `/customer/addresses/${address.id}`, {
			bearer: bob,
		})
		expect(del.status).toBe(404)
		const quote = await quoteAddress(address.id, bob)
		const missingQuote = await quoteAddress('nope', bob)
		expect(quote.status).toBe(404)
		expect(await quote.json()).toEqual(await missingQuote.json())
		// Bob's list never shows it, and Alice's address is untouched.
		const bobList = (await (
			await call('GET', '/customer/addresses', { bearer: bob })
		).json()) as { addresses: unknown[] }
		expect(bobList.addresses).toEqual([])
		const aliceList = (await (
			await call('GET', '/customer/addresses')
		).json()) as {
			addresses: Array<{ label: string }>
		}
		expect(aliceList.addresses.map((a) => a.label)).toEqual(['Home'])
	})
})

describe('POST /delivery/quote with addressId (#113)', () => {
	it('quotes a saved address again with a fresh signed token and the zone as it is now', async () => {
		const { address } = (await (
			await save({ notes: 'Gate code 4411' })
		).json()) as { address: { id: string } }
		const first = (await (await quoteAddress(address.id)).json()) as {
			status: string
			quote: { deliveryFee: number; token: string; address: { unit: string } }
			savedAddress: { id: string; label: string; notes: string }
		}
		expect(first.status).toBe('deliverable')
		expect(first.quote.deliveryFee).toBe(3.99)
		expect(first.quote.address.unit).toBe('Suite 4')
		expect(first.quote.token).toMatch(/^dq1\./)
		expect(first.savedAddress).toMatchObject({
			id: address.id,
			label: 'Home',
			notes: 'Gate code 4411',
		})
		// The operator changes the fee: the next quote sees it, nothing was cached.
		activeContext = menuContext([zone({ deliveryFee: 6.5 })])
		const second = (await (await quoteAddress(address.id)).json()) as {
			quote: { deliveryFee: number }
		}
		expect(second.quote.deliveryFee).toBe(6.5)
	})

	it('answers out_of_range, not a stale price, when the address left every zone', async () => {
		const { address } = (await (await save()).json()) as {
			address: { id: string }
		}
		activeContext = menuContext([
			zone({ radius: { value: 0.1, unit: 'miles' } }),
		])
		const body = (await (await quoteAddress(address.id)).json()) as {
			status: string
			quote?: unknown
		}
		expect(body.status).toBe('out_of_range')
		expect(body.quote).toBeUndefined()
	})

	it('needs the customer token for a saved address, and the token of this organization', async () => {
		const { address } = (await (await save()).json()) as {
			address: { id: string }
		}
		expect((await quoteAddress(address.id, null)).status).toBe(401)
		await provisionTenantDb('org_saved_addresses_2')
		const otherDb = await getTenantDb('org_saved_addresses_2')
		await otherDb
			.insert(customers)
			.values({ id: aliceId, name: 'Alice Elsewhere', phone: '+15555550399' })
		const otherOrg = await new SignJWT({
			customerId: aliceId,
			orgId: 'org_saved_addresses_2',
			orgSlug: 'other-org',
			type: 'access',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api')
			.setIssuer('menuza')
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode(jwtSecret))
		const response = await quoteAddress(address.id, otherOrg)
		expect(response.status).toBe(404)
		await destroyTenantDb('org_saved_addresses_2')
	})

	it('still quotes a typed address without any token', async () => {
		const response = await call('POST', '/delivery/quote', {
			bearer: null,
			body: {
				slug: 'test-org',
				locationId: 'loc-1',
				placeId: 'dev_chi_wacker_233',
			},
		})
		expect(response.status).toBe(200)
		expect(((await response.json()) as { status: string }).status).toBe(
			'deliverable',
		)
	})
})

describe('person erasure (#113)', () => {
	it('deletes every saved address of the person and only theirs', async () => {
		await save({ label: 'Home' })
		await save({ label: 'Work' })
		await save({ label: 'Bobs' }, {}, bob)
		const db = await getTenantDb(orgId)
		const result = await erasePerson(
			db,
			{ customerId: aliceId },
			{ actorId: 'user_1' },
		)
		expect(result).toBeDefined()
		const left = await db.select().from(customerAddresses)
		expect(left.map((row) => row.customerId)).toEqual([bobId])
		expect(
			await db
				.select()
				.from(customerAddresses)
				.where(eq(customerAddresses.customerId, aliceId)),
		).toEqual([])
	})
})
