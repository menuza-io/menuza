import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTenantApiApp } from '../app.ts'
import { resetRateLimits } from '../lib/rate-limit.ts'
import { readRedemptionInTx } from '../services/loyalty-redemption-service.ts'
import {
	activateProgram,
	givePoints,
	insertCustomer,
	makeMember,
	makeReward,
	NOW,
	reserveReward,
} from '../services/loyalty-test-fixture.ts'
import { loyaltyTickRoutes } from './loyalty-tick.ts'

const INTERNAL_TOKEN = 'test-internal-token-very-long-and-secure-12345'
const OPERATOR_TOKEN = 'test-operator-token-very-long-and-secure-12345'
const VOICE_TOKEN = 'test-voice-agent-token-very-long-and-secure-123'
const ORG_A = 'org_ll_route_a'
const ORG_B = 'org_ll_route_b'

let directory: string
let app: ReturnType<typeof createTenantApiApp>
let ipCounter = 0

function post(
	body: unknown,
	options: { token?: string | null; raw?: string; authorization?: string } = {},
) {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'x-forwarded-for': `10.9.0.${++ipCounter}`,
	}
	const token = options.token === undefined ? INTERNAL_TOKEN : options.token
	if (options.authorization) headers.Authorization = options.authorization
	else if (token) headers.Authorization = `Bearer ${token}`
	return app.request('/api/loyalty/tick', {
		method: 'POST',
		headers,
		body: options.raw ?? JSON.stringify(body),
	})
}

/** Org A: an active program with one expired hold waiting for the tick. */
async function seedExpiredHold(orgId: string) {
	await activateProgram(orgId)
	const customerId = `cus_${orgId}`
	await insertCustomer(orgId, { id: customerId })
	const memberId = await makeMember(orgId, { customerId })
	await givePoints(orgId, memberId, 10)
	const reward = await makeReward(orgId)
	return reserveReward(orgId, { memberId, rewardId: reward.id })
}

async function redemptionState(orgId: string, redemptionId: string) {
	const db = await getTenantDb(orgId)
	return (await readRedemptionInTx(db, redemptionId))!.state
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-tick-route-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', INTERNAL_TOKEN)
	vi.stubEnv('TENANT_OPERATOR_TOKEN', OPERATOR_TOKEN)
	vi.stubEnv('VOICE_AGENT_TOKEN', VOICE_TOKEN)
	vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	vi.stubEnv('APP_URL', '')
	resetRateLimits()
	await provisionTenantDb(ORG_A)
	await provisionTenantDb(ORG_B)
	app = createTenantApiApp()
})

afterEach(async () => {
	for (const id of [ORG_A, ORG_B]) {
		await destroyTenantDb(id).catch(() => {})
	}
	fs.rmSync(directory, { recursive: true, force: true })
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe('POST /api/loyalty/tick authentication', () => {
	it('refuses a request with no token, a wrong token, or a malformed header', async () => {
		for (const options of [
			{ token: null },
			{ token: 'wrong-token-wrong-token-wrong-token' },
			{ token: INTERNAL_TOKEN.replace(/.$/, 'X') },
			{ authorization: `Basic ${INTERNAL_TOKEN}` },
			{ authorization: INTERNAL_TOKEN },
			{ authorization: 'Bearer ' },
			{ authorization: `bearer ${INTERNAL_TOKEN}` },
		]) {
			const response = await post({ orgId: ORG_A }, options)
			expect(response.status).toBe(401)
			expect(await response.json()).toEqual({ error: 'unauthorized' })
		}
	})

	it('never accepts an operator, voice agent or customer credential', async () => {
		for (const token of [
			OPERATOR_TOKEN,
			VOICE_TOKEN,
			'test-jwt-secret-123456789',
		]) {
			expect((await post({ orgId: ORG_A }, { token })).status).toBe(401)
		}
	})

	it('checks the token before the body', async () => {
		const response = await post({ orgId: '../etc' }, { token: null })
		expect(response.status).toBe(401)
	})

	it('answers 503 when the internal token is not configured or too short', async () => {
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'short')
		const short = await post({ orgId: ORG_A }, { token: 'short' })
		expect(short.status).toBe(503)
		expect(await short.json()).toEqual({ error: 'service_unavailable' })

		vi.stubEnv('INTERNAL_COMMAND_TOKEN', '')
		expect((await post({}, { token: null })).status).toBe(503)
		// The 503 comes before the body is even read.
		expect((await post({ orgId: '../etc' }, { token: 'short' })).status).toBe(
			503,
		)
	})

	it('marks refusals and answers uncacheable', async () => {
		const unauthorized = await post({}, { token: null })
		expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store')
		const invalid = await post({ orgId: '../etc' })
		expect(invalid.headers.get('Cache-Control')).toBe('private, no-store')
		const ok = await post({ orgId: ORG_A })
		expect(ok.headers.get('Cache-Control')).toBe('private, no-store')
	})

	it('is a POST route only, and only at /tick', async () => {
		const headers = { Authorization: `Bearer ${INTERNAL_TOKEN}` }
		for (const method of ['GET', 'PUT', 'DELETE']) {
			const response = await app.request('/api/loyalty/tick', {
				method,
				headers,
			})
			expect(response.status).toBe(404)
		}
		const elsewhere = await app.request('/api/loyalty/ticks', {
			method: 'POST',
			headers,
			body: '{}',
		})
		expect(elsewhere.status).toBe(404)
	})

	it('limits a caller to sixty requests a minute in production', async () => {
		vi.stubEnv('NODE_ENV', 'production')
		const bare = new Hono()
		bare.route('/api/loyalty', loyaltyTickRoutes)
		const send = (ip: string) =>
			bare.request('/api/loyalty/tick', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
				body: '{}',
			})
		for (let i = 0; i < 60; i++) {
			expect((await send('203.0.113.9')).status).toBe(401)
		}
		expect((await send('203.0.113.9')).status).toBe(429)
		expect((await send('203.0.113.10')).status).toBe(401)
	})
})

