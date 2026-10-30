import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatPosDeviceSecret, randomPosToken } from '@repo/common/pos-orders'
import { brand } from '@repo/config/brand'
import {
	LOYALTY_MAX_DAILY_ADJUSTMENT_CREDIT,
	LOYALTY_PERMISSIONS,
	LOYALTY_TOKEN_AUDIENCE,
	LOYALTY_TOKEN_TYP,
	type LoyaltyFeatures,
	type LoyaltyScope,
} from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	loyaltyLedger,
	loyaltyMembers,
	loyaltyPurchases,
	posDevices,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import {
	invalidateLoyaltyContext,
	seedLoyaltyContextForTest,
} from '../lib/loyalty-context.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import { hashPosSecret } from '../lib/pos-auth.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import {
	identifyMemberByCode,
	issueMemberCode,
	requestTillApproval,
} from '../services/loyalty-code-service.ts'
import {
	activateProgram,
	givePoints,
	insertCustomer,
	loyaltyCart,
	makeMember,
	makeReward,
	reserveReward,
} from '../services/loyalty-test-fixture.ts'
import { loyaltyRoutes } from './loyalty.ts'
import { operatorLoyaltyRoutes } from './operator-loyalty.ts'
import { posLoyaltyRoutes } from './pos-loyalty.ts'

/**
 * Security sweep for the three loyalty route surfaces: customer (`/loyalty`),
 * operator (`/operator/loyalty`) and till (`/pos/loyalty`). Modeled on
 * `reservations-security.test.ts`: the control plane (`../lib/origin.ts`) is
 * mocked, every organization gets a real provisioned tenant database, and
 * tokens are minted and forged with jose directly.
 */

const CUSTOMER_SECRET = 'lty-sec-customer-jwt-secret-0123456789'
const OPERATOR_SECRET = 'lty-sec-operator-token-0123456789abcdef'
const HMAC_SECRET = 'lty-sec-hmac-secret-0123456789abcdef'

const ORG_A = 'org_lty_sec_a'
const ORG_B = 'org_lty_sec_b'
const ORG_KSA = 'org_lty_sec_ksa'
const ORG_UNPROVISIONED = 'org_lty_sec_unprov'
const ORG_UNKNOWN = 'org_lty_sec_unknown'

const SLUG_A = 'lty-sec-a'
const SLUG_B = 'lty-sec-b'

const LOC_A = 'loc_a'
const LOC_B = 'loc_b'

const CUST_A1 = 'cus_lty_sec_a1'
const CUST_A2 = 'cus_lty_sec_a2'
const CUST_B1 = 'cus_lty_sec_b1'
const CUST_ENROLL = 'cus_lty_sec_enroll'
const CUST_RATE = 'cus_lty_sec_rate'

const FEATURES_ON: LoyaltyFeatures = {
	enabled: true,
	redemption: true,
}
const FEATURES_OFF: LoyaltyFeatures = {
	enabled: false,
	redemption: false,
}

const READ = LOYALTY_PERMISSIONS.READ_LOYALTY
const PROGRAM = LOYALTY_PERMISSIONS.UPDATE_LOYALTY_PROGRAM
const POINTS = LOYALTY_PERMISSIONS.UPDATE_LOYALTY_POINTS
const REDEMPTION = LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION
const REPORT = LOYALTY_PERMISSIONS.READ_LOYALTY_REPORT

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
	resolveOrganizationForBrowserAuth: vi.fn(
		async (
			_origin: string | undefined,
			hint?: { slug?: string; host?: string },
		) => {
			if (!hint?.slug) return null
			for (const org of orgs.values()) {
				if (org.slug === hint.slug) return org
			}
			return null
		},
	),
	resolvePublishedOrganization: vi.fn(
		async (data: { slug?: string; host?: string }) => {
			for (const org of orgs.values()) {
				if (data.slug && org.slug === data.slug) return org
				if (data.host && org.customDomain === data.host) return org
			}
			return null
		},
	),
	resolveOrganizationForPublicOrigin: vi.fn(async () => null),
}))

const app = new Hono()
app.route('/loyalty', loyaltyRoutes)
app.route('/operator/loyalty', operatorLoyaltyRoutes)
app.route('/pos/loyalty', posLoyaltyRoutes)

function routeList(prefix: string): Array<{ method: string; path: string }> {
	const seen = new Set<string>()
	const list: Array<{ method: string; path: string }> = []
	for (const route of app.routes) {
		if (route.method === 'ALL') continue
		if (route.path !== prefix && !route.path.startsWith(`${prefix}/`)) continue
		const key = `${route.method} ${route.path}`
		if (seen.has(key)) continue
		seen.add(key)
		list.push({ method: route.method, path: route.path })
	}
	return list
}

const CUSTOMER_ROUTES = routeList('/loyalty')
const OPERATOR_ROUTES = routeList('/operator/loyalty')
const POS_ROUTES = routeList('/pos/loyalty')

function fill(routePath: string): string {
	return routePath.replace(/:[A-Za-z0-9_]+/g, 'x')
}

// ---------------------------------------------------------------------------
// Token minters
// ---------------------------------------------------------------------------

async function mintCustomerToken(
	overrides: {
		customerId?: string
		orgId?: string
		orgSlug?: string
		type?: string
		secret?: string
		audience?: string
		issuer?: string
	} = {},
): Promise<string> {
	return new jose.SignJWT({
		customerId: overrides.customerId ?? CUST_A1,
		orgId: overrides.orgId ?? ORG_A,
		orgSlug: overrides.orgSlug ?? SLUG_A,
		type: overrides.type ?? 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(overrides.issuer ?? brand.slug)
		.setAudience(overrides.audience ?? 'tenant-api')
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(overrides.secret ?? CUSTOMER_SECRET))
}

async function mintLoyaltyToken(
	overrides: {
		orgId?: string
		region?: 'us' | 'ksa'
		scope?: LoyaltyScope
		grants?: string[]
		locationIds?: string[] | null
		features?: LoyaltyFeatures
		impersonated?: boolean
		ttlSeconds?: number
		secret?: string
		typ?: string
		audience?: string
		issuer?: string
		subject?: string
	} = {},
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const ttl = overrides.ttlSeconds ?? 300
	return new jose.SignJWT({
		role: 'operator',
		orgId: overrides.orgId ?? ORG_A,
		region: overrides.region ?? 'us',
		scope: overrides.scope ?? 'read',
		grants: overrides.grants ?? [READ],
		locationIds:
			overrides.locationIds === undefined ? null : overrides.locationIds,
		features: overrides.features ?? FEATURES_ON,
		impersonated: overrides.impersonated ?? false,
	})
		.setProtectedHeader({
			alg: 'HS256',
			typ: overrides.typ ?? LOYALTY_TOKEN_TYP,
		})
		.setSubject(overrides.subject ?? 'user_lty_sec')
		.setIssuer(overrides.issuer ?? brand.shortName)
		.setAudience(overrides.audience ?? LOYALTY_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + ttl)
		.sign(new TextEncoder().encode(overrides.secret ?? OPERATOR_SECRET))
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

type ErrorBody = { error?: string; code?: string }

async function errorBody(res: Response): Promise<ErrorBody> {
	return (await res.json()) as ErrorBody
}

function customerRequest(
	method: string,
	path: string,
	options: {
		token?: string
		body?: unknown
		idempotencyKey?: string
		slug?: string
	} = {},
) {
	const headers: Record<string, string> = {}
	if (options.token) headers.Authorization = `Bearer ${options.token}`
	let body: string | undefined
	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.body)
	}
	if (options.idempotencyKey) {
		headers['Idempotency-Key'] = options.idempotencyKey
	}
	const slug = options.slug ?? SLUG_A
	// A POST that carries a body names its site there, never in the URL.
	const slugInBody =
		method === 'POST' &&
		(options.body === undefined ||
			(typeof options.body === 'object' && options.body !== null)) &&
		/^\/loyalty\/(checkout\/quote|tab\/quote|approvals\/[^/]+\/decide)$/.test(
			path,
		)
	if (slugInBody) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify({ ...(options.body as object | undefined), slug })
	}
	return app.request(slugInBody ? path : `${path}?slug=${slug}`, {
		method,
		headers,
		body,
	})
}

