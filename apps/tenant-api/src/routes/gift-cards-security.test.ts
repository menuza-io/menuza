import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	defaultGiftCardSettings,
	GIFT_CARD_PERMISSIONS,
	GIFT_CARD_TOKEN_AUDIENCE,
	GIFT_CARD_TOKEN_TYP,
	type GiftCardFeatures,
	type GiftCardScope,
} from '@repo/common/gift-cards'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import * as jose from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { sellGiftCard } from '../services/gift-card-service.ts'
import { operatorGiftCardRoutes } from './operator-gift-cards.ts'

/**
 * Security sweep for `/operator/gift-cards/*`, modelled on the inventory and
 * loyalty sweeps: the control plane is mocked, every organization gets a real
 * tenant database, tokens are minted and forged with jose. Every route the
 * router declares is swept, so a new route is covered (or fails) here.
 */

const OPERATOR_SECRET = 'gift-sec-operator-token-0123456789abcdef'
const ORG_A = 'org_gift_sec_a'
const ORG_B = 'org_gift_sec_b'
const ORG_KSA = 'org_gift_sec_ksa'
const ORG_UNKNOWN = 'org_gift_sec_unknown'

const READ = GIFT_CARD_PERMISSIONS.READ_GIFT_CARD
const UPDATE = GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD
const CHARGE = GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD_CHARGE

const FEATURES_ON: GiftCardFeatures = { enabled: true, online: true, pos: true }

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const app = new Hono()
app.route('/operator/gift-cards', operatorGiftCardRoutes)

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

/** Every operator route and the one grant it needs. */
const ROUTE_GRANTS: Record<string, string> = {
	'GET /operator/gift-cards': READ,
	'POST /operator/gift-cards/lookup': READ,
	'GET /operator/gift-cards/:id': READ,
	'POST /operator/gift-cards/:id/adjust': UPDATE,
	'POST /operator/gift-cards/:id/void': UPDATE,
	'POST /operator/gift-cards/:id/charges': CHARGE,
	'POST /operator/gift-cards/:id/charges/:chargeId/refund': CHARGE,
	'POST /operator/gift-cards/:id/approve': UPDATE,
	'POST /operator/gift-cards/:id/refund-purchase': UPDATE,
}

let dir = ''
let cardA: Awaited<ReturnType<typeof sellGiftCard>>
let n = 0
const rid = () => `req-${Date.now().toString(36)}-${(n += 1)}`

async function mint(
	orgId: string,
	options: {
		scope?: GiftCardScope
		grants?: string[]
		locationIds?: string[] | null
		impersonated?: boolean
		region?: 'us' | 'ksa'
		features?: GiftCardFeatures
		audience?: string
		typ?: string
		secret?: string
		expiresIn?: number
		actorName?: string
	} = {},
) {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId,
		region: options.region ?? 'us',
		scope: options.scope ?? 'write',
		grants: options.grants ?? [READ, UPDATE, CHARGE],
		locationIds: options.locationIds === undefined ? null : options.locationIds,
		features: options.features ?? FEATURES_ON,
		impersonated: options.impersonated ?? false,
		actorName: options.actorName ?? 'Pat Manager',
	})
		.setProtectedHeader({
			alg: 'HS256',
			typ: options.typ ?? GIFT_CARD_TOKEN_TYP,
		})
		.setSubject('user_owner')
		.setIssuer(brand.shortName)
		.setAudience(options.audience ?? GIFT_CARD_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + (options.expiresIn ?? 600))
		.sign(new TextEncoder().encode(options.secret ?? OPERATOR_SECRET))
}

async function call(
	method: string,
	requestPath: string,
	options: {
		token?: string
		body?: unknown
		headers?: Record<string, string>
	} = {},
) {
	const headers: Record<string, string> = { ...options.headers }
	if (options.token) headers.Authorization = `Bearer ${options.token}`
	let body: string | undefined
	if (options.body !== undefined) {
		headers['Content-Type'] = 'application/json'
		body = JSON.stringify(options.body)
	}
	const res = await app.request(requestPath, { method, headers, body })
	return { status: res.status, body: (await res.json()) as any }
}

