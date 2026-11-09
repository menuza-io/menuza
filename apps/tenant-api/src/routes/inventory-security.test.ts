import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	INVENTORY_ERROR_CODES,
	INVENTORY_PERMISSIONS,
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_TYP,
	type InventoryFeatures,
	type InventoryScope,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invPrepTasks,
	invSoldOut,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import * as jose from 'jose'
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
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Security sweep for `/operator/inventory/*`, modelled on
 * `loyalty-security.test.ts`: the control plane (`../lib/origin.ts`) is
 * mocked, every organization gets a real provisioned tenant database, and
 * tokens are minted and forged with jose directly. Every route the router
 * declares is swept, so a new route is covered (or fails) automatically.
 */

const OPERATOR_SECRET = 'inv-sec-operator-token-0123456789abcdef'
const CUSTOMER_SECRET = 'inv-sec-customer-jwt-secret-0123456789'

const ORG_A = 'org_inv_sec_a'
const ORG_B = 'org_inv_sec_b'
const ORG_KSA = 'org_inv_sec_ksa'
const ORG_UNPROVISIONED = 'org_inv_sec_unprov'
const ORG_UNKNOWN = 'org_inv_sec_unknown'

const LOC_A = 'loc_a'
const LOC_B = 'loc_b'

const FEATURES_ON: InventoryFeatures = {
	enabled: true,
	purchasing: true,
	recipes: true,
	prep: true,
	transfers: true,
}
const FEATURES_OFF: InventoryFeatures = { ...FEATURES_ON, enabled: false }
const FEATURES_NO_PURCHASING: InventoryFeatures = {
	...FEATURES_ON,
	purchasing: false,
}
const FEATURES_NO_TRANSFERS: InventoryFeatures = {
	...FEATURES_ON,
	transfers: false,
}
const FEATURES_NO_PREP: InventoryFeatures = {
	...FEATURES_ON,
	prep: false,
}
const FEATURES_NO_RECIPES: InventoryFeatures = {
	...FEATURES_ON,
	recipes: false,
}

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const COST = INVENTORY_PERMISSIONS.READ_INVENTORY_COST
const PURCHASING = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING
const RECIPE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_RECIPE

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		if (id === 'org_inv_sec_outage') return { status: 'unavailable' as const }
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const app = new Hono()
app.route('/operator/inventory', operatorInventoryRoutes)

const ROUTES = (() => {
	const seen = new Set<string>()
	const list: Array<{ method: string; path: string }> = []
	for (const route of app.routes) {
		if (route.method === 'ALL') continue
		const key = `${route.method} ${route.path}`
		if (seen.has(key)) continue
		seen.add(key)
		list.push({ method: route.method, path: route.path })
	}
	return list
})()

/**
 * Every operator route and the grant it needs (its scope follows: reads take a
 * read or write token, everything else a write token). The discovery test
 * compares this table with the routes the router declares.
 */
const ROUTE_GRANTS: Record<
	string,
	typeof READ | typeof UPDATE | typeof PURCHASING | typeof COST | typeof RECIPE
> = {
	'GET /settings': READ,
	'PUT /settings': UPDATE,
	'GET /status': READ,
	'GET /today': READ,
	'GET /items': READ,
	'POST /items': UPDATE,
	'POST /items/bulk': UPDATE,
	'GET /items/:id': READ,
	'PATCH /items/:id': UPDATE,
	'POST /items/:id/archive': UPDATE,
	'POST /items/:id/restore': UPDATE,
	'POST /items/:id/units': UPDATE,
	'PUT /items/:id/places/:locationId': UPDATE,
	'POST /items/:id/adjust': UPDATE,
	'GET /items/:id/movements': READ,
	'GET /storage-areas': READ,
	'POST /storage-areas': UPDATE,
	'POST /storage-areas/reorder': UPDATE,
	'PATCH /storage-areas/:id': UPDATE,
	'PUT /storage-areas/:id/items': UPDATE,
	'POST /storage-areas/:id/archive': UPDATE,
	'GET /count-lists': READ,
	'POST /count-lists': UPDATE,
	'PATCH /count-lists/:id': UPDATE,
	'POST /count-lists/:id/archive': UPDATE,
	'GET /counts': READ,
	'POST /counts': UPDATE,
	'GET /counts/:id': READ,
	'POST /counts/:id/entries': UPDATE,
	'POST /counts/:id/send': UPDATE,
	'POST /counts/:id/reopen': UPDATE,
	'POST /counts/:id/cancel': UPDATE,
	'GET /counts/:id/review': READ,
	'POST /counts/:id/approve': UPDATE,
	'GET /waste': READ,
	'GET /waste/summary': READ,
	'POST /waste': UPDATE,
	'POST /waste/:id/undo': UPDATE,
	'GET /suppliers': READ,
	'POST /suppliers': PURCHASING,
	'GET /suppliers/:id': READ,
	'PATCH /suppliers/:id': PURCHASING,
	'POST /suppliers/:id/archive': PURCHASING,
	'POST /suppliers/:id/products': PURCHASING,
	'PATCH /supplier-products/:id': PURCHASING,
	'POST /supplier-products/:id/archive': PURCHASING,
	'GET /deliveries': READ,
	'POST /deliveries': UPDATE,
	'GET /deliveries/:id': READ,
	'POST /deliveries/:id/paid': PURCHASING,
	'POST /deliveries/:id/cancel': UPDATE,
	// Phase 2.
	'POST /deliveries/:id/confirm-prices': PURCHASING,
	'POST /deliveries/:id/credit-message': READ,
	'POST /deliveries/:id/invoice-photo': UPDATE,
	'POST /deliveries/:id/invoice-photo/confirm': UPDATE,
	'POST /deliveries/:id/invoice-photo/read': PURCHASING,
	'GET /price-alerts': COST,
	'GET /levels': READ,
	'GET /levels/suggestions': READ,
	'PUT /levels/bulk': PURCHASING,
	'GET /orders/suggested': READ,
	'POST /orders': PURCHASING,
	'GET /orders': READ,
	'GET /orders/:id': READ,
	'PATCH /orders/:id': PURCHASING,
	'POST /orders/:id/send': PURCHASING,
	'POST /orders/:id/cancel': PURCHASING,
	'GET /orders/:id/text': READ,
	'GET /orders/:id/receive-prefill': READ,
	// Phase 3: recipes (need the inventory.recipes flag).
	'GET /recipes': READ,
	'PUT /recipes': RECIPE,
	'POST /recipes/clear': RECIPE,
	'POST /recipes/costs': READ,
	'GET /recipes/missing': READ,
	'POST /items/:id/batch': UPDATE,
	'GET /sold-out': READ,
	'POST /sold-out/:id/undo': UPDATE,
	// Phase 4: prep (needs the inventory.prep flag).
	'GET /prep': READ,
	'POST /prep/generate': UPDATE,
	'GET /prep/levels': READ,
	'PUT /prep/levels': UPDATE,
	'POST /prep/tasks/:id/start': UPDATE,
	'POST /prep/tasks/:id/done': UPDATE,
	'POST /prep/tasks/:id/skip': UPDATE,
	// Phase 5: transfers (need the inventory.transfers flag).
	'GET /compare': READ,
	'GET /transfers': READ,
	'POST /transfers': UPDATE,
	'GET /transfers/:id': READ,
	'PATCH /transfers/:id': UPDATE,
	'POST /transfers/:id/send': UPDATE,
	'POST /transfers/:id/receive': UPDATE,
	'POST /transfers/:id/cancel': UPDATE,
}

/** POST routes that change nothing (they only carry a body), so a read grant and an impersonated token may call them. */
const READ_ONLY_POSTS = new Set([
	'POST /deliveries/:id/credit-message',
	'POST /recipes/costs',
])

