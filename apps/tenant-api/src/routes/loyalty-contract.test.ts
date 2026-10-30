import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	LOYALTY_APPROVAL_TTL_MS,
	loyaltyApprovalResponseSchema,
	loyaltyApprovalsResponseSchema,
	loyaltyCheckoutQuoteResponseSchema,
	loyaltyErrorResponseSchema,
	loyaltyHistoryResponseSchema,
	loyaltyMemberCodeResponseSchema,
	loyaltyProgramResponseSchema,
	loyaltyWalletResponseSchema,
	type LoyaltyFeatures,
	type LoyaltyProgramConfig,
} from '@repo/loyalty'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ZodTypeAny } from 'zod'
import {
	invalidateLoyaltyContext,
	seedLoyaltyContextForTest,
} from '../lib/loyalty-context.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import {
	identifyMemberByCode,
	requestTillApproval,
} from '../services/loyalty-code-service.ts'
import {
	decodeLoyaltyCursor,
	encodeLoyaltyCursor,
	setMemberStatus,
} from '../services/loyalty-member-service.ts'
import {
	readProgramInTx,
	saveProgram,
	setProgramStatus,
} from '../services/loyalty-program-service.ts'
import { reconcileLoyaltySource } from '../services/loyalty-purchase-service.ts'
import {
	activateProgram,
	cartLine,
	claimAndQueue,
	givePoints,
	insertCustomer,
	insertOrder,
	insertPosDevice,
	loyaltyCart,
	makeReward,
	orderLine,
	programConfig,
	rewardDefinition,
} from '../services/loyalty-test-fixture.ts'
import { loyaltyRoutes } from './loyalty.ts'

/**
 * The customer loyalty contract (`/loyalty/*`), as the customer app consumes it.
 *
 * The canonical fixtures live in `packages/loyalty/contract-fixtures`. This
 * suite drives the real customer routes in process with the headers the
 * customer app sends (`Origin`, `X-Client`, a customer Bearer token, the
 * slug hint) and
 *
 *   1. checks every canonical fixture parses with the public response schemas,
 *   2. checks the live responses have exactly the fixture's key structure, so
 *      a server change that adds, removes or retypes a field fails here until
 *      the fixtures are re-recorded.
 *
 * Re-record with `npm run fixtures:loyalty -w tenant-api`. The clock is
 * frozen and stepped (only `Date` is faked) and every random id is replaced
 * in recording order, so recording twice leaves `git status` clean.
 */

const ORG = 'org_lty_contract'
const SLUG = 'acme'
const OTHER_ORG = 'org_lty_contract_other'
const OTHER_SLUG = 'acme-other'
const SITE_ORIGIN = 'http://acme.menuza.test:3008'
const JWT_SECRET = 'test-loyalty-contract-jwt-secret-123456'
const RECORD = process.env.RECORD_LOYALTY_FIXTURES === '1'

const CUSTOMER = 'cus_lty_contract_member'
const UNVERIFIED = 'cus_lty_contract_unverified'
const STRANGER = 'cus_lty_contract_other'
const SEEDED_PHONES = ['+14155553101', '+14155553102']
const SEEDED_NAMES = ['Fixture Member', 'Fixture Unverified']

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const CANONICAL_DIR = path.join(REPO_ROOT, 'packages/loyalty/contract-fixtures')
/** Hand-written answers with values a newer region may send; never recorded. */
const FUTURE_DIR = path.join(REPO_ROOT, 'packages/loyalty/future-fixtures')
const FUTURE_SCHEMAS: Record<string, ZodTypeAny> = {
	approval: loyaltyApprovalResponseSchema,
	approvals: loyaltyApprovalsResponseSchema,
	'checkout-quote': loyaltyCheckoutQuoteResponseSchema,
	history: loyaltyHistoryResponseSchema,
	program: loyaltyProgramResponseSchema,
	wallet: loyaltyWalletResponseSchema,
}

const FEATURES_ON: LoyaltyFeatures = {
	enabled: true,
	redemption: true,
}
const FEATURES_OFF: LoyaltyFeatures = {
	enabled: false,
	redemption: false,
}

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	resolveOrganizationForBrowserAuth: vi.fn(
		async (
			_origin: string | undefined,
			hint?: { slug?: string; host?: string },
		) => {
			for (const org of orgs.values()) {
				if (hint?.slug && org.slug === hint.slug) return org
			}
			return null
		},
	),
	resolvePublishedOrganization: vi.fn(async (data: { slug?: string }) => {
		for (const org of orgs.values()) {
			if (data.slug && org.slug === data.slug) return org
		}
		return null
	}),
}))