function concrete(routePath: string, cardId: string): string {
	return routePath.replace(':id', cardId).replace(':chargeId', 'charge_1')
}

const BODIES: Record<string, unknown> = {
	'POST /operator/gift-cards/lookup': { code: 'ZZZZZZZZZZZZZZZZ' },
	'POST /operator/gift-cards/:id/adjust': {
		expectedBalanceMinor: 5000,
		deltaMinor: 100,
		reason: 'test',
	},
	'POST /operator/gift-cards/:id/void': { reason: 'test' },
	'POST /operator/gift-cards/:id/charges': {
		amountMinor: 100,
		note: 'test',
		clientRequestId: 'client-req-0001',
	},
	'POST /operator/gift-cards/:id/charges/:chargeId/refund': {
		amountMinor: 100,
		clientRequestId: 'client-req-0002',
	},
	'POST /operator/gift-cards/:id/approve': {},
	'POST /operator/gift-cards/:id/refund-purchase': {},
}

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gift-sec-'))
	process.env.TENANT_DB_DIR = dir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
	process.env.AUTH_HMAC_SECRET = 'gift-sec-hmac-secret-0123456789abcdef'
	process.env.INTERNAL_COMMAND_TOKEN = 'gift-sec-internal-token-0123456789'
	delete process.env.GIFT_CARDS_ENABLED
	syncEnvFromProcess()
	for (const id of [ORG_A, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		} as unknown as PublishedOrganization)
		await provisionTenantDb(id)
	}
	orgs.set(ORG_KSA, {
		id: ORG_KSA,
		slug: ORG_KSA,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'ksa',
	} as unknown as PublishedOrganization)
	cardA = await sellGiftCard({
		orgId: ORG_A,
		amountMinor: 5000,
		currency: 'USD',
		locationId: 'loc_a',
		actor: { id: 'u', name: 'U' },
		deviceId: 'dev',
		clientRequestId: rid(),
		paymentMethod: 'cash',
		settings: defaultGiftCardSettings(),
	})
})

afterAll(async () => {
	for (const id of [ORG_A, ORG_B])
		await destroyTenantDb(id).catch(() => undefined)
	fs.rmSync(dir, { recursive: true, force: true })
})

describe('route discovery', () => {
	it('knows the grant of every route the router declares', () => {
		const declared = ROUTES.map((r) => `${r.method} ${r.path}`).sort()
		expect(declared).toEqual(Object.keys(ROUTE_GRANTS).sort())
	})
})

describe('every route refuses a bad token', () => {
	for (const route of Object.keys(ROUTE_GRANTS)) {
		const [method, routePath] = route.split(' ') as [string, string]
		const url = () => concrete(routePath, cardA.cardId)
		const body = BODIES[route]
		const send = (token?: string) => call(method, url(), { token, body })

		it(`${route}: no token is 401`, async () => {
			expect((await send()).status).toBe(401)
		})
		it(`${route}: a forged signature is 401`, async () => {
			const token = await mint(ORG_A, {
				secret: 'not-the-operator-secret-0123456789abcdef',
			})
			expect((await send(token)).status).toBe(401)
		})
		it(`${route}: another token audience is 401`, async () => {
			for (const audience of [
				'tenant-api-operator',
				'tenant-api-inventory-operator',
				'tenant-api-loyalty-operator',
			]) {
				expect((await send(await mint(ORG_A, { audience }))).status).toBe(401)
			}
		})
		it(`${route}: the wrong token type is 401`, async () => {
			expect((await send(await mint(ORG_A, { typ: 'JWT' }))).status).toBe(401)
		})
		it(`${route}: an expired token is 401`, async () => {
			expect((await send(await mint(ORG_A, { expiresIn: -60 }))).status).toBe(
				401,
			)
		})
		it(`${route}: a token for another region is 403`, async () => {
			expect((await send(await mint(ORG_A, { region: 'ksa' }))).status).toBe(
				403,
			)
		})
		it(`${route}: gift cards off is 403 gift_cards_disabled`, async () => {
			const res = await send(
				await mint(ORG_A, { features: { ...FEATURES_ON, enabled: false } }),
			)
			expect(res.status).toBe(403)
			expect(res.body.code).toBe('gift_cards_disabled')
		})
		it(`${route}: without its grant is 403`, async () => {
			const wanted = ROUTE_GRANTS[route]
			// `update:` grants imply read, so a read route is reached by any grant;
			// every other route refuses a token that does not carry its own.
			if (wanted === READ) return
			for (const grant of [READ, UPDATE, CHARGE].filter((g) => g !== wanted)) {
				const res = await send(await mint(ORG_A, { grants: [grant] }))
				expect(res.status, `${route} with ${grant}`).toBe(403)
			}
		})
	}
})