describe('POST /api/loyalty/tick body', () => {
	it.each([
		['a malformed org id', { orgId: '../etc/passwd' }],
		['an empty org id', { orgId: '' }],
		['an unknown key', { orgId: ORG_A, force: true }],
		['an unknown key without an org id', { force: true }],
		['a non-string org id', { orgId: 42 }],
		['a null org id', { orgId: null }],
		['an array org id', { orgId: [ORG_A] }],
		['an array body', [ORG_A]],
		['a string body', 'everyone'],
	])('rejects %s', async (_label, body) => {
		const response = await post(body)
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ error: 'validation_error' })
	})

	it('runs nothing for a rejected body', async () => {
		const redemption = await seedExpiredHold(ORG_A)
		await post({ orgId: ORG_A, force: true })
		expect(await redemptionState(ORG_A, redemption.id)).toBe('reserved')
	})
})

describe('POST /api/loyalty/tick for one organization', () => {
	it('runs that organization and answers counts only', async () => {
		const redemption = await seedExpiredHold(ORG_A)
		const response = await post({ orgId: ORG_A })
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body.success).toBe(true)
		expect(body.result).toMatchObject({
			holdsReleased: 1,
			approvalsExpired: 0,
			outboxProcessed: 0,
			outboxFailed: 0,
			outboxParked: 0,
			outboxParkedTotal: 0,
			uploadsMissing: 0,
			uploadsMissingTotal: 0,
		})
		expect(await redemptionState(ORG_A, redemption.id)).toBe('released')
	})

	it('an organization with no loyalty program is a zero tick', async () => {
		const body = await (await post({ orgId: ORG_B })).json()
		expect(body).toMatchObject({
			success: true,
			result: {
				holdsReleased: 0,
				needsFollowUp: false,
				nextDueAt: null,
			},
		})
	})
})

describe('POST /api/loyalty/tick for every organization', () => {
	it('fans out over the node and folds the answers into counts', async () => {
		await seedExpiredHold(ORG_A)
		const response = await post({})
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body).toMatchObject({
			success: true,
			orgs: 2,
			errors: 0,
			orgsDeferred: 0,
			holdsReleased: 1,
			approvalsExpired: 0,
			uploadsMissing: 0,
			uploadsMissingTotal: 0,
		})
	})

	it('treats an empty or null body like "everyone"', async () => {
		await seedExpiredHold(ORG_A)
		const empty = await (await post(null, { raw: '' })).json()
		expect(empty.orgs).toBe(2)
		expect(empty.holdsReleased).toBe(1)
		await seedExpiredHold(ORG_B)
		const nullBody = await (await post(null)).json()
		expect(nullBody.holdsReleased).toBe(1)
	})

	it('counts an organization whose pass throws as an error and keeps going', async () => {
		await seedExpiredHold(ORG_A)
		// A corrupt database file still lists as an organization on this node.
		fs.writeFileSync(path.join(directory, 'tenant_org_ll_route_bad.db'), 'junk')
		const response = await post({})
		expect(response.status).toBe(200)
		const body = await response.json()
		expect(body).toMatchObject({ success: false, errors: 1, holdsReleased: 1 })
		expect(JSON.stringify(body)).not.toContain('junk')
		await destroyTenantDb('org_ll_route_bad').catch(() => {})
	})
})