const app = new Hono()
app.route('/loyalty', loyaltyRoutes)

// ---------------------------------------------------------------------------
// A frozen clock that moves one second per request.
// ---------------------------------------------------------------------------

const START = Date.UTC(2030, 5, 14, 16, 0, 0)
let clock = START
let features: LoyaltyFeatures = FEATURES_ON

function advance(ms = 1000): number {
	clock += ms
	vi.setSystemTime(clock)
	return clock
}

let counter = 0
const key = () => `ios-contract-key-${String(++counter).padStart(4, '0')}`

async function mintCustomerToken(
	customerId: string,
	orgId = ORG,
	orgSlug = SLUG,
) {
	return new jose.SignJWT({ customerId, orgId, orgSlug, type: 'access' })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuer(brand.slug)
		.setAudience('tenant-api')
		.setIssuedAt()
		.setExpirationTime('2h')
		.sign(new TextEncoder().encode(JWT_SECRET))
}

type Reply = { status: number; body: any; text: string }

async function native(
	method: string,
	urlPath: string,
	options: { customer?: string; key?: string; body?: unknown } = {},
): Promise<Reply> {
	advance()
	// Re-seeded on every call: the frozen clock would otherwise age the
	// cached flags into a refresh against an App that is not running.
	seedLoyaltyContextForTest(ORG, features)
	seedLoyaltyContextForTest(OTHER_ORG, FEATURES_ON)
	const headers: Record<string, string> = {
		Accept: 'application/json',
		Origin: SITE_ORIGIN,
		'X-Client': 'ios',
	}
	if (options.customer) headers.Authorization = `Bearer ${options.customer}`
	if (options.key) headers['Idempotency-Key'] = options.key
	// A POST that carries a body names its site there, never in the URL.
	const slugInBody =
		method === 'POST' &&
		/\/loyalty\/(checkout\/quote|tab\/quote|approvals\/[^/?]+\/decide)$/.test(
			urlPath.split('?')[0]!,
		)
	if (slugInBody || options.body !== undefined) {
		headers['Content-Type'] = 'application/json'
	}
	const separator = urlPath.includes('?') ? '&' : '?'
	const res = await app.request(
		slugInBody ? urlPath : `${urlPath}${separator}slug=${SLUG}`,
		{
			method,
			headers,
			body: slugInBody
				? JSON.stringify({
						...(options.body as Record<string, unknown> | undefined),
						slug: SLUG,
					})
				: options.body === undefined
					? undefined
					: JSON.stringify(options.body),
		},
	)
	const text = await res.text()
	let body: any = null
	try {
		body = text ? JSON.parse(text) : null
	} catch {
		body = null
	}
	return { status: res.status, body, text }
}

// ---------------------------------------------------------------------------
// Normalization: fixtures must not depend on random ids or member codes.
// ---------------------------------------------------------------------------

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MEMBER_CODE_RE = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/
/** Valid member codes (Crockford base32 without I, L, O and U). */
const FIXTURE_CODES = ['K7QM-4XPR', 'H3VD-9TNA', 'W2ZE-6BCJ']

type Normalizer = (value: unknown, key: string) => unknown

function makeNormalizer(): Normalizer {
	const ids = new Map<string, string>()
	const codes = new Map<string, string>()
	const alias = (value: string) => {
		let fixed = ids.get(value)
		if (!fixed) {
			fixed = `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`
			ids.set(value, fixed)
		}
		return fixed
	}
	const walk: Normalizer = (value, key) => {
		if (typeof value === 'string') {
			if (UUID_RE.test(value)) return alias(value)
			if (key === 'code' && MEMBER_CODE_RE.test(value)) {
				let fixed = codes.get(value)
				if (!fixed) {
					fixed = FIXTURE_CODES[codes.size]
					if (!fixed) throw new Error('add a fixture member code')
					codes.set(value, fixed)
				}
				return fixed
			}
			if (key === 'nextCursor') {
				const cursor = decodeLoyaltyCursor(value)!
				return encodeLoyaltyCursor(cursor.at, alias(cursor.id))
			}
			return value
		}
		if (Array.isArray(value)) return value.map((v) => walk(v, key))
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([k, v]) => [
					k,
					walk(v, k),
				]),
			)
		}
		return value
	}
	return walk
}