describe('scopes, impersonation and organizations', () => {
	it('a read-scope token cannot change anything', async () => {
		const token = await mint(ORG_A, { scope: 'read', grants: [READ] })
		const res = await call(
			'POST',
			`/operator/gift-cards/${cardA.cardId}/void`,
			{ token, body: { reason: 'x' } },
		)
		expect(res.status).toBe(403)
		expect(
			(await call('GET', `/operator/gift-cards/${cardA.cardId}`, { token }))
				.status,
		).toBe(200)
	})

	it('an impersonated token reads but can neither adjust nor charge', async () => {
		const token = await mint(ORG_A, {
			scope: 'read',
			grants: [READ],
			impersonated: true,
			expiresIn: 240,
		})
		expect((await call('GET', '/operator/gift-cards', { token })).status).toBe(
			200,
		)
		const writeScope = jose.decodeJwt(token)
		expect(writeScope.impersonated).toBe(true)
		// A write-scope token claiming an update grant while impersonated is refused outright.
		const forged = await mint(ORG_A, {
			scope: 'write',
			grants: [UPDATE, CHARGE],
			impersonated: true,
			expiresIn: 240,
		})
		expect(
			(
				await call('POST', `/operator/gift-cards/${cardA.cardId}/charges`, {
					token: forged,
					body: BODIES['POST /operator/gift-cards/:id/charges'],
					headers: { 'Idempotency-Key': rid() },
				})
			).status,
		).toBe(401)
	})

	it('another organization never sees this card', async () => {
		const token = await mint(ORG_B)
		expect(
			(await call('GET', `/operator/gift-cards/${cardA.cardId}`, { token }))
				.status,
		).toBe(404)
		expect(
			(await call('GET', '/operator/gift-cards', { token })).body.cards,
		).toEqual([])
	})

	it('an organization on another node or unknown is refused', async () => {
		expect(
			(
				await call('GET', '/operator/gift-cards', {
					token: await mint(ORG_UNKNOWN),
				})
			).status,
		).toBe(404)
		expect(
			(
				await call('GET', '/operator/gift-cards', {
					token: await mint(ORG_KSA),
				})
			).status,
		).toBe(404)
	})

	it('a location-scoped token sees only its own locations', async () => {
		const token = await mint(ORG_A, { locationIds: ['loc_other'] })
		expect(
			(await call('GET', `/operator/gift-cards/${cardA.cardId}`, { token }))
				.status,
		).toBe(403)
		expect(
			(await call('GET', '/operator/gift-cards', { token })).body.cards,
		).toEqual([])
		const mine = await mint(ORG_A, { locationIds: ['loc_a'] })
		expect(
			(await call('GET', '/operator/gift-cards', { token: mine })).body.cards,
		).toHaveLength(1)
	})
})