/** Routes behind the `inventory.purchasing` flag (403 feature_disabled while it is off). */
const PURCHASING_FLAG_ROUTES = new Set([
	'GET /levels',
	'GET /levels/suggestions',
	'PUT /levels/bulk',
	'GET /orders/suggested',
	'POST /orders',
	'GET /orders',
	'GET /orders/:id',
	'PATCH /orders/:id',
	'POST /orders/:id/send',
	'POST /orders/:id/cancel',
	'GET /orders/:id/text',
	'GET /orders/:id/receive-prefill',
])

/** Routes behind the `inventory.transfers` flag (403 feature_disabled while it is off). */
const TRANSFERS_FLAG_ROUTES = new Set([
	'GET /compare',
	'GET /transfers',
	'POST /transfers',
	'GET /transfers/:id',
	'PATCH /transfers/:id',
	'POST /transfers/:id/send',
	'POST /transfers/:id/receive',
	'POST /transfers/:id/cancel',
])

/** Routes behind the `inventory.prep` flag (403 feature_disabled while it is off). */
const PREP_FLAG_ROUTES = new Set([
	'GET /prep',
	'POST /prep/generate',
	'GET /prep/levels',
	'PUT /prep/levels',
	'POST /prep/tasks/:id/start',
	'POST /prep/tasks/:id/done',
	'POST /prep/tasks/:id/skip',
])

/** Routes behind the `inventory.recipes` flag (403 feature_disabled while it is off). */
const RECIPES_FLAG_ROUTES = new Set([
	'GET /recipes',
	'PUT /recipes',
	'POST /recipes/clear',
	'POST /recipes/costs',
	'GET /recipes/missing',
	'POST /items/:id/batch',
	'GET /sold-out',
	'POST /sold-out/:id/undo',
])

function routeKey(route: { method: string; path: string }): string {
	return `${route.method} ${route.path.replace('/operator/inventory', '')}`
}

function isRead(route: {
	method: string
	path: string
	key?: string
}): boolean {
	return (
		route.method === 'GET' || READ_ONLY_POSTS.has(route.key ?? routeKey(route))
	)
}

function grantFor(route: { method: string; path: string }) {
	return ROUTE_GRANTS[
		`${route.method} ${route.path.replace('/operator/inventory', '')}`
	]!
}

/** A request that passes validation, so only the guard can refuse it. */
function validRequest(route: { method: string; path: string }): {
	path: string
	body?: unknown
} {
	if (route.path === '/operator/inventory/status') {
		return { path: `${route.path}?locationId=${LOC_A}` }
	}
	if (route.method === 'PUT' && route.path === '/operator/inventory/settings') {
		return {
			path: route.path,
			body: { expectedVersion: 0, targetFoodCostBp: 2800 },
		}
	}
	return { path: route.path.replace(/:[A-Za-z0-9_]+/g, 'x') }
}

async function mintInventoryToken(
	overrides: {
		orgId?: string
		region?: 'us' | 'ksa'
		scope?: InventoryScope
		grants?: string[]
		locationIds?: string[] | null
		features?: InventoryFeatures
		impersonated?: boolean
		ttlSeconds?: number
		issuedAgoSeconds?: number
		secret?: string
		typ?: string
		audience?: string
		issuer?: string
		extra?: Record<string, unknown>
	} = {},
): Promise<string> {
	const now = Math.floor(Date.now() / 1000) - (overrides.issuedAgoSeconds ?? 0)
	const ttl = overrides.ttlSeconds ?? 300
	return new jose.SignJWT({
		role: 'operator',
		orgId: overrides.orgId ?? ORG_A,
		region: overrides.region ?? 'us',
		scope: overrides.scope ?? 'write',
		grants: overrides.grants ?? [READ, UPDATE, COST, PURCHASING, RECIPE],
		locationIds:
			overrides.locationIds === undefined ? null : overrides.locationIds,
		features: overrides.features ?? FEATURES_ON,
		impersonated: overrides.impersonated ?? false,
		...overrides.extra,
	})
		.setProtectedHeader({
			alg: 'HS256',
			typ: overrides.typ ?? INVENTORY_TOKEN_TYP,
		})
		.setSubject('user_inv_sec')
		.setIssuer(overrides.issuer ?? brand.shortName)
		.setAudience(overrides.audience ?? INVENTORY_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + ttl)
		.sign(new TextEncoder().encode(overrides.secret ?? OPERATOR_SECRET))
}

function call(
	method: string,
	requestPath: string,
	options: { token?: string; body?: unknown } = {},
) {
	const headers: Record<string, string> = {}
	if (options.token) headers.Authorization = `Bearer ${options.token}`
	let body: string | undefined
	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.body)
	}
	return app.request(requestPath, { method, headers, body })
}

async function sweep(
	token: string | undefined,
	expected: { status: number; code: string },
	routes = ROUTES,
): Promise<string[]> {
	const failures: string[] = []
	for (const route of routes) {
		const request = validRequest(route)
		const res = await call(route.method, request.path, {
			token,
			body: request.body,
		})
		const body = (await res.json()) as { error?: string; code?: string }
		if (res.status !== expected.status || body.code !== expected.code) {
			failures.push(
				`${route.method} ${route.path} -> ${res.status} ${body.code ?? body.error}`,
			)
		}
	}
	return failures
}

let tmpDir: string

beforeAll(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-sec-test-'))
	process.env.TENANT_DB_DIR = tmpDir
	process.env.DATA_REGION = 'us'
	process.env.JWT_SECRET = CUSTOMER_SECRET
	process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
	process.env.INTERNAL_COMMAND_TOKEN = 'inv-sec-internal-token-0123456789'
	syncEnvFromProcess()

	const org = (
		id: string,
		dataRegion: 'us' | 'ksa',
		hasProvisionedDb = true,
	): PublishedOrganization => ({
		id,
		slug: id.replace(/_/g, '-'),
		customDomain: null,
		hasProvisionedDb,
		dataRegion,
		name: id,
	})
	orgs.set(ORG_A, org(ORG_A, 'us'))
	orgs.set(ORG_B, org(ORG_B, 'us'))
	orgs.set(ORG_KSA, org(ORG_KSA, 'ksa'))
	orgs.set(ORG_UNPROVISIONED, org(ORG_UNPROVISIONED, 'us', false))
	await provisionTenantDb(ORG_A)
	await provisionTenantDb(ORG_B)
})

afterEach(() => {
	delete process.env.INVENTORY_ENABLED
})