/** The structure of a JSON value: keys and types, never the values. */
function shapeOf(value: unknown): unknown {
	if (value === null) return 'null'
	if (Array.isArray(value)) {
		const shapes = new Map<string, unknown>()
		for (const item of value) {
			const shape = shapeOf(item)
			shapes.set(JSON.stringify(shape), shape)
		}
		return { array: [...shapes.values()] }
	}
	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, shapeOf(v)]),
		)
	}
	return typeof value
}

/**
 * Two shapes agree when every key matches and nullable fields may be `null` in
 * one and a concrete type in the other (a fixture records one sample).
 */
function sameKeys(a: unknown, b: unknown, trail = ''): string[] {
	if (a === 'null' || b === 'null') return []
	if (typeof a === 'string' || typeof b === 'string') {
		return a === b
			? []
			: [`${trail}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`]
	}
	const aObj = a as Record<string, unknown>
	const bObj = b as Record<string, unknown>
	if ('array' in aObj || 'array' in bObj) {
		const aItems = (aObj.array as unknown[] | undefined) ?? []
		const bItems = (bObj.array as unknown[] | undefined) ?? []
		if (aItems.length === 0 || bItems.length === 0) return []
		return sameKeys(aItems[0], bItems[0], `${trail}[]`)
	}
	const problems: string[] = []
	for (const k of new Set([...Object.keys(aObj), ...Object.keys(bObj)])) {
		if (!(k in aObj)) problems.push(`${trail}.${k}: missing in fixture`)
		else if (!(k in bObj)) problems.push(`${trail}.${k}: missing in live`)
		else problems.push(...sameKeys(aObj[k], bObj[k], `${trail}.${k}`))
	}
	return problems
}

// ---------------------------------------------------------------------------
// The scenario: one member's life, driven like the customer app does.
// ---------------------------------------------------------------------------

type Recorded = { name: string; schema: ZodTypeAny; value: unknown }

const CONFIG: LoyaltyProgramConfig = programConfig({
	name: 'Acme Rewards',
	minimumSpendMinor: 500,
	earning: { method: 'spend', points: 1, perMinor: 100 },
	terms: 'Earn 1 point for every $1 you spend. Points have no cash value.',
	// A program's labels name only what its own earning rule chooses (this one
	// earns on spend); the rewards below carry their own labels.
	labels: { items: {}, categories: {} },
})

async function earnFromOrder(memberId: string, subtotalCents: number) {
	const at = advance()
	const orderId = await insertOrder(ORG, {
		subtotalCents,
		totalCents: subtotalCents,
		lines: [
			orderLine({
				unitPriceCents: subtotalCents,
				taxableUnitCents: subtotalCents,
				baseUnitCents: subtotalCents,
			}),
		],
		paidAt: new Date(at),
		completedAt: new Date(at),
	})
	const source = { type: 'restaurant_order' as const, id: orderId }
	await claimAndQueue(ORG, { memberId, source, at })
	const result = await reconcileLoyaltySource(ORG, source, { now: advance() })
	expect(result.purchase?.state).toBe('completed')
}