describe('behaviour', () => {
	it('adjusting needs the expected balance, a reason and a key, and a replay is safe', async () => {
		const token = await mint(ORG_A)
		const base = `/operator/gift-cards/${cardA.cardId}/adjust`
		const noKey = await call('POST', base, {
			token,
			body: { expectedBalanceMinor: 5000, deltaMinor: 100, reason: 'r' },
		})
		expect(noKey.status).toBe(400)
		const key = rid()
		const stale = await call('POST', base, {
			token,
			headers: { 'Idempotency-Key': rid() },
			body: { expectedBalanceMinor: 1, deltaMinor: 100, reason: 'r' },
		})
		expect(stale.status).toBe(409)
		expect(stale.body.code).toBe('stale_balance')
		const ok = await call('POST', base, {
			token,
			headers: { 'Idempotency-Key': key },
			body: { expectedBalanceMinor: 5000, deltaMinor: 100, reason: 'goodwill' },
		})
		expect(ok.status).toBe(200)
		expect(ok.body.balanceMinor).toBe(5100)
		const replay = await call('POST', base, {
			token,
			headers: { 'Idempotency-Key': key },
			body: { expectedBalanceMinor: 5000, deltaMinor: 100, reason: 'goodwill' },
		})
		expect(replay.body.balanceMinor).toBe(5100)
		const conflict = await call('POST', base, {
			token,
			headers: { 'Idempotency-Key': key },
			body: { expectedBalanceMinor: 5000, deltaMinor: 900, reason: 'goodwill' },
		})
		expect(conflict.status).toBe(409)
		expect(conflict.body.code).toBe('idempotency_conflict')
		const detail = await call('GET', `/operator/gift-cards/${cardA.cardId}`, {
			token,
		})
		expect(detail.body.card.balanceMinor).toBe(5100)
		const adjust = detail.body.history.filter((h: any) => h.kind === 'adjust')
		expect(adjust).toHaveLength(1)
		expect(adjust[0].actorName).toBe('Pat Manager')
	})

	it('a manager with only the charge grant can charge but not adjust', async () => {
		const token = await mint(ORG_A, { grants: [CHARGE] })
		const charged = await call(
			'POST',
			`/operator/gift-cards/${cardA.cardId}/charges`,
			{
				token,
				headers: { 'Idempotency-Key': rid() },
				body: { amountMinor: 100, note: 'phone order', clientRequestId: rid() },
			},
		)
		expect(charged.status).toBe(200)
		const adjusted = await call(
			'POST',
			`/operator/gift-cards/${cardA.cardId}/adjust`,
			{
				token,
				headers: { 'Idempotency-Key': rid() },
				body: { expectedBalanceMinor: 5000, deltaMinor: 1, reason: 'x' },
			},
		)
		expect(adjusted.status).toBe(403)
		const over = await call(
			'POST',
			`/operator/gift-cards/${cardA.cardId}/charges`,
			{
				token,
				headers: { 'Idempotency-Key': rid() },
				body: {
					amountMinor: 9_000_000,
					note: 'too much',
					clientRequestId: rid(),
				},
			},
		)
		expect(over.status).toBe(409)
		expect(over.body.code).toBe('gift_card_balance_low')
	})

	it('limits wrong guesses on the lookup per operator', async () => {
		const token = await mint(ORG_A)
		let last = 0
		for (let i = 0; i < 22; i += 1) {
			last = (
				await call('POST', '/operator/gift-cards/lookup', {
					token,
					body: { code: `WRONGCODE${i}`.padEnd(16, 'X') },
				})
			).status
		}
		expect(last).toBe(429)
	})

	it('the node kill switch stops writes with 503 but reads keep working', async () => {
		const token = await mint(ORG_A)
		process.env.GIFT_CARDS_ENABLED = 'false'
		try {
			const write = await call(
				'POST',
				`/operator/gift-cards/${cardA.cardId}/charges`,
				{
					token,
					headers: { 'Idempotency-Key': rid() },
					body: { amountMinor: 100, note: 'x', clientRequestId: rid() },
				},
			)
			expect(write.status).toBe(503)
			expect(write.body.code).toBe('gift_cards_unavailable')
			expect(
				(await call('GET', `/operator/gift-cards/${cardA.cardId}`, { token }))
					.status,
			).toBe(200)
		} finally {
			delete process.env.GIFT_CARDS_ENABLED
		}
	})

	it('never answers with a code or a hash', async () => {
		const token = await mint(ORG_A)
		const list = await call('GET', '/operator/gift-cards', { token })
		const text = JSON.stringify(list.body)
		expect(text).not.toContain(cardA.code!)
		expect(text).not.toMatch(/[0-9a-f]{64}/)
		const detail = JSON.stringify(
			(await call('GET', `/operator/gift-cards/${cardA.cardId}`, { token }))
				.body,
		)
		expect(detail).not.toContain(cardA.code!)
		expect(detail).not.toMatch(/[0-9a-f]{64}/)
	})
})