function operatorRequest(
	method: string,
	path: string,
	options: { token?: string; body?: unknown; idempotencyKey?: string } = {},
) {
	const headers: Record<string, string> = {}
	if (options.token) headers.Authorization = `Bearer ${options.token}`
	let body: string | undefined
	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.body)
	}
	if (options.idempotencyKey) {
		headers['Idempotency-Key'] = options.idempotencyKey
	}
	return app.request(path, { method, headers, body })
}

function posRequest(
	method: string,
	path: string,
	options: {
		secret?: string
		body?: unknown
		binding?: string
		idempotencyKey?: string
	} = {},
) {
	const headers: Record<string, string> = {}
	if (options.secret) headers.Authorization = `Bearer ${options.secret}`
	let body: string | undefined
	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.body)
	}
	if (options.binding) headers['X-Loyalty-Binding'] = options.binding
	if (options.idempotencyKey) {
		headers['Idempotency-Key'] = options.idempotencyKey
	}
	return app.request(path, { method, headers, body })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type TestDevice = { id: string; secret: string }

async function insertDevice(
	orgId: string,
	id: string,
	terminalCode: string,
	options: { signInRequired?: boolean; revoked?: boolean } = {},
): Promise<TestDevice> {
	const secret = formatPosDeviceSecret(orgId, id, randomPosToken())
	const db = await getTenantDb(orgId)
	await db.insert(posDevices).values({
		id,
		label: `Till ${id}`,
		terminalCode,
		locationId: LOC_A,
		secretHash: hashPosSecret(secret),
		pairedBy: 'test',
		signInRequired: options.signInRequired ?? false,
		...(options.revoked ? { revokedAt: Date.now() } : {}),
	})
	return { id, secret }
}

let tmpDir: string
let devA: TestDevice
let devB: TestDevice
let devSignIn: TestDevice
let devRevoked: TestDevice
let devRate: TestDevice

beforeAll(async () => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lty-sec-test-'))
	process.env.TENANT_DB_DIR = tmpDir
	process.env.DATA_REGION = 'us'
	process.env.JWT_SECRET = CUSTOMER_SECRET
	process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
	process.env.AUTH_HMAC_SECRET = HMAC_SECRET
	process.env.INTERNAL_COMMAND_TOKEN = 'lty-sec-internal-token-0123456789'
	syncEnvFromProcess()

	orgs.set(ORG_A, {
		id: ORG_A,
		slug: SLUG_A,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: 'Loyalty Sec A',
	})
	orgs.set(ORG_B, {
		id: ORG_B,
		slug: SLUG_B,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: 'Loyalty Sec B',
	})
	orgs.set(ORG_KSA, {
		id: ORG_KSA,
		slug: 'lty-sec-ksa',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'ksa',
		name: 'Loyalty Sec KSA',
	})
	orgs.set(ORG_UNPROVISIONED, {
		id: ORG_UNPROVISIONED,
		slug: 'lty-sec-unprov',
		customDomain: null,
		hasProvisionedDb: false,
		dataRegion: 'us',
		name: 'Loyalty Sec Unprovisioned',
	})

	await provisionTenantDb(ORG_A)
	await provisionTenantDb(ORG_B)
	await activateProgram(ORG_A)

	await insertCustomer(ORG_A, {
		id: CUST_A1,
		name: 'Ada Secure',
		phone: '+15550100001',
		verified: true,
	})
	await insertCustomer(ORG_A, {
		id: CUST_A2,
		name: 'Ben Secure',
		phone: '+15550100002',
		verified: true,
	})
	await insertCustomer(ORG_B, {
		id: CUST_B1,
		name: 'Bea Other',
		phone: '+15550100003',
		verified: true,
	})

	devA = await insertDevice(ORG_A, 'dev_lty_sec_a1', 'SA1')
	devB = await insertDevice(ORG_A, 'dev_lty_sec_b2', 'SB2')
	devSignIn = await insertDevice(ORG_A, 'dev_lty_sec_si', 'SSI', {
		signInRequired: true,
	})
	devRevoked = await insertDevice(ORG_A, 'dev_lty_sec_rv', 'SRV', {
		revoked: true,
	})
	devRate = await insertDevice(ORG_A, 'dev_lty_sec_rl', 'SRL')
})

beforeEach(() => {
	invalidateLoyaltyContext()
	seedLoyaltyContextForTest(ORG_A, FEATURES_ON)
	seedLoyaltyContextForTest(ORG_B, FEATURES_ON)
})

afterEach(() => {
	delete process.env.LOYALTY_ENABLED
})