afterAll(async () => {
	await destroyTenantDb(ORG_A)
	await destroyTenantDb(ORG_B)
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('inventory operator routes: discovery', () => {
	it('app.ts mounts the router and every expected route exists', () => {
		const appSource = fs.readFileSync(
			path.resolve(import.meta.dirname, '..', 'app.ts'),
			'utf8',
		)
		expect(appSource).toContain(
			"app.route('/operator/inventory', operatorInventoryRoutes)",
		)
		const keys = ROUTES.map((route) => `${route.method} ${route.path}`).sort()
		// Every route is classified here: a new route fails this test until its
		// grant is listed, so it cannot ship outside the sweeps below.
		expect(keys).toEqual(
			Object.keys(ROUTE_GRANTS)
				.map((key) => key.replace(' ', ' /operator/inventory'))
				.sort(),
		)
	})

	it('a valid token passes the guard on every route (the handler answers, never the guard)', async () => {
		const token = await mintInventoryToken()
		for (const route of ROUTES) {
			const request = validRequest(route)
			const res = await call(route.method, request.path, {
				token,
				body: request.body,
			})
			expect(
				[401, 403, 503].includes(res.status),
				`${route.method} ${route.path} -> ${res.status}`,
			).toBe(false)
			expect(res.headers.get('Cache-Control')).toBe('private, no-store')
		}
		for (const path of [
			'/operator/inventory/settings',
			`/operator/inventory/status?locationId=${LOC_A}`,
		]) {
			expect((await call('GET', path, { token })).status).toBe(200)
		}
	})
})

describe('inventory operator routes: tokens', () => {
	it('refuses every route without a bearer token (401 unauthorized)', async () => {
		expect(
			await sweep(undefined, { status: 401, code: 'unauthorized' }),
		).toEqual([])
	})

	it('refuses forged, mistyped, wrong-audience, wrong-issuer, expired, over-long and malformed tokens on every route (401)', async () => {
		const tokens = {
			forged: await mintInventoryToken({ secret: `${OPERATOR_SECRET}-x` }),
			customerSecret: await mintInventoryToken({ secret: CUSTOMER_SECRET }),
			wrongAudience: await mintInventoryToken({
				audience: 'tenant-api-loyalty-operator',
			}),
			wrongTyp: await mintInventoryToken({ typ: 'lty+jwt' }),
			plainJwt: await mintInventoryToken({ typ: 'JWT' }),
			wrongIssuer: await mintInventoryToken({ issuer: 'someone-else' }),
			expired: await mintInventoryToken({
				issuedAgoSeconds: 600,
				ttlSeconds: 300,
			}),
			overLong: await mintInventoryToken({ ttlSeconds: 15 * 60 + 1 }),
			overLongImpersonated: await mintInventoryToken({
				scope: 'read',
				grants: [READ],
				impersonated: true,
				ttlSeconds: 5 * 60 + 1,
			}),
			// The claims schema refuses write grants on an impersonated token.
			impersonatedWithWrite: await mintInventoryToken({ impersonated: true }),
			grantOutsideScope: await mintInventoryToken({
				scope: 'read',
				grants: [READ, UPDATE],
			}),
			unknownClaim: await mintInventoryToken({ extra: { admin: true } }),
			badOrgId: await mintInventoryToken({ orgId: '../etc/passwd' }),
			noGrants: await mintInventoryToken({ grants: [] }),
		}
		const failures: string[] = []
		for (const [name, token] of Object.entries(tokens)) {
			for (const failure of await sweep(token, {
				status: 401,
				code: 'unauthorized',
			})) {
				failures.push(`${name}: ${failure}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('refuses a token minted for another region on every route (403 forbidden)', async () => {
		const token = await mintInventoryToken({ region: 'ksa' })
		expect(await sweep(token, { status: 403, code: 'forbidden' })).toEqual([])
		const res = await call('GET', '/operator/inventory/settings', { token })
		expect(await res.json()).toMatchObject({ reason: 'region_mismatch' })
	})

	it('answers 404 for unknown, unprovisioned and wrong-region organizations, 503 while the control plane is down', async () => {
		for (const orgId of [ORG_UNKNOWN, ORG_UNPROVISIONED, ORG_KSA]) {
			const token = await mintInventoryToken({ orgId })
			expect(
				await sweep(token, { status: 404, code: 'not_found' }),
				orgId,
			).toEqual([])
		}
		const outage = await mintInventoryToken({ orgId: 'org_inv_sec_outage' })
		expect(
			await sweep(outage, { status: 503, code: 'inventory_unavailable' }),
		).toEqual([])
	})

	it('answers only with codes from INVENTORY_ERROR_CODES', async () => {
		const codes = new Set<string>(INVENTORY_ERROR_CODES)
		const tokens = [
			undefined,
			await mintInventoryToken({ secret: `${OPERATOR_SECRET}-x` }),
			await mintInventoryToken({ region: 'ksa' }),
			await mintInventoryToken({ features: FEATURES_OFF }),
			await mintInventoryToken({ scope: 'read', grants: [READ] }),
			await mintInventoryToken({ orgId: ORG_UNKNOWN }),
		]
		for (const token of tokens) {
			for (const route of ROUTES) {
				const request = validRequest(route)
				const res = await call(route.method, request.path, {
					token,
					body: request.body,
				})
				if (res.status < 400) continue
				const body = (await res.json()) as { code?: string }
				expect(codes.has(body.code ?? ''), `${route.path} ${body.code}`).toBe(
					true,
				)
			}
		}
	})
})

describe('inventory operator routes: flags and switches', () => {
	it('the token’s features claim gates every route (403 inventory_disabled)', async () => {
		const token = await mintInventoryToken({ features: FEATURES_OFF })
		expect(
			await sweep(token, { status: 403, code: 'inventory_disabled' }),
		).toEqual([])
	})

	it('inventory.purchasing gates levels and orders (403 feature_disabled) and nothing else', async () => {
		const token = await mintInventoryToken({ features: FEATURES_NO_PURCHASING })
		const failures: string[] = []
		for (const route of ROUTES) {
			const request = validRequest(route)
			const res = await call(route.method, request.path, {
				token,
				body: request.body,
			})
			const body = (await res.json()) as { code?: string; feature?: string }
			const gated = PURCHASING_FLAG_ROUTES.has(routeKey(route))
			if (gated) {
				if (
					res.status !== 403 ||
					body.code !== 'feature_disabled' ||
					body.feature !== 'purchasing'
				) {
					failures.push(`${routeKey(route)} -> ${res.status} ${body.code}`)
				}
			} else if (body.code === 'feature_disabled') {
				failures.push(`${routeKey(route)} is gated but not listed`)
			}
		}
		expect(failures).toEqual([])
	})

	it('inventory.recipes gates the recipe routes (403 feature_disabled) and nothing else', async () => {
		const token = await mintInventoryToken({ features: FEATURES_NO_RECIPES })
		const failures: string[] = []
		for (const route of ROUTES) {
			const request = validRequest(route)
			const res = await call(route.method, request.path, {
				token,
				body: request.body,
			})
			const body = (await res.json()) as { code?: string; feature?: string }
			const gated = RECIPES_FLAG_ROUTES.has(routeKey(route))
			if (gated) {
				if (
					res.status !== 403 ||
					body.code !== 'feature_disabled' ||
					body.feature !== 'recipes'
				) {
					failures.push(`${routeKey(route)} -> ${res.status} ${body.code}`)
				}
			} else if (body.code === 'feature_disabled') {
				failures.push(`${routeKey(route)} is gated but not listed`)
			}
		}
		expect(failures).toEqual([])
	})

	it('inventory.transfers gates the transfer routes (403 feature_disabled) and nothing else', async () => {
		const token = await mintInventoryToken({ features: FEATURES_NO_TRANSFERS })
		const failures: string[] = []
		for (const route of ROUTES) {
			const request = validRequest(route)
			const res = await call(route.method, request.path, {
				token,
				body: request.body,
			})
			const body = (await res.json()) as { code?: string; feature?: string }
			const gated = TRANSFERS_FLAG_ROUTES.has(routeKey(route))
			if (gated) {
				if (
					res.status !== 403 ||
					body.code !== 'feature_disabled' ||
					body.feature !== 'transfers'
				) {
					failures.push(`${routeKey(route)} -> ${res.status} ${body.code}`)
				}
			} else if (body.code === 'feature_disabled') {
				failures.push(`${routeKey(route)} is gated but not listed`)
			}
		}
		expect(failures).toEqual([])
	})

	it('inventory.prep gates the prep routes (403 feature_disabled) and nothing else', async () => {
		const token = await mintInventoryToken({ features: FEATURES_NO_PREP })
		const failures: string[] = []
		for (const route of ROUTES) {
			const request = validRequest(route)
			const res = await call(route.method, request.path, {
				token,
				body: request.body,
			})
			const body = (await res.json()) as { code?: string; feature?: string }
			const gated = PREP_FLAG_ROUTES.has(routeKey(route))
			if (gated) {
				if (
					res.status !== 403 ||
					body.code !== 'feature_disabled' ||
					body.feature !== 'prep'
				) {
					failures.push(`${routeKey(route)} -> ${res.status} ${body.code}`)
				}
			} else if (body.code === 'feature_disabled') {
				failures.push(`${routeKey(route)} is gated but not listed`)
			}
		}
		expect(failures).toEqual([])
	})

	it('INVENTORY_ENABLED=false answers 503 inventory_unavailable on every route, reads included', async () => {
		const token = await mintInventoryToken()
		for (const value of ['false', '0', 'off', 'no', 'disabled', ' FALSE ']) {
			process.env.INVENTORY_ENABLED = value
			expect(
				await sweep(token, { status: 503, code: 'inventory_unavailable' }),
				value,
			).toEqual([])
		}
		process.env.INVENTORY_ENABLED = 'true'
		const res = await call('GET', '/operator/inventory/settings', { token })
		expect(res.status).toBe(200)
	})
})

describe('inventory operator routes: grants, scopes and impersonation', () => {
	it('a read-only token reads but cannot change settings (403 forbidden)', async () => {
		const readToken = await mintInventoryToken({
			scope: 'read',
			grants: [READ],
		})
		const get = await call('GET', '/operator/inventory/settings', {
			token: readToken,
		})
		expect(get.status).toBe(200)
		const put = await call('PUT', '/operator/inventory/settings', {
			token: readToken,
			body: { expectedVersion: 0, targetFoodCostBp: 2500 },
		})
		expect(put.status).toBe(403)
		expect(await put.json()).toMatchObject({
			code: 'forbidden',
			reason: 'scope',
		})

		// Write scope without the update grant: refused by grant.
		const grantless = await mintInventoryToken({
			scope: 'write',
			grants: [READ, COST],
		})
		const put2 = await call('PUT', '/operator/inventory/settings', {
			token: grantless,
			body: { expectedVersion: 0, targetFoodCostBp: 2500 },
		})
		expect(put2.status).toBe(403)
		expect(await put2.json()).toMatchObject({
			code: 'forbidden',
			reason: 'grant',
			required: UPDATE,
		})
	})

	it('a cost-only token still reads (cost implies read)', async () => {
		const token = await mintInventoryToken({ scope: 'read', grants: [COST] })
		const res = await call('GET', '/operator/inventory/settings', { token })
		expect(res.status).toBe(200)
	})

	it('an impersonated token reads, and every change is refused', async () => {
		const token = await mintInventoryToken({
			scope: 'write',
			grants: [READ, COST],
			impersonated: true,
		})
		const get = await call(
			'GET',
			`/operator/inventory/status?locationId=${LOC_A}`,
			{
				token,
			},
		)
		expect(get.status).toBe(200)
		const put = await call('PUT', '/operator/inventory/settings', {
			token,
			body: { expectedVersion: 0, targetFoodCostBp: 2500 },
		})
		expect(put.status).toBe(403)
		expect(await put.json()).toMatchObject({
			code: 'forbidden',
			reason: 'impersonated',
		})
	})
})

describe('inventory operator routes: organizations and locations', () => {
	it('a token for one organization never reads or writes another’s settings', async () => {
		const tokenA = await mintInventoryToken({ orgId: ORG_A })
		const tokenB = await mintInventoryToken({ orgId: ORG_B })
		const before = (await (
			await call('GET', '/operator/inventory/settings', { token: tokenB })
		).json()) as { version: number }
		const current = (await (
			await call('GET', '/operator/inventory/settings', { token: tokenA })
		).json()) as { version: number }
		const put = await call('PUT', '/operator/inventory/settings', {
			token: tokenA,
			body: { expectedVersion: current.version, targetFoodCostBp: 3300 },
		})
		expect(put.status).toBe(200)
		const after = (await (
			await call('GET', '/operator/inventory/settings', { token: tokenB })
		).json()) as { version: number; targetFoodCostBp: number }
		expect(after).toEqual(before)
		expect(after.targetFoodCostBp).toBe(3000)
	})

	it('refuses a location outside the token’s locations on /status (403 location_forbidden)', async () => {
		const scoped = await mintInventoryToken({ locationIds: [LOC_A] })
		const allowed = await call(
			'GET',
			`/operator/inventory/status?locationId=${LOC_A}`,
			{ token: scoped },
		)
		expect(allowed.status).toBe(200)
		const excluded = await call(
			'GET',
			`/operator/inventory/status?locationId=${LOC_B}`,
			{ token: scoped },
		)
		expect(excluded.status).toBe(403)
		expect(await excluded.json()).toMatchObject({ code: 'location_forbidden' })

		const none = await mintInventoryToken({ locationIds: [] })
		const res = await call(
			'GET',
			`/operator/inventory/status?locationId=${LOC_A}`,
			{ token: none },
		)
		expect(res.status).toBe(403)
	})

	it('refuses a missing or malformed location id (400)', async () => {
		const token = await mintInventoryToken()
		for (const query of [
			'',
			'?locationId=',
			'?locationId=a%20b',
			'?locationId=x&extra=1',
		]) {
			const res = await call('GET', `/operator/inventory/status${query}`, {
				token,
			})
			expect(res.status, query).toBe(400)
		}
	})
})

describe('inventory operator routes: items, counts, waste, purchasing and Today', () => {
	type Case = {
		key: string
		method: string
		path: string
		body?: Record<string, unknown>
		/** Names a location (query, body or path) or belongs to a record that does. */
		location: boolean
		/** Addresses a record by id in its path (a record of one organization). */
		byId: boolean
	}

	const today = new Date().toISOString().slice(0, 10)
	const seed = {
		area: '',
		item: '',
		list: '',
		count: '',
		supplier: '',
		product: '',
		delivery: '',
		waste: '',
		order: '',
		draftOrder: '',
		made: '',
		soldOut: '',
		prepTask: '',
		transfer: '',
	}
	let admin: string
	let seedCounts = 0

	async function seedCall(
		method: string,
		path: string,
		body?: unknown,
	): Promise<Record<string, any>> {
		const res = await call(method, `/operator/inventory${path}`, {
			token: admin,
			body,
		})
		const parsed = (await res.json()) as Record<string, any>
		expect(res.status, `${method} ${path} ${JSON.stringify(parsed)}`).toBe(200)
		return parsed
	}

	beforeAll(async () => {
		admin = await mintInventoryToken({
			grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		})
		seed.area = (
			await seedCall('POST', '/storage-areas', {
				locationId: LOC_B,
				name: 'Sec area',
			})
		).id
		seed.item = (
			await seedCall('POST', '/items', {
				clientId: 'sec-item-0001',
				name: 'Security flour',
				category: 'dry_goods',
				kind: 'bought',
				baseUnit: 'g',
			})
		).id
		seed.list = (
			await seedCall('POST', '/count-lists', {
				locationId: LOC_B,
				name: 'Sec list',
				itemIds: [seed.item],
			})
		).id
		seed.count = (
			await seedCall('POST', '/counts', {
				clientId: 'sec-count-0001',
				locationId: LOC_B,
				listId: null,
			})
		).id
		seed.supplier = (
			await seedCall('POST', '/suppliers', {
				clientId: 'sec-supplier-01',
				name: 'Sec supplier',
				currency: 'SAR',
				minimumOrderMinor: 1000,
			})
		).id
		seed.product = (
			await seedCall('POST', `/suppliers/${seed.supplier}/products`, {
				itemId: seed.item,
				packName: 'Bag',
				packBaseQuantity: 1_000_000,
				priceMinor: 500,
			})
		).id
		seed.delivery = (
			await seedCall('POST', '/deliveries', {
				clientId: 'sec-delivery-01',
				locationId: LOC_B,
				supplierId: seed.supplier,
				currency: 'SAR',
				lines: [
					{ itemId: seed.item, quantity: 5_000_000, lineTotalMinor: 2500 },
				],
			})
		).delivery.id
		seed.waste = (
			await seedCall('POST', '/waste', {
				entries: [
					{
						clientId: 'sec-waste-0001',
						locationId: LOC_B,
						itemId: seed.item,
						amount: 100,
						unit: 'g',
						reason: 'spoiled',
					},
				],
			})
		).accepted[0].id
		// A level the item is below, so the suggestion has a line (money included).
		const level = await seedCall('PUT', '/levels/bulk', {
			clientId: 'sec-levels-0001',
			locationId: LOC_B,
			levels: [
				{
					itemId: seed.item,
					orderBelowQuantity: 6_000_000,
					fillUpToQuantity: 10_000_000,
					expectedVersion: 0,
				},
			],
		})
		expect(level.refused).toEqual([])
		seed.order = (
			await seedCall('POST', '/orders', {
				clientId: 'sec-order-00001',
				locationId: LOC_B,
				supplierId: seed.supplier,
				lines: [
					{ itemId: seed.item, supplierProductId: seed.product, packs: 2 },
				],
			})
		).id
		// Recipes: a priced dish, and a made item with a recipe to record a batch of.
		await seedCall('PUT', '/recipes', {
			ownerKind: 'menu_item',
			ownerId: 'sec_dish',
			expectedVersion: 0,
			lines: [{ itemId: seed.item, amount: 100, unit: 'g' }],
		})
		seed.made = (
			await seedCall('POST', '/items', {
				clientId: 'sec-made-00001',
				name: 'Security sauce',
				category: 'sauces',
				kind: 'made',
				baseUnit: 'ml',
			})
		).id
		await seedCall('PUT', '/recipes', {
			ownerKind: 'made_item',
			ownerId: seed.made,
			expectedVersion: 0,
			makes: { amount: 1, unit: 'l' },
			lines: [{ itemId: seed.item, amount: 200, unit: 'g' }],
		})
		// A dish taken off by stock and already put back by a manager (so the undo
		// answers without calling the App).
		seed.soldOut = 'sec_soldout_1'
		await (await getTenantDb(ORG_A)).insert(invSoldOut).values({
			id: seed.soldOut,
			locationId: LOC_B,
			entityType: 'item',
			entityId: 'sec_dish',
			causeItemId: seed.item,
			state: 'undone',
		})
		// A prep task at version 1: the sweep sends version 99, so nothing changes.
		seed.prepTask = 'sec_prep_task_1'
		await (await getTenantDb(ORG_A)).insert(invPrepTasks).values({
			id: seed.prepTask,
			locationId: LOC_B,
			businessDate: new Date().toISOString().slice(0, 10),
			itemId: seed.made,
			plannedQuantity: 1_000_000,
			fillUpToQuantity: 1_000_000,
			onHandQuantity: 0,
		})
		// A transfer from LOC_B to a third place that stays a draft: the sweeps send a
		// version it does not have, so nothing about it changes.
		seed.transfer = (
			await seedCall('POST', '/transfers', {
				clientId: 'sec-transfer-0001',
				kind: 'transfer',
				fromLocationId: LOC_B,
				// A third place: a token for LOC_A alone covers neither end.
				toLocationId: 'loc_third',
				lines: [{ itemId: seed.item, amount: 1, unit: 'g' }],
			})
		).id
		seedCounts = (await seedCall('GET', `/counts?locationId=${LOC_B}`)).counts
			.length
	})

	function cases(): Case[] {
		const loc = LOC_B
		const q = `locationId=${loc}`
		const range = `from=${today}&to=${today}`
		const one = { expectedVersion: 1 }
		const c = (
			key: string,
			path: string,
			options: {
				body?: Record<string, unknown>
				location?: boolean
				byId?: boolean
			} = {},
		): Case => ({
			key,
			method: key.split(' ')[0]!,
			path,
			body: options.body,
			location: options.location ?? true,
			byId: options.byId ?? false,
		})
		return [
			c('GET /settings', '/settings', { location: false }),
			c('PUT /settings', '/settings', {
				body: { expectedVersion: 0, targetFoodCostBp: 2800 },
				location: false,
			}),
			c('GET /status', `/status?${q}`),
			c('GET /today', `/today?${q}`),
			c('GET /items', `/items?${q}`),
			c('POST /items', '/items', {
				location: true,
				body: {
					clientId: 'sec-item-0002',
					name: 'Security rice',
					category: 'dry_goods',
					kind: 'bought',
					baseUnit: 'g',
					place: {
						locationId: loc,
						countUnit: 'kg',
						areaIds: [],
						orderBelowQuantity: null,
						fillUpToQuantity: null,
					},
				},
			}),
			c('POST /items/bulk', '/items/bulk', {
				body: {
					clientId: 'sec-bulk-00001',
					locationId: loc,
					items: [
						{
							name: 'Bulk sec',
							category: 'other',
							kind: 'bought',
							baseUnit: 'g',
						},
					],
				},
			}),
			c('GET /items/:id', `/items/${seed.item}?${q}`, { byId: true }),
			c('PATCH /items/:id', `/items/${seed.item}`, {
				body: { expectedVersion: 1, name: 'Renamed' },
				location: false,
				byId: true,
			}),
			c('POST /items/:id/archive', `/items/${seed.item}/archive`, {
				body: one,
				location: false,
				byId: true,
			}),
			c('POST /items/:id/restore', `/items/${seed.item}/restore`, {
				body: one,
				location: false,
				byId: true,
			}),
			c('POST /items/:id/units', `/items/${seed.item}/units`, {
				body: { name: 'Sack', baseQuantity: 25_000_000 },
				location: false,
				byId: true,
			}),
			c(
				'PUT /items/:id/places/:locationId',
				`/items/${seed.item}/places/${loc}`,
				{
					body: {
						expectedVersion: 0,
						countUnit: 'kg',
						areaIds: [],
						orderBelowQuantity: null,
						fillUpToQuantity: null,
					},
					byId: true,
				},
			),
			c('POST /items/:id/adjust', `/items/${seed.item}/adjust`, {
				body: {
					clientId: 'sec-adjust-001',
					locationId: loc,
					quantity: 5,
					reason: 'found',
				},
				byId: true,
			}),
			c('GET /items/:id/movements', `/items/${seed.item}/movements?${q}`, {
				byId: true,
			}),
			c('GET /storage-areas', `/storage-areas?${q}`),
			c('POST /storage-areas', '/storage-areas', {
				body: { locationId: loc, name: 'Another area' },
			}),
			c('POST /storage-areas/reorder', '/storage-areas/reorder', {
				body: { locationId: loc, areaIds: [seed.area] },
			}),
			c('PATCH /storage-areas/:id', `/storage-areas/${seed.area}`, {
				body: { expectedVersion: 1, name: 'Renamed area' },
				byId: true,
			}),
			c('PUT /storage-areas/:id/items', `/storage-areas/${seed.area}/items`, {
				body: { itemIds: [] },
				byId: true,
			}),
			c(
				'POST /storage-areas/:id/archive',
				`/storage-areas/${seed.area}/archive`,
				{ body: one, byId: true },
			),
			c('GET /count-lists', `/count-lists?${q}`),
			c('POST /count-lists', '/count-lists', {
				body: { locationId: loc, name: 'Other list', itemIds: [seed.item] },
			}),
			c('PATCH /count-lists/:id', `/count-lists/${seed.list}`, {
				body: { expectedVersion: 1, name: 'Renamed list' },
				byId: true,
			}),
			c('POST /count-lists/:id/archive', `/count-lists/${seed.list}/archive`, {
				body: one,
				byId: true,
			}),
			c('GET /counts', `/counts?${q}`),
			c('POST /counts', '/counts', {
				body: { clientId: 'sec-count-0002', locationId: loc, listId: null },
			}),
			c('GET /counts/:id', `/counts/${seed.count}`, { byId: true }),
			c('POST /counts/:id/entries', `/counts/${seed.count}/entries`, {
				body: {
					entries: [
						{
							clientId: 'sec-entry-0001',
							itemId: seed.item,
							areaId: null,
							amount: 1,
							unit: 'kg',
						},
					],
				},
				byId: true,
			}),
			c('POST /counts/:id/send', `/counts/${seed.count}/send`, {
				body: one,
				byId: true,
			}),
			c('POST /counts/:id/reopen', `/counts/${seed.count}/reopen`, {
				body: one,
				byId: true,
			}),
			c('POST /counts/:id/cancel', `/counts/${seed.count}/cancel`, {
				body: one,
				byId: true,
			}),
			c('GET /counts/:id/review', `/counts/${seed.count}/review`, {
				byId: true,
			}),
			c('POST /counts/:id/approve', `/counts/${seed.count}/approve`, {
				body: one,
				byId: true,
			}),
			c('GET /waste', `/waste?${q}&${range}`),
			c('GET /waste/summary', `/waste/summary?${q}&${range}`),
			c('POST /waste', '/waste', {
				body: {
					entries: [
						{
							clientId: 'sec-waste-0002',
							locationId: loc,
							itemId: seed.item,
							amount: 1,
							unit: 'g',
							reason: 'dropped',
						},
					],
				},
			}),
			c('POST /waste/:id/undo', `/waste/${seed.waste}/undo`, {
				body: { clientId: 'sec-undo-00001' },
				byId: true,
			}),
			c('GET /suppliers', '/suppliers', { location: false }),
			c('POST /suppliers', '/suppliers', {
				body: {
					clientId: 'sec-supplier-02',
					name: 'Other supplier',
					currency: 'SAR',
				},
				location: false,
			}),
			c('GET /suppliers/:id', `/suppliers/${seed.supplier}`, {
				location: false,
				byId: true,
			}),
			c('PATCH /suppliers/:id', `/suppliers/${seed.supplier}`, {
				body: { expectedVersion: 1, name: 'Renamed supplier' },
				location: false,
				byId: true,
			}),
			c('POST /suppliers/:id/archive', `/suppliers/${seed.supplier}/archive`, {
				body: one,
				location: false,
				byId: true,
			}),
			c(
				'POST /suppliers/:id/products',
				`/suppliers/${seed.supplier}/products`,
				{
					body: {
						itemId: seed.item,
						packName: 'Box',
						packBaseQuantity: 2_000_000,
						priceMinor: 900,
					},
					location: false,
					byId: true,
				},
			),
			c('PATCH /supplier-products/:id', `/supplier-products/${seed.product}`, {
				body: { expectedVersion: 1, priceMinor: 600 },
				location: false,
				byId: true,
			}),
			c(
				'POST /supplier-products/:id/archive',
				`/supplier-products/${seed.product}/archive`,
				{ body: one, location: false, byId: true },
			),
			c('GET /deliveries', `/deliveries?${q}`),
			c('POST /deliveries', '/deliveries', {
				body: {
					clientId: 'sec-delivery-02',
					locationId: loc,
					supplierId: null,
					currency: 'SAR',
					lines: [{ itemId: seed.item, quantity: 1000, lineTotalMinor: 10 }],
				},
			}),
			c('GET /deliveries/:id', `/deliveries/${seed.delivery}`, { byId: true }),
			c('POST /deliveries/:id/paid', `/deliveries/${seed.delivery}/paid`, {
				body: { expectedVersion: 1, paid: true },
				location: false,
				byId: true,
			}),
			c('POST /deliveries/:id/cancel', `/deliveries/${seed.delivery}/cancel`, {
				body: one,
				byId: true,
			}),
			c(
				'POST /deliveries/:id/confirm-prices',
				`/deliveries/${seed.delivery}/confirm-prices`,
				{
					body: {
						expectedVersion: 1,
						currency: 'SAR',
						lines: [{ lineId: 'line_x', lineTotalMinor: 10 }],
					},
					byId: true,
				},
			),
			c(
				'POST /deliveries/:id/credit-message',
				`/deliveries/${seed.delivery}/credit-message`,
				{ body: { locale: 'en' }, byId: true },
			),
			c(
				'POST /deliveries/:id/invoice-photo',
				`/deliveries/${seed.delivery}/invoice-photo`,
				{ body: { contentType: 'image/jpeg', sizeBytes: 1000 }, byId: true },
			),
			c(
				'POST /deliveries/:id/invoice-photo/confirm',
				`/deliveries/${seed.delivery}/invoice-photo/confirm`,
				{
					body: {
						key: `inventory-invoices/${ORG_A}/${seed.delivery}/00000000-0000-4000-8000-000000000000.jpg`,
					},
					byId: true,
				},
			),
			c(
				'POST /deliveries/:id/invoice-photo/read',
				`/deliveries/${seed.delivery}/invoice-photo/read`,
				{ body: {}, byId: true },
			),
			c('GET /price-alerts', `/price-alerts?${q}`),
			c('GET /levels', `/levels?${q}`),
			c('GET /levels/suggestions', `/levels/suggestions?${q}`),
			c('PUT /levels/bulk', '/levels/bulk', {
				body: {
					clientId: 'sec-levels-0002',
					locationId: loc,
					levels: [
						{
							itemId: seed.item,
							orderBelowQuantity: 1,
							fillUpToQuantity: 2,
							expectedVersion: 1,
						},
					],
				},
			}),
			c('GET /orders/suggested', `/orders/suggested?${q}`),
			c('POST /orders', '/orders', {
				body: {
					clientId: 'sec-order-00002',
					locationId: loc,
					supplierId: seed.supplier,
					lines: [],
				},
			}),
			c('GET /orders', `/orders?${q}`),
			c('GET /orders/:id', `/orders/${seed.order}`, { byId: true }),
			c('PATCH /orders/:id', `/orders/${seed.order}`, {
				body: { expectedVersion: 1, note: 'Renamed' },
				byId: true,
			}),
			c('POST /orders/:id/send', `/orders/${seed.order}/send`, {
				body: { expectedVersion: 1, channel: 'copy' },
				byId: true,
			}),
			c('POST /orders/:id/cancel', `/orders/${seed.order}/cancel`, {
				body: one,
				byId: true,
			}),
			c('GET /orders/:id/text', `/orders/${seed.order}/text`, { byId: true }),
			c(
				'GET /orders/:id/receive-prefill',
				`/orders/${seed.order}/receive-prefill`,
				{ byId: true },
			),
			c('GET /recipes', '/recipes?ownerKind=menu_item&ownerId=sec_dish', {
				location: false,
			}),
			c('PUT /recipes', '/recipes', {
				body: {
					ownerKind: 'menu_item',
					ownerId: 'sec_dish_two',
					expectedVersion: 0,
					lines: [{ itemId: seed.item, amount: 10, unit: 'g' }],
				},
				location: false,
			}),
			c('POST /recipes/clear', '/recipes/clear', {
				body: {
					ownerKind: 'menu_item',
					ownerId: 'sec_dish',
					expectedVersion: 1,
				},
				location: false,
			}),
			c('POST /recipes/costs', '/recipes/costs', {
				body: {
					currency: 'SAR',
					refs: [{ key: 'a', itemId: 'sec_dish', priceMinor: 500 }],
				},
				location: false,
			}),
			c('GET /recipes/missing', `/recipes/missing?${q}`),
			c('POST /items/:id/batch', `/items/${seed.made}/batch`, {
				body: {
					clientId: 'sec-batch-0001',
					locationId: loc,
					made: { kind: 'batches', count: 1 },
				},
				byId: true,
			}),
			// Answers the locations a token covers (never a refusal), so it is organization-wide.
			c('GET /compare', `/compare?locationIds=${loc},${LOC_A}`, {
				location: false,
			}),
			c('GET /transfers', `/transfers?${q}`),
			c('POST /transfers', '/transfers', {
				body: {
					clientId: 'sec-transfer-0002',
					kind: 'transfer',
					fromLocationId: loc,
					toLocationId: LOC_A,
					lines: [{ itemId: seed.item, amount: 1, unit: 'g' }],
				},
			}),
			c('GET /transfers/:id', `/transfers/${seed.transfer}`, { byId: true }),
			c('PATCH /transfers/:id', `/transfers/${seed.transfer}`, {
				body: { expectedVersion: 99, note: 'Renamed' },
				byId: true,
			}),
			c('POST /transfers/:id/send', `/transfers/${seed.transfer}/send`, {
				body: { expectedVersion: 99 },
				byId: true,
			}),
			c('POST /transfers/:id/receive', `/transfers/${seed.transfer}/receive`, {
				body: { expectedVersion: 99 },
				byId: true,
			}),
			c('POST /transfers/:id/cancel', `/transfers/${seed.transfer}/cancel`, {
				body: { expectedVersion: 99 },
				byId: true,
			}),
			c('GET /prep', `/prep?${q}`),
			c('POST /prep/generate', '/prep/generate', { body: { locationId: loc } }),
			c('GET /prep/levels', `/prep/levels?${q}`),
			c('PUT /prep/levels', '/prep/levels', {
				body: {
					locationId: loc,
					itemId: seed.made,
					stationId: null,
					weekdays: [null, null, null, null, null, null, null],
					expectedVersion: 0,
				},
			}),
			c('POST /prep/tasks/:id/start', `/prep/tasks/${seed.prepTask}/start`, {
				body: { expectedVersion: 99 },
				byId: true,
			}),
			c('POST /prep/tasks/:id/done', `/prep/tasks/${seed.prepTask}/done`, {
				body: {
					expectedVersion: 99,
					clientId: 'sec-prep-done-0001',
					made: { kind: 'batches', count: 1 },
				},
				byId: true,
			}),
			c('POST /prep/tasks/:id/skip', `/prep/tasks/${seed.prepTask}/skip`, {
				body: { expectedVersion: 99 },
				byId: true,
			}),
			c('GET /sold-out', `/sold-out?${q}`),
			c('POST /sold-out/:id/undo', `/sold-out/${seed.soldOut}/undo`, {
				body: {},
				byId: true,
			}),
		]
	}

	const run = (
		testCase: Case,
		token: string,
		extra?: Record<string, unknown>,
	) =>
		call(testCase.method, `/operator/inventory${testCase.path}`, {
			token,
			body:
				testCase.body === undefined && !extra
					? undefined
					: { ...testCase.body, ...extra },
		})

	it('has a case for every route (a new route cannot ship unswept)', () => {
		expect(
			cases()
				.map((entry) => entry.key)
				.sort(),
		).toEqual(Object.keys(ROUTE_GRANTS).sort())
	})

	it('a token limited to other locations is refused on every location-bound route (403 location_forbidden) and nothing changes', async () => {
		const tokens = {
			otherLocation: await mintInventoryToken({
				grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
				locationIds: [LOC_A],
			}),
			noLocations: await mintInventoryToken({
				grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
				locationIds: [],
			}),
		}
		const failures: string[] = []
		for (const [name, token] of Object.entries(tokens)) {
			for (const entry of cases().filter((item) => item.location)) {
				const res = await run(entry, token)
				const body = (await res.json()) as { code?: string }
				if (res.status !== 403 || body.code !== 'location_forbidden') {
					failures.push(`${name}: ${entry.key} -> ${res.status} ${body.code}`)
				}
			}
		}
		expect(failures).toEqual([])
		const after = await seedCall('GET', `/counts?locationId=${LOC_B}`)
		expect(after.counts).toHaveLength(seedCounts)
		expect(after.counts[0]).toMatchObject({
			id: seed.count,
			status: 'counting',
			version: 1,
		})
		const areas = await seedCall('GET', `/storage-areas?locationId=${LOC_B}`)
		expect(areas.areas.map((area: { name: string }) => area.name)).toEqual([
			'Sec area',
		])
	})

	it('an organization-wide route works for a token limited to one location', async () => {
		const token = await mintInventoryToken({
			grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
			locationIds: [LOC_A],
		})
		for (const entry of cases().filter(
			(item) => !item.location && item.method === 'GET',
		)) {
			expect((await run(entry, token)).status, entry.key).toBe(200)
		}
	})

	it('a token for another organization finds nothing by id (404 not_found) and changes nothing', async () => {
		const tokenB = await mintInventoryToken({
			orgId: ORG_B,
			grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		})
		const failures: string[] = []
		for (const entry of cases().filter((item) => item.byId)) {
			const res = await run(entry, tokenB)
			const body = (await res.json()) as { code?: string }
			if (res.status !== 404 || body.code !== 'not_found') {
				failures.push(`${entry.key} -> ${res.status} ${body.code}`)
			}
		}
		expect(failures).toEqual([])
		const detail = await seedCall(
			'GET',
			`/items/${seed.item}?locationId=${LOC_B}`,
		)
		expect(detail).toMatchObject({
			name: 'Security flour',
			version: 1,
			archived: false,
		})
	})

	it('refuses every change without its grant, naming the grant (403 forbidden)', async () => {
		const noUpdate = await mintInventoryToken({
			grants: [READ, COST, PURCHASING],
		})
		const noPurchasing = await mintInventoryToken({
			grants: [READ, UPDATE, COST],
		})
		// update:inventory:any alone must not write a recipe.
		const noRecipe = await mintInventoryToken({
			grants: [READ, UPDATE, COST, PURCHASING],
		})
		const failures: string[] = []
		for (const route of ROUTES.filter((item) => !isRead(item))) {
			const required = grantFor(route)
			const token =
				required === PURCHASING
					? noPurchasing
					: required === RECIPE
						? noRecipe
						: noUpdate
			const res = await call(route.method, validRequest(route).path, {
				token,
				body: {},
			})
			const body = (await res.json()) as {
				code?: string
				reason?: string
				required?: string
			}
			if (
				res.status !== 403 ||
				body.reason !== 'grant' ||
				body.required !== required
			) {
				failures.push(
					`${route.method} ${route.path} -> ${res.status} ${body.reason} ${body.required}`,
				)
			}
		}
		expect(failures).toEqual([])
	})

	it('approving a count also needs the cost grant (403 forbidden, grant read:inventory_cost:any)', async () => {
		const token = await mintInventoryToken({ grants: [READ, UPDATE] })
		const res = await call(
			'POST',
			`/operator/inventory/counts/${seed.count}/approve`,
			{
				token,
				body: { expectedVersion: 1 },
			},
		)
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({
			code: 'forbidden',
			reason: 'grant',
			required: COST,
		})
	})

	it('adjusting stock needs the cost grant (403 forbidden, grant read:inventory_cost:any)', async () => {
		const token = await mintInventoryToken({ grants: [READ, UPDATE] })
		const res = await call(
			'POST',
			`/operator/inventory/items/${seed.item}/adjust`,
			{
				token,
				body: {
					clientId: 'sec-adjust-grant',
					locationId: LOC_A,
					quantity: 1_000_000,
					reason: 'found',
				},
			},
		)
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({
			code: 'forbidden',
			reason: 'grant',
			required: COST,
		})
	})

	it('changing target food cost on settings needs the cost grant', async () => {
		const token = await mintInventoryToken({ grants: [READ, UPDATE] })
		const res = await call('PUT', '/operator/inventory/settings', {
			token,
			body: { expectedVersion: 0, targetFoodCostBp: 2500 },
		})
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({
			code: 'forbidden',
			reason: 'grant',
			required: COST,
		})
	})

	it('changing who may receive on Station needs the purchasing grant', async () => {
		const token = await mintInventoryToken({ grants: [READ, UPDATE, COST] })
		const res = await call('PUT', '/operator/inventory/settings', {
			token,
			body: { expectedVersion: 0, anyStaffCanReceive: true },
		})
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({
			code: 'forbidden',
			reason: 'grant',
			required: PURCHASING,
		})
	})

	it('saving only the unit system does not need the cost grant when food cost is unchanged', async () => {
		const token = await mintInventoryToken({ grants: [READ, UPDATE] })
		const put = await call('PUT', '/operator/inventory/settings', {
			token,
			body: {
				expectedVersion: 0,
				targetFoodCostBp: 3000,
				unitSystem: 'metric',
			},
		})
		expect(put.status).toBe(200)
	})

	it('a read-scope token reads, and every change is refused (403 forbidden, scope)', async () => {
		const token = await mintInventoryToken({
			scope: 'read',
			grants: [READ, COST],
		})
		const failures: string[] = []
		for (const entry of cases()) {
			const res = await run(entry, token)
			const body = (await res.json()) as { code?: string; reason?: string }
			if (isRead(entry)) {
				if (res.status !== 200)
					failures.push(`${entry.key} -> ${res.status} ${body.code}`)
			} else if (res.status !== 403 || body.reason !== 'scope') {
				failures.push(`${entry.key} -> ${res.status} ${body.reason}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('an impersonated token reads, and every change is refused (403 forbidden, impersonated)', async () => {
		const token = await mintInventoryToken({
			grants: [READ, COST],
			impersonated: true,
		})
		const failures: string[] = []
		for (const entry of cases()) {
			const res = await run(entry, token)
			const body = (await res.json()) as { code?: string; reason?: string }
			if (isRead(entry)) {
				if (res.status !== 200)
					failures.push(`${entry.key} -> ${res.status} ${body.code}`)
			} else if (res.status !== 403 || body.reason !== 'impersonated') {
				failures.push(`${entry.key} -> ${res.status} ${body.reason}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('a token without the cost grant gets no money from any read (omitted, not zeroed)', async () => {
		const token = await mintInventoryToken({
			grants: [READ, UPDATE, PURCHASING],
		})
		const money =
			/"(valueMinor|totalValueMinor|differenceValueMinor|costMicro|previousCostMicro|lastCostMicro|avgCostMicro|priceMinor|packPriceMinor|lineTotalMinor|linesTotalMinor|vatMinor|totalMinor|unpaidMinor|purchasesMinor|valueAtStakeMinor|stockValueMinor|wasteWeekMinor|wasteWeekShareBp|minimumOrderMinor|shortOfMinimumMinor|belowMinimum|unpricedLines|previousPackPriceMinor|priceChangeBp|priceChanges|foodCost|cost|plate|costMinor|typedCostMinor|typedCostCurrency|priceForTargetMinor|foodCostBp|netSalesMinor)":/
		const failures: string[] = []
		let reads = 0
		// The price alerts are all money: they need the cost grant (below).
		for (const entry of cases().filter(
			(item) => isRead(item) && item.key !== 'GET /price-alerts',
		)) {
			const res = await run(entry, token)
			const text = await res.text()
			reads++
			if (res.status !== 200) failures.push(`${entry.key} -> ${res.status}`)
			else if (money.test(text))
				failures.push(`${entry.key} leaks ${money.exec(text)?.[1]}`)
		}
		expect(reads).toBeGreaterThan(15)
		expect(failures).toEqual([])
		// The same reads do carry money for the cost grant (the sweep above is not vacuous).
		const withCost = await call(
			'GET',
			`/operator/inventory/deliveries/${seed.delivery}`,
			{ token: admin },
		)
		expect(await withCost.text()).toContain('lineTotalMinor')
		const items = await call(
			'GET',
			`/operator/inventory/items/${seed.item}?locationId=${LOC_B}`,
			{ token: admin },
		)
		expect(await items.text()).toContain('avgCostMicro')
		const suggested = await call(
			'GET',
			`/operator/inventory/orders/suggested?locationId=${LOC_B}`,
			{ token: admin },
		)
		const suggestedText = await suggested.text()
		expect(suggestedText).toContain('packPriceMinor')
		expect(suggestedText).toContain('minimumOrderMinor')
		const order = await call(
			'GET',
			`/operator/inventory/orders/${seed.order}`,
			{
				token: admin,
			},
		)
		expect(await order.text()).toContain('lineTotalMinor')
		// Recipes: plate cost and food cost for the cost grant, structure only without it.
		const recipe = await call(
			'GET',
			'/operator/inventory/recipes?ownerKind=menu_item&ownerId=sec_dish',
			{ token: admin },
		)
		const recipeText = await recipe.text()
		expect(recipeText).toContain('"plate"')
		expect(recipeText).toContain('costMinor')
		const costs = await call('POST', '/operator/inventory/recipes/costs', {
			token: admin,
			body: {
				currency: 'SAR',
				refs: [{ key: 'a', itemId: 'sec_dish', priceMinor: 500 }],
			},
		})
		const costsText = await costs.text()
		expect(costsText).toContain('foodCostBp')
		expect(costsText).toContain('priceForTargetMinor')
		const plainCosts = await call('POST', '/operator/inventory/recipes/costs', {
			token,
			body: {
				currency: 'SAR',
				refs: [{ key: 'a', itemId: 'sec_dish', priceMinor: 500 }],
			},
		})
		expect(await plainCosts.json()).toMatchObject({
			rows: [{ key: 'a', hasRecipe: true, state: 'complete' }],
		})
		// … and the suggestion is not an empty one for the token without it.
		const plain = await call(
			'GET',
			`/operator/inventory/orders/suggested?locationId=${LOC_B}`,
			{ token },
		)
		const plainBody = (await plain.json()) as { toOrderItems: number }
		expect(plainBody.toOrderItems).toBe(1)
	})

	it('the price alerts need the cost grant (403 forbidden, not an empty list)', async () => {
		const noCost = await mintInventoryToken({
			grants: [READ, UPDATE, PURCHASING],
		})
		const res = await call(
			'GET',
			`/operator/inventory/price-alerts?locationId=${LOC_B}`,
			{ token: noCost },
		)
		expect(res.status).toBe(403)
		expect(await res.json()).toMatchObject({
			code: 'forbidden',
			reason: 'grant',
			required: COST,
		})
		const costOnly = await mintInventoryToken({
			scope: 'read',
			grants: [COST],
		})
		const ok = await call(
			'GET',
			`/operator/inventory/price-alerts?locationId=${LOC_B}`,
			{ token: costOnly },
		)
		expect(ok.status).toBe(200)
	})

	it('receiving against an order needs the purchasing flag; a delivery without an order does not', async () => {
		const token = await mintInventoryToken({ features: FEATURES_NO_PURCHASING })
		const line = { itemId: seed.item, quantity: 1000, lineTotalMinor: 10 }
		const linked = await call('POST', '/operator/inventory/deliveries', {
			token,
			body: {
				clientId: 'sec-delivery-04',
				locationId: LOC_B,
				supplierId: seed.supplier,
				currency: 'SAR',
				orderId: seed.order,
				lines: [line],
			},
		})
		expect(linked.status).toBe(403)
		expect(await linked.json()).toMatchObject({ code: 'feature_disabled' })
		const plain = await call('POST', '/operator/inventory/deliveries', {
			token,
			body: {
				clientId: 'sec-delivery-05',
				locationId: LOC_B,
				supplierId: null,
				currency: 'SAR',
				lines: [line],
			},
		})
		expect(plain.status).toBe(200)
	})

	it('a replayed create by a token without the cost grant gets no money back', async () => {
		const noCost = await mintInventoryToken({ grants: [READ, UPDATE] })
		const body = {
			clientId: 'sec-delivery-03',
			locationId: LOC_B,
			supplierId: null,
			currency: 'SAR',
			lines: [{ itemId: seed.item, quantity: 1000, lineTotalMinor: 10 }],
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const res = await call('POST', '/operator/inventory/deliveries', {
				token: noCost,
				body,
			})
			expect(res.status).toBe(200)
			expect(await res.text()).not.toMatch(/Minor|priceChange|currency/)
		}
	})

	it('every write refuses unknown fields without echoing them (400)', async () => {
		const failures: string[] = []
		for (const entry of cases().filter((item) => item.body !== undefined)) {
			const res = await run(entry, admin, { leakMe: 'secret-canary-value' })
			const text = await res.text()
			if (
				res.status !== 400 ||
				text.includes('secret-canary-value') ||
				text.includes('leakMe')
			) {
				failures.push(`${entry.key} -> ${res.status}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('malformed ids and queries are 400/404, never a crash', async () => {
		for (const [method, path] of [
			['GET', '/items/%20?locationId=loc_b'],
			['GET', `/items/${'a'.repeat(70)}?locationId=loc_b`],
			['GET', '/counts/..%2Fetc'],
			['GET', `/items?locationId=${LOC_B}&limit=0`],
			['GET', `/items?locationId=${LOC_B}&status=bogus`],
			['GET', `/waste?locationId=${LOC_B}&from=2026-13-45&to=today`],
			['GET', `/deliveries?locationId=${LOC_B}&unpaid=maybe`],
			['GET', `/suppliers?includeArchived=maybe`],
		] as const) {
			const res = await call(method, `/operator/inventory${path}`, {
				token: admin,
			})
			expect([400, 404], `${method} ${path} -> ${res.status}`).toContain(
				res.status,
			)
		}
	})
})
