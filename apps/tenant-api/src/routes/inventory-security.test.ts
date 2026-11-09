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
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
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
	purchasing: false,
	recipes: false,
	prep: false,
	transfers: false,
}
const FEATURES_OFF: InventoryFeatures = { ...FEATURES_ON, enabled: false }

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const COST = INVENTORY_PERMISSIONS.READ_INVENTORY_COST

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
		grants: overrides.grants ?? [READ, UPDATE, COST],
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
		const keys = new Set(ROUTES.map((route) => `${route.method} ${route.path}`))
		for (const key of [
			'GET /operator/inventory/settings',
			'PUT /operator/inventory/settings',
			'GET /operator/inventory/status',
		]) {
			expect(keys.has(key), key).toBe(true)
		}
	})

	it('a valid token reaches every route (the sweep requests are well formed)', async () => {
		const token = await mintInventoryToken()
		for (const route of ROUTES) {
			const request = validRequest(route)
			const res = await call(route.method, request.path, {
				token,
				body: request.body,
			})
			expect(res.status, `${route.method} ${route.path}`).toBe(200)
			expect(res.headers.get('Cache-Control')).toBe('private, no-store')
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