async function runScenario(): Promise<Recorded[]> {
	const out: Recorded[] = []
	const add = (
		name: string,
		schema: ZodTypeAny,
		reply: Reply,
		status = 200,
	) => {
		expect(reply.status, `${name}: ${reply.text}`).toBe(status)
		out.push({ name, schema, value: reply.body })
	}
	const errorFixture = (name: string, reply: Reply, status: number) =>
		add(name, loyaltyErrorResponseSchema, reply, status)

	await activateProgram(ORG, CONFIG, advance())
	const fiveOff = await makeReward(
		ORG,
		rewardDefinition({
			name: 'Five off your order',
			description: 'Any order, any time.',
			pointsCost: 100,
			discount: { type: 'fixed', amountMinor: 500 },
		}),
		advance(),
	)
	await makeReward(
		ORG,
		{
			kind: 'free_item',
			name: 'Free latte',
			description: null,
			pointsCost: 150,
			itemId: 'item_latte',
			labels: { items: { item_latte: 'Latte' }, categories: {} },
		},
		advance(),
	)
	await makeReward(
		ORG,
		rewardDefinition({
			kind: 'categories',
			name: '20% off pastries',
			description: 'Up to $4 off.',
			pointsCost: 400,
			discount: { type: 'percent', percentBp: 2000, maxDiscountMinor: 400 },
			categoryIds: ['cat_pastry'],
			labels: { items: {}, categories: { cat_pastry: 'Pastries' } },
		}),
		advance(),
	)

	const member = await mintCustomerToken(CUSTOMER)
	const unverified = await mintCustomerToken(UNVERIFIED)
	const stranger = await mintCustomerToken(STRANGER, OTHER_ORG, OTHER_SLUG)

	// Program is public; a signed-in customer without a verified phone has no account.
	const program = await native('GET', '/loyalty/program')
	add('program', loyaltyProgramResponseSchema, program)
	add(
		'wallet-not-member',
		loyaltyWalletResponseSchema,
		await native('GET', '/loyalty/wallet', { customer: unverified }),
	)
	errorFixture(
		'error-member-not-found',
		await native('GET', '/loyalty/history', { customer: unverified }),
		404,
	)
	errorFixture(
		'error-member-not-found-code',
		await native('POST', '/loyalty/member-code', { customer: unverified }),
		404,
	)
	errorFixture(
		'error-organization-mismatch',
		await native('GET', '/loyalty/wallet', { customer: stranger }),
		403,
	)

	// A verified customer opens their points account on the first wallet read.
	const opened = await native('GET', '/loyalty/wallet', { customer: member })
	add('wallet-opened', loyaltyWalletResponseSchema, opened)
	const memberId: string = opened.body.wallet.member.id
	add(
		'history-empty',
		loyaltyHistoryResponseSchema,
		await native('GET', '/loyalty/history', { customer: member }),
	)

	// Points: two paid orders earn, an operator adds goodwill points.
	await earnFromOrder(memberId, 1250)
	await givePoints(ORG, memberId, 300, advance())
	await earnFromOrder(memberId, 2000)

	const history = await native('GET', '/loyalty/history?limit=2', {
		customer: member,
	})
	add('history', loyaltyHistoryResponseSchema, history)
	expect(history.body.nextCursor).toEqual(expect.any(String))
	add(
		'history-last-page',
		loyaltyHistoryResponseSchema,
		await native(
			'GET',
			`/loyalty/history?limit=2&cursor=${encodeURIComponent(history.body.nextCursor)}`,
			{ customer: member },
		),
	)

	// The till reads a member code and asks to spend a reward.
	const code = await native('POST', '/loyalty/member-code', {
		customer: member,
	})
	add('member-code', loyaltyMemberCodeResponseSchema, code, 201)
	const device = {
		id: await insertPosDevice(ORG, { id: 'dev_lty_contract' }),
		locationId: 'loc_1',
	}
	const till = await identifyMemberByCode(ORG, {
		code: code.body.code,
		device,
		features: FEATURES_ON,
		now: advance(),
	})
	const ask = (saleId: string) =>
		requestTillApproval(ORG, {
			binding: till.member.binding,
			device,
			rewardId: fiveOff.id,
			rewardVersion: 1,
			saleId,
			cart: loyaltyCart([cartLine({ unitBaseMinor: 1800, unitMinor: 1800 })]),
			targetLineId: null,
			features: FEATURES_ON,
			now: advance(),
		})
	const first = await ask('sale_lty_contract_1')
	add(
		'approvals',
		loyaltyApprovalsResponseSchema,
		await native('GET', '/loyalty/approvals', { customer: member }),
	)
	add(
		'wallet-member',
		loyaltyWalletResponseSchema,
		await native('GET', '/loyalty/wallet', { customer: member }),
	)
	add(
		'approval-approved',
		loyaltyApprovalResponseSchema,
		await native('POST', `/loyalty/approvals/${first.id}/decide`, {
			customer: member,
			key: key(),
			body: { decision: 'approve' },
		}),
	)
	add(
		'wallet-after-approval',
		loyaltyWalletResponseSchema,
		await native('GET', '/loyalty/wallet', { customer: member }),
	)
	errorFixture(
		'error-approval-closed',
		await native('POST', `/loyalty/approvals/${first.id}/decide`, {
			customer: member,
			key: key(),
			body: { decision: 'decline' },
		}),
		409,
	)
	const second = await ask('sale_lty_contract_2')
	add(
		'approval-declined',
		loyaltyApprovalResponseSchema,
		await native('POST', `/loyalty/approvals/${second.id}/decide`, {
			customer: member,
			key: key(),
			body: { decision: 'decline' },
		}),
	)
	add(
		'approvals-empty',
		loyaltyApprovalsResponseSchema,
		await native('GET', '/loyalty/approvals', { customer: member }),
	)
	errorFixture(
		'error-approval-not-found',
		await native('POST', '/loyalty/approvals/apr_unknown_0000/decide', {
			customer: member,
			key: key(),
			body: { decision: 'approve' },
		}),
		404,
	)
	const third = await ask('sale_lty_contract_3')
	advance(LOYALTY_APPROVAL_TTL_MS)
	errorFixture(
		'error-approval-expired',
		await native('POST', `/loyalty/approvals/${third.id}/decide`, {
			customer: member,
			key: key(),
			body: { decision: 'approve' },
		}),
		410,
	)
	const fourth = await ask('sale_lty_contract_4')
	features = { ...FEATURES_ON, redemption: false }
	errorFixture(
		'error-redemption-disabled',
		await native('POST', `/loyalty/approvals/${fourth.id}/decide`, {
			customer: member,
			key: key(),
			body: { decision: 'approve' },
		}),
		403,
	)
	features = FEATURES_ON
	await native('POST', `/loyalty/approvals/${fourth.id}/decide`, {
		customer: member,
		key: key(),
		body: { decision: 'decline' },
	})

	// Terms are display text only: editing them does not block the wallet.
	const database = await getTenantDb(ORG)
	await saveProgram(ORG, {
		expectedVersion: (await readProgramInTx(database))!.program.version,
		config: {
			...CONFIG,
			terms: `${CONFIG.terms} Points expire after 12 months without a purchase.`,
		},
		actorId: 'op_contract',
		now: advance(),
	})
	add(
		'wallet-terms-updated',
		loyaltyWalletResponseSchema,
		await native('GET', '/loyalty/wallet', { customer: member }),
	)

	// The operator pauses the program, then resumes it.
	await setProgramStatus(ORG, {
		expectedVersion: (await readProgramInTx(database))!.program.version,
		status: 'paused',
		actorId: 'op_contract',
		now: advance(),
	})
	add(
		'wallet-paused',
		loyaltyWalletResponseSchema,
		await native('GET', '/loyalty/wallet', { customer: member }),
	)
	errorFixture(
		'error-program-inactive',
		await native('POST', '/loyalty/member-code', { customer: member }),
		409,
	)
	await setProgramStatus(ORG, {
		expectedVersion: (await readProgramInTx(database))!.program.version,
		status: 'active',
		actorId: 'op_contract',
		now: advance(),
	})

	// The operator suspends the member, then reinstates them.
	await setMemberStatus(ORG, {
		memberId,
		status: 'suspended',
		actorId: 'op_contract',
		now: advance(),
	})
	add(
		'wallet-suspended',
		loyaltyWalletResponseSchema,
		await native('GET', '/loyalty/wallet', { customer: member }),
	)
	errorFixture(
		'error-member-inactive',
		await native('POST', '/loyalty/member-code', { customer: member }),
		409,
	)
	await setMemberStatus(ORG, {
		memberId,
		status: 'active',
		actorId: 'op_contract',
		now: advance(),
	})

	// The organization turns loyalty off; then the node's kill switch.
	features = FEATURES_OFF
	add(
		'program-none',
		loyaltyProgramResponseSchema,
		await native('GET', '/loyalty/program'),
	)
	add(
		'wallet-none',
		loyaltyWalletResponseSchema,
		await native('GET', '/loyalty/wallet', { customer: member }),
	)
	errorFixture(
		'error-loyalty-disabled',
		await native('POST', '/loyalty/member-code', { customer: member }),
		403,
	)
	features = FEATURES_ON
	process.env.LOYALTY_ENABLED = 'false'
	errorFixture(
		'error-unavailable',
		await native('POST', '/loyalty/member-code', { customer: member }),
		503,
	)
	delete process.env.LOYALTY_ENABLED

	// Too many member codes in one window.
	let limited: Reply | null = null
	for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
		const reply = await native('POST', '/loyalty/member-code', {
			customer: member,
		})
		if (reply.status === 429) limited = reply
		else expect(reply.status, reply.text).toBe(201)
	}
	expect(limited, 'member codes were never rate limited').not.toBeNull()
	errorFixture('error-rate-limited', limited!, 429)

	const normalize = makeNormalizer()
	return out.map((r) => ({ ...r, value: normalize(r.value, '') }))
}