afterAll(async () => {
	await destroyTenantDb(ORG_A)
	await destroyTenantDb(ORG_B)
	fs.rmSync(tmpDir, { recursive: true, force: true })
	vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Mounts and discovery
// ---------------------------------------------------------------------------

describe('mounts and route discovery', () => {
	it('app.ts mounts all three loyalty routers and every expected route exists', () => {
		const appSource = fs.readFileSync(
			path.resolve(import.meta.dirname, '..', 'app.ts'),
			'utf8',
		)
		for (const prefix of ['/loyalty', '/operator/loyalty', '/pos/loyalty']) {
			expect(appSource).toContain(`app.route('${prefix}'`)
		}

		const customerKeys = new Set(
			CUSTOMER_ROUTES.map((r) => `${r.method} ${r.path}`),
		)
		for (const key of [
			'GET /loyalty/program',
			'GET /loyalty/wallet',
			'GET /loyalty/history',
			'POST /loyalty/member-code',
			'GET /loyalty/approvals',
			'POST /loyalty/approvals/:approvalId/decide',
		]) {
			expect(customerKeys.has(key), key).toBe(true)
		}

		const operatorKeys = new Set(
			OPERATOR_ROUTES.map((r) => `${r.method} ${r.path}`),
		)
		expect(OPERATOR_ROUTES.length).toBeGreaterThanOrEqual(20)
		for (const key of [
			'GET /operator/loyalty/program',
			'PUT /operator/loyalty/program',
			'POST /operator/loyalty/program/status',
			'GET /operator/loyalty/rewards',
			'POST /operator/loyalty/rewards',
			'PUT /operator/loyalty/rewards/:rewardId',
			'POST /operator/loyalty/rewards/:rewardId/status',
			'GET /operator/loyalty/members/customer/:customerId',
			'GET /operator/loyalty/members/:memberId',
			'POST /operator/loyalty/members/:memberId/adjust',
			'POST /operator/loyalty/members/:memberId/status',
			'GET /operator/loyalty/activity',
			'GET /operator/loyalty/review',
			'POST /operator/loyalty/redemptions/:redemptionId/resolve',
			'POST /operator/loyalty/purchases/:purchaseId/resolve',
			'POST /operator/loyalty/refunds',
			'POST /operator/loyalty/requeue',
			'GET /operator/loyalty/balances/check',
			'POST /operator/loyalty/balances/:memberId/repair',
			'GET /operator/loyalty/reports',
		]) {
			expect(operatorKeys.has(key), key).toBe(true)
		}

		const posKeys = new Set(POS_ROUTES.map((r) => `${r.method} ${r.path}`))
		for (const key of [
			'POST /pos/loyalty/identify',
			'GET /pos/loyalty/member',
			'POST /pos/loyalty/member/revoke',
			'POST /pos/loyalty/quote',
			'POST /pos/loyalty/approvals',
			'GET /pos/loyalty/approvals/:approvalId',
			'POST /pos/loyalty/approvals/:approvalId/cancel',
			'POST /pos/loyalty/approvals/:approvalId/otp',
			'POST /pos/loyalty/approvals/:approvalId/otp/verify',
		]) {
			expect(posKeys.has(key), key).toBe(true)
		}
	})

	it('GET /loyalty/program is anonymous and answers the active program', async () => {
		const res = await customerRequest('GET', '/loyalty/program')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			program: { name: string; status: string } | null
		}
		expect(body.program?.name).toBe('Test Club')
		expect(body.program?.status).toBe('active')
	})
})

// ---------------------------------------------------------------------------
// Customer /loyalty routes
// ---------------------------------------------------------------------------

describe('customer loyalty security', () => {
	it('refuses every authenticated customer route without a bearer token (401)', async () => {
		const validBodies: Record<string, unknown> = {
			'POST /loyalty/approvals/:approvalId/decide': { decision: 'approve' },
		}
		const failures: string[] = []
		for (const route of CUSTOMER_ROUTES) {
			if (route.path === '/loyalty/program') continue // anonymous by design
			const key = `${route.method} ${route.path}`
			const res = await customerRequest(route.method, fill(route.path), {
				body: validBodies[key],
			})
			if (res.status !== 401) failures.push(`${key} -> ${res.status}`)
		}
		expect(failures).toEqual([])
	})

	it('refuses forged, wrong-audience and wrong-type customer tokens (401)', async () => {
		const wrongSecret = await mintCustomerToken({
			secret: `${CUSTOMER_SECRET}-mismatch`,
		})
		const wrongAudience = await mintCustomerToken({
			audience: LOYALTY_TOKEN_AUDIENCE,
		})
		const wrongType = await mintCustomerToken({ type: 'refresh' })
		for (const token of [wrongSecret, wrongAudience, wrongType]) {
			const res = await customerRequest('GET', '/loyalty/wallet', { token })
			expect(res.status).toBe(401)
		}
		// The genuine token passes authentication.
		const token = await mintCustomerToken()
		const ok = await customerRequest('GET', '/loyalty/wallet', { token })
		expect(ok.status).toBe(200)
	})

	it('a customer token for another organization answers 403 organization_mismatch', async () => {
		const foreign = await mintCustomerToken({
			customerId: CUST_B1,
			orgId: ORG_B,
			orgSlug: SLUG_B,
		})
		// The slug hint names ORG_A, the token names ORG_B.
		const res = await customerRequest('GET', '/loyalty/wallet', {
			token: foreign,
		})
		expect(res.status).toBe(403)
		expect(await errorBody(res)).toMatchObject({
			error: 'organization_mismatch',
		})
	})

	it('the organization flag gates writes (403 loyalty_disabled) while GET /program answers null', async () => {
		seedLoyaltyContextForTest(ORG_A, FEATURES_OFF)
		const token = await mintCustomerToken({ customerId: CUST_A1 })
		const memberCode = await customerRequest('POST', '/loyalty/member-code', {
			token,
		})
		expect(memberCode.status).toBe(403)
		expect(await errorBody(memberCode)).toMatchObject({
			error: 'loyalty_disabled',
		})

		const program = await customerRequest('GET', '/loyalty/program')
		expect(program.status).toBe(200)
		expect(await program.json()).toEqual({ program: null })
	})

	it('LOYALTY_ENABLED=false answers 503 loyalty_unavailable on customer writes', async () => {
		process.env.LOYALTY_ENABLED = 'false'
		const token = await mintCustomerToken({ customerId: CUST_A1 })
		const memberCode = await customerRequest('POST', '/loyalty/member-code', {
			token,
		})
		expect(memberCode.status).toBe(503)
		expect(await errorBody(memberCode)).toMatchObject({
			error: 'loyalty_unavailable',
		})
	})

	it('there is no enrollment route: POST /loyalty/enroll does not exist', async () => {
		const token = await mintCustomerToken({ customerId: CUST_A1 })
		const res = await customerRequest('POST', '/loyalty/enroll', {
			token,
			body: { acceptTerms: true, termsVersion: 1 },
		})
		expect(res.status).toBe(404)
	})

	it('GET /loyalty/wallet opens the points account of a signed-in verified customer, once', async () => {
		await insertCustomer(ORG_A, {
			id: CUST_ENROLL,
			name: 'Erin Early',
			phone: '+15550100055',
			verified: true,
		})
		const token = await mintCustomerToken({ customerId: CUST_ENROLL })
		const accounts = async () =>
			(await getTenantDb(ORG_A))
				.select()
				.from(loyaltyMembers)
				.where(eq(loyaltyMembers.customerId, CUST_ENROLL))
				.all()
		expect(await accounts()).toHaveLength(0)

		const first = await customerRequest('GET', '/loyalty/wallet', { token })
		expect(first.status).toBe(200)
		const firstBody = (await first.json()) as {
			wallet: { member: { id: string; status: string } }
		}
		expect(firstBody.wallet.member).toEqual({
			id: expect.any(String),
			status: 'active',
		})
		const [account] = await accounts()
		expect(firstBody.wallet.member.id).toBe(account!.id)

		const second = await customerRequest('GET', '/loyalty/wallet', { token })
		expect(
			((await second.json()) as { wallet: { member: { id: string } } }).wallet
				.member.id,
		).toBe(account!.id)
		expect(await accounts()).toHaveLength(1)
	})

	it('GET /loyalty/wallet opens no account for an unverified phone, a switched-off organization or the kill switch', async () => {
		const db = await getTenantDb(ORG_A)
		const accountsFor = async (customerId: string) =>
			db
				.select()
				.from(loyaltyMembers)
				.where(eq(loyaltyMembers.customerId, customerId))
				.all()

		await insertCustomer(ORG_A, {
			id: 'cus_lty_sec_unverified',
			phone: '+15550100056',
			verified: false,
		})
		const unverified = await customerRequest('GET', '/loyalty/wallet', {
			token: await mintCustomerToken({ customerId: 'cus_lty_sec_unverified' }),
		})
		expect(unverified.status).toBe(200)
		expect(
			((await unverified.json()) as { wallet: { member: unknown } }).wallet
				.member,
		).toBeNull()
		expect(await accountsFor('cus_lty_sec_unverified')).toHaveLength(0)

		await insertCustomer(ORG_A, {
			id: 'cus_lty_sec_off',
			phone: '+15550100057',
			verified: true,
		})
		const token = await mintCustomerToken({ customerId: 'cus_lty_sec_off' })
		seedLoyaltyContextForTest(ORG_A, FEATURES_OFF)
		const off = await customerRequest('GET', '/loyalty/wallet', { token })
		expect(await off.json()).toEqual({ wallet: null })
		expect(await accountsFor('cus_lty_sec_off')).toHaveLength(0)

		seedLoyaltyContextForTest(ORG_A, FEATURES_ON)
		process.env.LOYALTY_ENABLED = 'false'
		const stopped = await customerRequest('GET', '/loyalty/wallet', { token })
		expect(await stopped.json()).toEqual({ wallet: null })
		expect(await accountsFor('cus_lty_sec_off')).toHaveLength(0)
	})

	it('a customer cannot decide another customer’s till approval (404 approval_not_found)', async () => {
		const customerId = 'cus_lty_sec_appr'
		await insertCustomer(ORG_A, {
			id: customerId,
			name: 'Owen Owner',
			phone: '+15550100066',
			verified: true,
		})
		const memberId = await makeMember(ORG_A, { customerId })
		await givePoints(ORG_A, memberId, 50)
		const reward = await makeReward(ORG_A)
		const { code } = await issueMemberCode(ORG_A, {
			customerId,
			features: FEATURES_ON,
		})
		const till = await identifyMemberByCode(ORG_A, {
			code,
			device: { id: devA.id, locationId: LOC_A },
			features: FEATURES_ON,
		})
		const approval = await requestTillApproval(ORG_A, {
			binding: till.member.binding,
			device: { id: devA.id, locationId: LOC_A },
			rewardId: reward.id,
			rewardVersion: 1,
			saleId: randomUUID(),
			cart: loyaltyCart(),
			targetLineId: null,
			features: FEATURES_ON,
		})
		expect(approval.status).toBe('pending')

		const otherToken = await mintCustomerToken({ customerId: CUST_A2 })
		const denied = await customerRequest(
			'POST',
			`/loyalty/approvals/${approval.id}/decide`,
			{
				token: otherToken,
				body: { decision: 'approve' },
				idempotencyKey: 'lty-sec-decide-other-1',
			},
		)
		expect(denied.status).toBe(404)
		expect(await errorBody(denied)).toMatchObject({
			error: 'approval_not_found',
		})

		// The owning customer can still decide: the 404 above was not incidental.
		const ownerToken = await mintCustomerToken({ customerId })
		const owned = await customerRequest(
			'POST',
			`/loyalty/approvals/${approval.id}/decide`,
			{
				token: ownerToken,
				body: { decision: 'decline' },
				idempotencyKey: 'lty-sec-decide-owner-1',
			},
		)
		expect(owned.status).toBe(200)
		const ownedBody = (await owned.json()) as {
			approval: { status: string }
		}
		expect(ownedBody.approval.status).toBe('declined')
	})

	it('rate-limits member-code issuance for one customer (11th call → 429 rate_limited)', async () => {
		await insertCustomer(ORG_A, {
			id: CUST_RATE,
			name: 'Rita Rate',
			phone: '+15550100077',
			verified: true,
		})
		await makeMember(ORG_A, { customerId: CUST_RATE })
		const token = await mintCustomerToken({ customerId: CUST_RATE })
		let last: Response | undefined
		for (let i = 0; i < 11; i++) {
			last = await customerRequest('POST', '/loyalty/member-code', { token })
			if (i < 10) expect(last.status).toBe(201)
		}
		expect(last!.status).toBe(429)
		expect(await errorBody(last!)).toMatchObject({ error: 'rate_limited' })
	})
})

// ---------------------------------------------------------------------------
// Operator /operator/loyalty routes
// ---------------------------------------------------------------------------

describe('operator loyalty security', () => {
	it('refuses every operator route without a bearer token (401)', async () => {
		const failures: string[] = []
		for (const route of OPERATOR_ROUTES) {
			const res = await operatorRequest(route.method, fill(route.path))
			if (res.status !== 401) {
				failures.push(`${route.method} ${route.path} -> ${res.status}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('refuses forged, mis-typed, wrong-audience, over-long and impersonation-widened tokens on every route (401)', async () => {
		const wrongSecret = await mintLoyaltyToken({
			secret: `${OPERATOR_SECRET}-mismatch`,
		})
		// Loyalty claims signed with the customer JWT secret.
		const customerSigned = await mintLoyaltyToken({ secret: CUSTOMER_SECRET })
		// A generic operator token (signed with the right secret, wrong audience).
		const genericOperator = await mintLoyaltyToken({
			audience: 'tenant-api-operator',
		})
		const wrongTyp = await mintLoyaltyToken({ typ: 'JWT' })
		const overLongStandardTtl = await mintLoyaltyToken({ ttlSeconds: 901 })
		const overLongSensitiveTtl = await mintLoyaltyToken({
			scope: 'members',
			grants: [READ, POINTS],
			ttlSeconds: 301,
		})
		// The claims schema itself refuses write grants on an impersonated token.
		const impersonatedWrite = await mintLoyaltyToken({
			scope: 'members',
			grants: [READ, POINTS],
			impersonated: true,
			ttlSeconds: 300,
		})
		const invalidTokens = [
			wrongSecret,
			customerSigned,
			genericOperator,
			wrongTyp,
			overLongStandardTtl,
			overLongSensitiveTtl,
			impersonatedWrite,
		]
		const failures: string[] = []
		for (const route of OPERATOR_ROUTES) {
			for (const [index, token] of invalidTokens.entries()) {
				const res = await operatorRequest(route.method, fill(route.path), {
					token,
				})
				if (res.status !== 401) {
					failures.push(
						`token[${index}] ${route.method} ${route.path} -> ${res.status}`,
					)
				}
			}
		}
		expect(failures).toEqual([])
	})

	it('refuses a token minted for another region on every route (403 region_mismatch)', async () => {
		const ksaToken = await mintLoyaltyToken({ region: 'ksa' })
		const failures: string[] = []
		for (const route of OPERATOR_ROUTES) {
			const res = await operatorRequest(route.method, fill(route.path), {
				token: ksaToken,
			})
			const body = await errorBody(res)
			if (res.status !== 403 || body.error !== 'region_mismatch') {
				failures.push(
					`${route.method} ${route.path} -> ${res.status} ${body.error}`,
				)
			}
		}
		expect(failures).toEqual([])
	})

	it('enforces scope and grant on member reads and program writes', async () => {
		// read scope: member reads allowed, program writes refused by scope.
		const readToken = await mintLoyaltyToken({ scope: 'read', grants: [READ] })
		const members = await operatorRequest(
			'GET',
			`/operator/loyalty/members/customer/${CUST_A1}`,
			{ token: readToken },
		)
		expect(members.status).toBe(200)
		const putAsRead = await operatorRequest(
			'PUT',
			'/operator/loyalty/program',
			{ token: readToken, body: {} },
		)
		expect(putAsRead.status).toBe(403)
		expect(await errorBody(putAsRead)).toMatchObject({
			error: 'unauthorized_scope',
		})

		// reports scope: member reads refused by scope.
		const reportsToken = await mintLoyaltyToken({
			scope: 'reports',
			grants: [REPORT],
		})
		const membersAsReports = await operatorRequest(
			'GET',
			`/operator/loyalty/members/customer/${CUST_A1}`,
			{ token: reportsToken },
		)
		expect(membersAsReports.status).toBe(403)
		expect(await errorBody(membersAsReports)).toMatchObject({
			error: 'unauthorized_scope',
		})

		// setup scope without the program grant: refused by grant.
		const setupReadOnly = await mintLoyaltyToken({
			scope: 'setup',
			grants: [READ],
		})
		const putReadOnly = await operatorRequest(
			'PUT',
			'/operator/loyalty/program',
			{ token: setupReadOnly, body: {} },
		)
		expect(putReadOnly.status).toBe(403)
		expect(await errorBody(putReadOnly)).toMatchObject({
			error: 'forbidden_grant',
		})

		// setup scope with the program grant reaches the handler (400 on the
		// deliberately invalid body, never 401/403).
		const setupFull = await mintLoyaltyToken({
			scope: 'setup',
			grants: [READ, PROGRAM],
		})
		const putFull = await operatorRequest('PUT', '/operator/loyalty/program', {
			token: setupFull,
			body: {},
		})
		expect(putFull.status).toBe(400)
	})

	it('has no member list and no member search: nothing can enumerate customers or probe a phone number', async () => {
		const customerId = 'cus_lty_sec_search'
		await insertCustomer(ORG_A, {
			id: customerId,
			name: 'Sami Search',
			phone: '+15550100044',
			verified: true,
		})
		await makeMember(ORG_A, { customerId })
		const readToken = await mintLoyaltyToken({ scope: 'read', grants: [READ] })
		for (const url of [
			'/operator/loyalty/members',
			'/operator/loyalty/members?q=0044',
			'/operator/loyalty/members?limit=50',
		]) {
			const res = await operatorRequest('GET', url, { token: readToken })
			expect(res.status, url).toBe(404)
		}
		const search = await operatorRequest(
			'POST',
			'/operator/loyalty/members/search',
			{ token: readToken, body: { q: '+15550100044' } },
		)
		expect(search.status).toBe(404)
	})

	it('shows a location-scoped token only the accounts with a purchase or redemption at its locations', async () => {
		const db = await getTenantDb(ORG_A)
		const enroll = async (key: string, phone: string) => {
			const customerId = `cus_lty_sec_scope_${key}`
			await insertCustomer(ORG_A, {
				id: customerId,
				name: `Zed Scope ${key}`,
				phone,
				verified: true,
			})
			return { customerId, memberId: await makeMember(ORG_A, { customerId }) }
		}
		const boughtAtA = await enroll('bought_a', '+15550100201')
		const boughtAtB = await enroll('bought_b', '+15550100202')
		const redeemedAtA = await enroll('redeemed_a', '+15550100203')
		const nowhere = await enroll('nowhere', '+15550100204')
		await db.insert(loyaltyPurchases).values([
			{
				memberId: boughtAtA.memberId,
				channel: 'pos',
				sourceType: 'pos_order',
				sourceId: 'sale_lty_sec_scope_a',
				locationId: LOC_A,
				currency: 'USD',
			},
			{
				memberId: boughtAtB.memberId,
				channel: 'pos',
				sourceType: 'pos_order',
				sourceId: 'sale_lty_sec_scope_b',
				locationId: LOC_B,
				currency: 'USD',
			},
		])
		await givePoints(ORG_A, redeemedAtA.memberId, 50)
		const reward = await makeReward(ORG_A)
		await reserveReward(ORG_A, {
			memberId: redeemedAtA.memberId,
			rewardId: reward.id,
			locationId: LOC_A,
		})

		const scoped = await mintLoyaltyToken({ locationIds: [LOC_A] })
		const wide = await mintLoyaltyToken({ locationIds: null })
		const byCustomer = async (customerId: string, token: string) => {
			const res = await operatorRequest(
				'GET',
				`/operator/loyalty/members/customer/${customerId}`,
				{ token },
			)
			expect(res.status, customerId).toBe(200)
			return ((await res.json()) as { member: { id: string } | null }).member
		}
		expect((await byCustomer(boughtAtA.customerId, scoped))?.id).toBe(
			boughtAtA.memberId,
		)
		expect(await byCustomer(boughtAtB.customerId, scoped)).toBeNull()
		expect(await byCustomer(nowhere.customerId, scoped)).toBeNull()
		expect((await byCustomer(redeemedAtA.customerId, scoped))?.id).toBe(
			redeemedAtA.memberId,
		)
		expect((await byCustomer(boughtAtB.customerId, wide))?.id).toBe(
			boughtAtB.memberId,
		)

		const detail = (memberId: string, token: string) =>
			operatorRequest('GET', `/operator/loyalty/members/${memberId}`, {
				token,
			})
		expect((await detail(boughtAtA.memberId, scoped)).status).toBe(200)
		expect((await detail(redeemedAtA.memberId, scoped)).status).toBe(200)
		for (const memberId of [boughtAtB.memberId, nowhere.memberId]) {
			const hidden = await detail(memberId, scoped)
			expect(hidden.status, memberId).toBe(404)
			expect(await errorBody(hidden)).toMatchObject({
				error: 'member_not_found',
			})
			expect((await detail(memberId, wide)).status, memberId).toBe(200)
		}

		// A token scoped to no location sees no member tied to a location.
		const none = await mintLoyaltyToken({ locationIds: [] })
		expect(await byCustomer(boughtAtA.customerId, none)).toBeNull()
		expect(await byCustomer(redeemedAtA.customerId, none)).toBeNull()
	})

	it('answers 404 not_found for unknown, unprovisioned and wrong-region organizations', async () => {
		for (const orgId of [ORG_UNKNOWN, ORG_UNPROVISIONED, ORG_KSA]) {
			const token = await mintLoyaltyToken({ orgId })
			const res = await operatorRequest(
				'GET',
				'/operator/loyalty/members/customer/cus_x',
				{ token },
			)
			expect(res.status, orgId).toBe(404)
			expect(await errorBody(res), orgId).toMatchObject({
				error: 'not_found',
			})
		}
	})

	it('an ORG_B token only ever reads ORG_B data', async () => {
		const customerId = 'cus_lty_sec_xorg'
		await insertCustomer(ORG_A, {
			id: customerId,
			name: 'Xenia Cross',
			phone: '+15550100088',
			verified: true,
		})
		const memberId = await makeMember(ORG_A, { customerId })

		const tokenB = await mintLoyaltyToken({ orgId: ORG_B })
		const lookup = await operatorRequest(
			'GET',
			`/operator/loyalty/members/customer/${customerId}`,
			{ token: tokenB },
		)
		expect(lookup.status).toBe(200)
		expect(await lookup.json()).toEqual({ member: null })

		// The same member id addressed through ORG_B's token is simply absent.
		const detail = await operatorRequest(
			'GET',
			`/operator/loyalty/members/${memberId}`,
			{ token: tokenB },
		)
		expect(detail.status).toBe(404)
	})

	it('filters member activity to the token’s locations and refuses other locations', async () => {
		const customerId = 'cus_lty_sec_loc'
		await insertCustomer(ORG_A, {
			id: customerId,
			name: 'Lena Locke',
			phone: '+15550100099',
			verified: true,
		})
		const memberId = await makeMember(ORG_A, { customerId })
		const db = await getTenantDb(ORG_A)
		const now = Date.now()
		// The member is visible to a LOC_A token through this purchase.
		await db.insert(loyaltyPurchases).values({
			memberId,
			channel: 'pos',
			sourceType: 'pos_order',
			sourceId: 'sale_lty_sec_loc_a',
			locationId: LOC_A,
			currency: 'USD',
		})
		await db.insert(loyaltyLedger).values([
			{
				memberId,
				type: 'adjust',
				delta: 5,
				eventKey: `adjust:${memberId}:lty-sec-loc-b`,
				reason: 'goodwill',
				note: 'earned at loc b',
				actorKind: 'operator',
				actorId: 'op_test',
				locationId: LOC_B,
				at: now,
			},
			{
				memberId,
				type: 'adjust',
				delta: 3,
				eventKey: `adjust:${memberId}:lty-sec-org`,
				reason: 'goodwill',
				note: 'organization wide',
				actorKind: 'operator',
				actorId: 'op_test',
				locationId: null,
				at: now + 1,
			},
		])

		const scoped = await mintLoyaltyToken({ locationIds: [LOC_A] })
		const forbidden = await operatorRequest(
			'GET',
			`/operator/loyalty/activity?locationId=${LOC_B}`,
			{ token: scoped },
		)
		expect(forbidden.status).toBe(403)
		expect(await errorBody(forbidden)).toMatchObject({
			error: 'location_forbidden',
		})

		const allowed = await operatorRequest(
			'GET',
			`/operator/loyalty/activity?locationId=${LOC_A}`,
			{ token: scoped },
		)
		expect(allowed.status).toBe(200)

		// The org-wide rows of the feed link to the customer page.
		const orgWide = await operatorRequest('GET', '/operator/loyalty/activity', {
			token: scoped,
		})
		const feed = (await orgWide.json()) as {
			entries: Array<{ memberId: string; customerId: string | null }>
		}
		const mine = feed.entries.filter((entry) => entry.memberId === memberId)
		expect(mine.length).toBeGreaterThan(0)
		expect(mine.every((entry) => entry.customerId === customerId)).toBe(true)

		const detail = await operatorRequest(
			'GET',
			`/operator/loyalty/members/${memberId}`,
			{ token: scoped },
		)
		expect(detail.status).toBe(200)
		const detailBody = (await detail.json()) as {
			filteredByLocation: boolean
			entries: Array<{ locationId: string | null }>
		}
		expect(detailBody.filteredByLocation).toBe(true)
		expect(detailBody.entries).toHaveLength(1)
		expect(detailBody.entries[0]!.locationId).toBeNull()

		// An organization-wide token sees both entries.
		const wide = await mintLoyaltyToken({ locationIds: null })
		const wideDetail = await operatorRequest(
			'GET',
			`/operator/loyalty/members/${memberId}`,
			{ token: wide },
		)
		expect(wideDetail.status).toBe(200)
		const wideBody = (await wideDetail.json()) as {
			filteredByLocation: boolean
			entries: Array<{ locationId: string | null }>
		}
		expect(wideBody.filteredByLocation).toBe(false)
		expect(wideBody.entries).toHaveLength(2)
	})

	it('refuses balance and status writes from a location-scoped token', async () => {
		const customerId = 'cus_lty_sec_scope_write'
		await insertCustomer(ORG_A, { id: customerId, verified: true })
		const memberId = await makeMember(ORG_A, { customerId })
		const scoped = await mintLoyaltyToken({
			scope: 'members',
			grants: [POINTS],
			locationIds: [LOC_A],
		})

		const adjust = await operatorRequest(
			'POST',
			`/operator/loyalty/members/${memberId}/adjust`,
			{
				token: scoped,
				body: { delta: 5, reason: 'goodwill', note: 'scoped write' },
				idempotencyKey: 'lty-sec-scope-adjust-1',
			},
		)
		expect(adjust.status).toBe(403)
		expect(await errorBody(adjust)).toMatchObject({
			error: 'location_forbidden',
		})

		const status = await operatorRequest(
			'POST',
			`/operator/loyalty/members/${memberId}/status`,
			{
				token: scoped,
				body: { status: 'suspended' },
				idempotencyKey: 'lty-sec-scope-status-1',
			},
		)
		expect(status.status).toBe(403)
		expect(await errorBody(status)).toMatchObject({
			error: 'location_forbidden',
		})

		// An organization-wide token with the same grant can still adjust.
		const wide = await mintLoyaltyToken({
			scope: 'members',
			grants: [POINTS],
			locationIds: null,
		})
		const allowed = await operatorRequest(
			'POST',
			`/operator/loyalty/members/${memberId}/adjust`,
			{
				token: wide,
				body: { delta: 5, reason: 'goodwill', note: 'org-wide write' },
				idempotencyKey: 'lty-sec-scope-adjust-2',
			},
		)
		expect(allowed.status).toBe(200)
	})

	it('refuses balance checks and repairs from a location-scoped token', async () => {
		const customerId = 'cus_lty_sec_scope_repair'
		await insertCustomer(ORG_A, { id: customerId, verified: true })
		const memberId = await makeMember(ORG_A, { customerId })
		const scoped = await mintLoyaltyToken({
			scope: 'reconcile',
			grants: [READ, REDEMPTION],
			locationIds: [LOC_A],
			ttlSeconds: 300,
		})

		const check = await operatorRequest(
			'GET',
			'/operator/loyalty/balances/check',
			{ token: scoped },
		)
		expect(check.status).toBe(403)
		expect(await errorBody(check)).toMatchObject({
			error: 'location_forbidden',
		})

		const repair = await operatorRequest(
			'POST',
			`/operator/loyalty/balances/${memberId}/repair`,
			{
				token: scoped,
				body: {},
				idempotencyKey: 'lty-sec-scope-repair-1',
			},
		)
		expect(repair.status).toBe(403)
		expect(await errorBody(repair)).toMatchObject({
			error: 'location_forbidden',
		})

		// An organization-wide token with the same grants can do both.
		const wide = await mintLoyaltyToken({
			scope: 'reconcile',
			grants: [READ, REDEMPTION],
			locationIds: null,
			ttlSeconds: 300,
		})
		const wideCheck = await operatorRequest(
			'GET',
			'/operator/loyalty/balances/check',
			{ token: wide },
		)
		expect(wideCheck.status).toBe(200)
		const wideRepair = await operatorRequest(
			'POST',
			`/operator/loyalty/balances/${memberId}/repair`,
			{
				token: wide,
				body: {},
				idempotencyKey: 'lty-sec-scope-repair-2',
			},
		)
		expect(wideRepair.status).toBe(200)
	})

	it('stops one operator’s additions at the 24-hour limit (429 adjustment_limit)', async () => {
		const customerId = 'cus_lty_sec_adjust_limit'
		await insertCustomer(ORG_A, { id: customerId, verified: true })
		const memberId = await makeMember(ORG_A, { customerId })
		const token = await mintLoyaltyToken({
			scope: 'members',
			grants: [POINTS],
			subject: 'user_lty_sec_limit',
		})
		const adjust = (delta: number, idempotencyKey: string) =>
			operatorRequest('POST', `/operator/loyalty/members/${memberId}/adjust`, {
				token,
				body: { delta, reason: 'correction', note: 'daily limit' },
				idempotencyKey,
			})

		expect(
			(await adjust(LOYALTY_MAX_DAILY_ADJUSTMENT_CREDIT, 'lty-sec-limit-1'))
				.status,
		).toBe(200)
		const over = await adjust(1, 'lty-sec-limit-2')
		expect(over.status).toBe(429)
		expect(await over.json()).toMatchObject({
			error: 'adjustment_limit',
			remainingPoints: 0,
		})
		// Taking points away does not count against the day's additions.
		expect((await adjust(-1, 'lty-sec-limit-3')).status).toBe(200)
	})

	it('the token’s features gate non-reconcile routes (403 loyalty_disabled); reconcile routes skip the gate', async () => {
		const off = await mintLoyaltyToken({ features: FEATURES_OFF })
		const put = await operatorRequest('PUT', '/operator/loyalty/program', {
			token: off,
			body: {},
		})
		expect(put.status).toBe(403)
		expect(await errorBody(put)).toMatchObject({ error: 'loyalty_disabled' })

		// Reads ignore the kill switch, never the organization flag.
		const membersOff = await operatorRequest(
			'GET',
			`/operator/loyalty/members/customer/${CUST_A1}`,
			{ token: off },
		)
		expect(membersOff.status).toBe(403)
		expect(await errorBody(membersOff)).toMatchObject({
			error: 'loyalty_disabled',
		})

		const reviewOff = await operatorRequest('GET', '/operator/loyalty/review', {
			token: off,
		})
		expect(reviewOff.status).toBe(200)
	})

	it('LOYALTY_ENABLED=false answers 503 on new work but never strands reconciliation', async () => {
		process.env.LOYALTY_ENABLED = 'false'
		const setupToken = await mintLoyaltyToken({
			scope: 'setup',
			grants: [READ, PROGRAM],
		})
		const put = await operatorRequest('PUT', '/operator/loyalty/program', {
			token: setupToken,
			body: {},
		})
		expect(put.status).toBe(503)
		expect(await errorBody(put)).toMatchObject({
			error: 'loyalty_unavailable',
		})

		const reconcileToken = await mintLoyaltyToken({
			scope: 'reconcile',
			grants: [READ, REDEMPTION],
			ttlSeconds: 300,
		})
		// Reads keep answering, so an operator can still open a member to
		// record a refund; a write that is not reconciliation is refused.
		const members = await operatorRequest(
			'GET',
			`/operator/loyalty/members/customer/${CUST_A1}`,
			{ token: reconcileToken },
		)
		expect(members.status).toBe(200)
		const pointsToken = await mintLoyaltyToken({
			scope: 'members',
			grants: [READ, POINTS],
			ttlSeconds: 300,
		})
		const adjust = await operatorRequest(
			'POST',
			'/operator/loyalty/members/mem_missing/adjust',
			{
				token: pointsToken,
				body: { delta: 10, reason: 'goodwill', note: 'test note' },
				idempotencyKey: 'lty-sec-kill-adjust-1',
			},
		)
		expect(adjust.status).toBe(503)
		expect(await errorBody(adjust)).toMatchObject({
			error: 'loyalty_unavailable',
		})

		// Every reconcile route passes the flag/kill-switch gate. They may fail
		// on fixture data (404s), never on the gate.
		const reconcileCalls: Array<{
			method: string
			path: string
			body?: unknown
			idempotencyKey?: string
		}> = [
			{ method: 'GET', path: '/operator/loyalty/review' },
			{
				method: 'POST',
				path: '/operator/loyalty/redemptions/red_missing/resolve',
				body: { action: 'release', note: 'test note' },
				idempotencyKey: 'lty-sec-resolve-red-1',
			},
			{
				method: 'POST',
				path: '/operator/loyalty/purchases/pur_missing/resolve',
				body: { action: 'exclude', note: 'test note' },
				idempotencyKey: 'lty-sec-resolve-pur-1',
			},
			{
				method: 'POST',
				path: '/operator/loyalty/refunds',
				body: {
					source: { type: 'qr_tab', id: 'tab_missing' },
					full: true,
					note: 'test note',
				},
				idempotencyKey: 'lty-sec-refund-1',
			},
			{
				method: 'POST',
				path: '/operator/loyalty/requeue',
				body: { source: { type: 'restaurant_order', id: 'ord_missing' } },
			},
			{ method: 'GET', path: '/operator/loyalty/balances/check' },
			{
				method: 'POST',
				path: '/operator/loyalty/balances/mem_missing/repair',
				body: {},
				idempotencyKey: 'lty-sec-repair-1',
			},
		]
		for (const call of reconcileCalls) {
			const res = await operatorRequest(call.method, call.path, {
				token: reconcileToken,
				body: call.body,
				idempotencyKey: call.idempotencyKey,
			})
			const body = await errorBody(res)
			expect(res.status, `${call.method} ${call.path}`).not.toBe(503)
			expect(res.status, `${call.method} ${call.path}`).not.toBe(403)
			expect(res.status, `${call.method} ${call.path}`).toBeLessThan(500)
			expect(body.error).not.toBe('loyalty_unavailable')
			expect(body.error).not.toBe('loyalty_disabled')
		}

		// The read-only reconcile routes answer fully.
		const review = await operatorRequest('GET', '/operator/loyalty/review', {
			token: reconcileToken,
		})
		expect(review.status).toBe(200)
		const balances = await operatorRequest(
			'GET',
			'/operator/loyalty/balances/check',
			{ token: reconcileToken },
		)
		expect(balances.status).toBe(200)
		// A resolution against a missing redemption reaches the domain.
		const resolve = await operatorRequest(
			'POST',
			'/operator/loyalty/redemptions/red_missing/resolve',
			{
				token: reconcileToken,
				body: { action: 'release', note: 'test note' },
				idempotencyKey: 'lty-sec-resolve-red-2',
			},
		)
		expect(resolve.status).toBe(404)
		expect(await errorBody(resolve)).toMatchObject({
			error: 'redemption_not_found',
		})
	})
})

// ---------------------------------------------------------------------------
// POS /pos/loyalty routes
// ---------------------------------------------------------------------------

describe('POS loyalty security', () => {
	it('refuses every till route without a device secret (401)', async () => {
		const failures: string[] = []
		for (const route of POS_ROUTES) {
			const res = await posRequest(route.method, fill(route.path))
			if (res.status !== 401) {
				failures.push(`${route.method} ${route.path} -> ${res.status}`)
			}
		}
		expect(failures).toEqual([])
	})

	it('refuses malformed, unknown and revoked device secrets, and demands a staff session when sign-in is on', async () => {
		const malformed = await posRequest('POST', '/pos/loyalty/identify', {
			secret: 'not-a-device-secret',
			body: { code: 'NOPE-1234' },
		})
		expect(malformed.status).toBe(401)
		expect(await errorBody(malformed)).toMatchObject({
			error: 'invalid_device',
		})

		const unknownSecret = formatPosDeviceSecret(
			ORG_A,
			'dev_lty_sec_zz',
			randomPosToken(),
		)
		const unknown = await posRequest('POST', '/pos/loyalty/identify', {
			secret: unknownSecret,
			body: { code: 'NOPE-1234' },
		})
		expect(unknown.status).toBe(401)
		expect(await errorBody(unknown)).toMatchObject({ error: 'invalid_device' })

		const revoked = await posRequest('POST', '/pos/loyalty/identify', {
			secret: devRevoked.secret,
			body: { code: 'NOPE-1234' },
		})
		expect(revoked.status).toBe(401)
		expect(await errorBody(revoked)).toMatchObject({
			error: 'device_revoked',
		})

		// A terminal that requires sign-in refuses loyalty without a staff session.
		const noSession = await posRequest('POST', '/pos/loyalty/identify', {
			secret: devSignIn.secret,
			body: { code: 'NOPE-1234' },
		})
		expect(noSession.status).toBe(401)
		expect(await errorBody(noSession)).toMatchObject({
			error: 'staff_session_required',
		})
	})

	it('an unknown code is 404 code_invalid and a binding belongs to its terminal only', async () => {
		const customerId = 'cus_lty_sec_bind'
		await insertCustomer(ORG_A, {
			id: customerId,
			name: 'Binda Till',
			phone: '+15550100111',
			verified: true,
		})
		await makeMember(ORG_A, { customerId })
		const { code } = await issueMemberCode(ORG_A, {
			customerId,
			features: FEATURES_ON,
		})

		const unknownCode = await posRequest('POST', '/pos/loyalty/identify', {
			secret: devA.secret,
			body: { code: 'NOPE-1234' },
		})
		expect(unknownCode.status).toBe(404)
		expect(await errorBody(unknownCode)).toMatchObject({
			error: 'code_invalid',
		})

		// Identify through the service, then read the binding back over HTTP.
		const till = await identifyMemberByCode(ORG_A, {
			code,
			device: { id: devA.id, locationId: LOC_A },
			features: FEATURES_ON,
		})
		const binding = till.member.binding

		const noBinding = await posRequest('GET', '/pos/loyalty/member', {
			secret: devA.secret,
		})
		expect(noBinding.status).toBe(400)
		expect(await errorBody(noBinding)).toMatchObject({
			error: 'invalid_request',
		})

		const ownDevice = await posRequest('GET', '/pos/loyalty/member', {
			secret: devA.secret,
			binding,
		})
		expect(ownDevice.status).toBe(200)

		// The same binding presented by another terminal is invalid.
		const otherDevice = await posRequest('GET', '/pos/loyalty/member', {
			secret: devB.secret,
			binding,
		})
		expect(otherDevice.status).toBe(404)
		expect(await errorBody(otherDevice)).toMatchObject({
			error: 'binding_invalid',
		})
	})

	it('the organization flag gates till routes (403 loyalty_disabled)', async () => {
		seedLoyaltyContextForTest(ORG_A, FEATURES_OFF)
		const res = await posRequest('POST', '/pos/loyalty/identify', {
			secret: devA.secret,
			body: { code: 'NOPE-1234' },
		})
		expect(res.status).toBe(403)
		expect(await errorBody(res)).toMatchObject({ error: 'loyalty_disabled' })
	})

	it('with redemption off a till can neither send nor check a one-time code (403 redemption_disabled)', async () => {
		seedLoyaltyContextForTest(ORG_A, { ...FEATURES_ON, redemption: false })
		const send = await posRequest('POST', '/pos/loyalty/approvals/x/otp', {
			secret: devA.secret,
		})
		expect(send.status).toBe(403)
		expect(await errorBody(send)).toMatchObject({
			error: 'redemption_disabled',
		})
		const verify = await posRequest(
			'POST',
			'/pos/loyalty/approvals/x/otp/verify',
			{ secret: devA.secret, body: { otp: '123456' } },
		)
		expect(verify.status).toBe(403)
		expect(await errorBody(verify)).toMatchObject({
			error: 'redemption_disabled',
		})
	})

	async function pendingTillApproval(
		customerId: string,
		phone: string,
	): Promise<{ approvalId: string; binding: string }> {
		await insertCustomer(ORG_A, {
			id: customerId,
			name: 'Tilly Pending',
			phone,
			verified: true,
		})
		const memberId = await makeMember(ORG_A, { customerId })
		await givePoints(ORG_A, memberId, 50)
		const reward = await makeReward(ORG_A)
		const { code } = await issueMemberCode(ORG_A, {
			customerId,
			features: FEATURES_ON,
		})
		const till = await identifyMemberByCode(ORG_A, {
			code,
			device: { id: devA.id, locationId: LOC_A },
			features: FEATURES_ON,
		})
		const approval = await requestTillApproval(ORG_A, {
			binding: till.member.binding,
			device: { id: devA.id, locationId: LOC_A },
			rewardId: reward.id,
			rewardVersion: reward.version,
			saleId: randomUUID(),
			cart: loyaltyCart(),
			targetLineId: null,
			features: FEATURES_ON,
		})
		expect(approval.status).toBe('pending')
		return { approvalId: approval.id, binding: till.member.binding }
	}

	it.each([
		['the organization flag is off', 'flag'],
		['LOYALTY_ENABLED=false', 'kill'],
	] as const)(
		'a till can still read and cancel its approval and forget a member while %s',
		async (_label, mode) => {
			const { approvalId, binding } = await pendingTillApproval(
				`cus_lty_sec_inflight_${mode}`,
				mode === 'flag' ? '+15550100121' : '+15550100122',
			)
			if (mode === 'flag') seedLoyaltyContextForTest(ORG_A, FEATURES_OFF)
			else process.env.LOYALTY_ENABLED = 'false'

			// New work stays refused.
			const identify = await posRequest('POST', '/pos/loyalty/identify', {
				secret: devA.secret,
				body: { code: 'NOPE-1234' },
			})
			expect(identify.status).toBe(mode === 'flag' ? 403 : 503)

			const read = await posRequest(
				'GET',
				`/pos/loyalty/approvals/${approvalId}`,
				{ secret: devA.secret },
			)
			expect(read.status).toBe(200)
			expect(
				((await read.json()) as { approval: { status: string } }).approval
					.status,
			).toBe('pending')

			// Another terminal still cannot see it.
			const foreign = await posRequest(
				'GET',
				`/pos/loyalty/approvals/${approvalId}`,
				{ secret: devB.secret },
			)
			expect(foreign.status).toBe(404)

			const cancel = await posRequest(
				'POST',
				`/pos/loyalty/approvals/${approvalId}/cancel`,
				{ secret: devA.secret },
			)
			expect(cancel.status).toBe(200)
			expect(
				((await cancel.json()) as { approval: { status: string } }).approval
					.status,
			).toBe('cancelled')

			const revoke = await posRequest('POST', '/pos/loyalty/member/revoke', {
				secret: devA.secret,
				body: { binding },
			})
			expect(revoke.status).toBe(200)

			// The device secret is still required.
			const anonymous = await posRequest(
				'POST',
				`/pos/loyalty/approvals/${approvalId}/cancel`,
			)
			expect(anonymous.status).toBe(401)
		},
	)

	it('checks that the approval belongs to the terminal before counting one-time code sends', async () => {
		const { approvalId } = await pendingTillApproval(
			'cus_lty_sec_otp_owner',
			'+15550100123',
		)
		// Another terminal guessing at the approval never spends its sends.
		for (let i = 0; i < 4; i++) {
			const res = await posRequest(
				'POST',
				`/pos/loyalty/approvals/${approvalId}/otp`,
				{ secret: devB.secret },
			)
			expect(res.status).toBe(404)
			expect(await errorBody(res)).toMatchObject({
				error: 'approval_not_found',
			})
		}
		const own = await posRequest(
			'POST',
			`/pos/loyalty/approvals/${approvalId}/otp`,
			{ secret: devA.secret },
		)
		expect(own.status).not.toBe(429)
		expect(own.status).not.toBe(404)
	})
	it('LOYALTY_ENABLED=false answers 503 loyalty_unavailable on till routes', async () => {
		process.env.LOYALTY_ENABLED = 'false'
		const res = await posRequest('POST', '/pos/loyalty/identify', {
			secret: devA.secret,
			body: { code: 'NOPE-1234' },
		})
		expect(res.status).toBe(503)
		expect(await errorBody(res)).toMatchObject({
			error: 'loyalty_unavailable',
		})
	})

	it('rate-limits member-code guessing from one terminal (31st call → 429 rate_limited)', async () => {
		let last: Response | undefined
		for (let i = 0; i < 31; i++) {
			last = await posRequest('POST', '/pos/loyalty/identify', {
				secret: devRate.secret,
				body: { code: `NOPE-${1000 + i}` },
			})
			if (i < 30) {
				expect(last.status).toBe(404)
				expect(await errorBody(last)).toMatchObject({ error: 'code_invalid' })
			}
		}
		expect(last!.status).toBe(429)
		expect(await errorBody(last!)).toMatchObject({ error: 'rate_limited' })
	})
})