let tempDir: string

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	clock = START
	vi.setSystemTime(clock)
	features = FEATURES_ON
	counter = 0
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lty-contract-test-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.JWT_SECRET = JWT_SECRET
	process.env.TENANT_OPERATOR_TOKEN =
		'test-loyalty-contract-operator-secret-32-chars!!'
	process.env.AUTH_HMAC_SECRET = 'test-loyalty-contract-hmac-secret-0123456789'
	syncEnvFromProcess()
	invalidateLoyaltyContext()
	orgs.set(ORG, {
		id: ORG,
		slug: SLUG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: 'Acme Bistro',
	})
	orgs.set(OTHER_ORG, {
		id: OTHER_ORG,
		slug: OTHER_SLUG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: 'Acme Other',
	})
	await provisionTenantDb(ORG)
	await provisionTenantDb(OTHER_ORG)
	await insertCustomer(ORG, {
		id: CUSTOMER,
		name: SEEDED_NAMES[0],
		phone: SEEDED_PHONES[0],
		verified: true,
	})
	await insertCustomer(ORG, {
		id: UNVERIFIED,
		name: SEEDED_NAMES[1],
		phone: SEEDED_PHONES[1],
		verified: false,
	})
})

afterEach(async () => {
	delete process.env.LOYALTY_ENABLED
	vi.useRealTimers()
	invalidateLoyaltyContext()
	await destroyTenantDb(ORG).catch(() => undefined)
	await destroyTenantDb(OTHER_ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

function listJson(dir: string) {
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((f) => f.endsWith('.json'))
				.sort()
		: []
}

describe('loyalty contract fixtures', () => {
	it.runIf(RECORD)('records the canonical fixtures', async () => {
		const recorded = await runScenario()
		fs.rmSync(CANONICAL_DIR, { recursive: true, force: true })
		fs.mkdirSync(CANONICAL_DIR, { recursive: true })
		for (const { name, value } of recorded) {
			const text = `${JSON.stringify(value, null, '\t')}\n`
			fs.writeFileSync(path.join(CANONICAL_DIR, `${name}.json`), text)
		}
	})

	it.skipIf(RECORD)(
		'parses every canonical fixture and matches the live responses key for key',
		async () => {
			const recorded = await runScenario()
			const files = listJson(CANONICAL_DIR)
			expect(new Set(files)).toEqual(
				new Set(recorded.map((r) => `${r.name}.json`)),
			)
			for (const { name, value, schema } of recorded) {
				const file = path.join(CANONICAL_DIR, `${name}.json`)
				const fixture = JSON.parse(fs.readFileSync(file, 'utf8'))
				const parsed = schema.safeParse(fixture)
				expect(
					parsed.success,
					`${name}: ${JSON.stringify(parsed.error?.issues)}`,
				).toBe(true)
				expect(schema.safeParse(value).success, `${name} live`).toBe(true)
				expect(sameKeys(shapeOf(fixture), shapeOf(value), name), name).toEqual(
					[],
				)
			}
		},
	)

	it.skipIf(RECORD)(
		'decodes the future-value fixtures, which recording never deletes',
		() => {
			expect(path.relative(CANONICAL_DIR, FUTURE_DIR).startsWith('..')).toBe(
				true,
			)
			expect(listJson(FUTURE_DIR)).toEqual(
				Object.keys(FUTURE_SCHEMAS)
					.map((name) => `${name}.json`)
					.sort(),
			)
			for (const [name, schema] of Object.entries(FUTURE_SCHEMAS)) {
				const fixture = JSON.parse(
					fs.readFileSync(path.join(FUTURE_DIR, `${name}.json`), 'utf8'),
				)
				const parsed = schema.safeParse(fixture)
				expect(
					parsed.success,
					`${name}: ${JSON.stringify(parsed.error?.issues)}`,
				).toBe(true)
			}
		},
	)

	it.skipIf(RECORD)('never carries the member’s name or phone number', () => {
		for (const file of listJson(CANONICAL_DIR)) {
			const text = fs.readFileSync(path.join(CANONICAL_DIR, file), 'utf8')
			for (const value of [...SEEDED_PHONES, ...SEEDED_NAMES]) {
				expect(text, file).not.toContain(value)
			}
		}
	})
})
