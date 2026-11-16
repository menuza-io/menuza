import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { brand } from '@repo/config/brand'
import { DISCOUNT_TOKEN_AUDIENCE, DISCOUNT_TOKEN_TYP } from '@repo/discounts'
import {
	destroyTenantDb,
	discountIssuedCodes,
	getTenantDb,
	marketingCampaigns,
	marketingJourneys,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operatorDiscountRoutes } from './operator-discounts.ts'

const orgId = 'org_usedin_1'
const otherOrgId = 'org_usedin_2'
const operatorSecret = 'test-operator-token-very-long-and-secure-12345'

async function jwt(id = orgId, secret = operatorSecret) {
	return new SignJWT({
		role: 'operator',
		region: 'us',
		orgId: id,
		scope: 'read',
		grants: ['read:discount:any'],
		locationIds: null,
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: DISCOUNT_TOKEN_TYP })
		.setSubject('user_1')
		.setIssuer(brand.shortName)
		.setAudience(DISCOUNT_TOKEN_AUDIENCE)
		.setIssuedAt()
		.setExpirationTime('10m')
		.sign(new TextEncoder().encode(secret))
}

const shared = (discountId: string) =>
	JSON.stringify({ mode: 'shared', discountId, code: 'SAVE10' })
const unique = (discountId: string) =>
	JSON.stringify({ mode: 'unique', discountId, prefix: 'X', validDays: 30 })

describe('GET /operator/discounts/used-in', () => {
	let directory: string
	let app: Hono
	let db: TenantDatabase

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discounts-used-in-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorSecret)
		await provisionTenantDb(orgId)
		await provisionTenantDb(otherOrgId)
		db = await getTenantDb(orgId)
		app = new Hono()
		app.route('/operator/discounts', operatorDiscountRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		await destroyTenantDb(otherOrgId).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	async function usedIn(discountId: string, token?: string) {
		return app.request(`/operator/discounts/used-in?discountId=${discountId}`, {
			headers: { authorization: `Bearer ${token ?? (await jwt())}` },
		})
	}

	async function broadcast(
		status: 'Draft' | 'Scheduled' | 'Processing' | 'Completed' | 'Cancelled',
		offer: string | null,
		name = 'Lunch',
		scheduledAt: Date | null = null,
		on: TenantDatabase = db,
	) {
		const id = randomUUID()
		await on.insert(marketingCampaigns).values({
			id,
			name,
			status,
			channel: 'email',
			content: 'Code {{couponCode}}',
			discountOffer: offer,
			scheduledAt,
		})
		return id
	}

	async function journey(
		status: 'draft' | 'active' | 'paused' | 'archived',
		discountId: string | null,
		name = 'Welcome',
	) {
		const id = randomUUID()
		const nodes = [
			{ id: 't', type: 'trigger', data: {} },
			{
				id: 'e',
				type: 'action_email',
				data: discountId
					? { discountOffer: JSON.parse(shared(discountId)) }
					: {},
			},
		]
		await db.insert(marketingJourneys).values({
			id,
			name,
			status,
			nodes: nodes as never,
			edges: [] as never,
		})
		return id
	}

	it('lists waiting or sending broadcasts and running automations that offer it', async () => {
		const at = new Date(Date.now() + 3_600_000)
		const scheduled = await broadcast(
			'Scheduled',
			shared('disc_a'),
			'Friday',
			at,
		)
		const sending = await broadcast('Processing', unique('disc_a'), 'Now')
		const running = await journey('active', 'disc_a', 'Win back')

		const res = await usedIn('disc_a')
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			broadcasts: Array<{
				id: string
				name: string
				status: string
				scheduledAt: number | null
			}>
			automations: Array<{ id: string; name: string }>
			issuedCodes: number
		}
		expect(body.broadcasts.map((b) => b.id).sort()).toEqual(
			[scheduled, sending].sort(),
		)
		expect(body.broadcasts.find((b) => b.id === scheduled)).toMatchObject({
			name: 'Friday',
			status: 'Scheduled',
			scheduledAt: Math.floor(at.getTime() / 1000) * 1000,
		})
		expect(
			body.broadcasts.find((b) => b.id === sending)?.scheduledAt,
		).toBeNull()
		expect(body.automations).toEqual([{ id: running, name: 'Win back' }])
		expect(body.issuedCodes).toBe(0)
	})

	it('leaves out what cannot break: drafts, finished, cancelled, paused and other discounts', async () => {
		await broadcast('Draft', shared('disc_a'))
		await broadcast('Completed', shared('disc_a'))
		await broadcast('Cancelled', shared('disc_a'))
		await broadcast('Scheduled', shared('disc_b'), 'Other discount')
		await broadcast('Scheduled', null, 'No coupon')
		await journey('paused', 'disc_a')
		await journey('draft', 'disc_a')
		await journey('archived', 'disc_a')
		await journey('active', 'disc_b')
		await journey('active', null)

		const body = (await (await usedIn('disc_a')).json()) as {
			broadcasts: unknown[]
			automations: unknown[]
		}
		expect(body.broadcasts).toEqual([])
		expect(body.automations).toEqual([])
	})

	it('is not fooled by a discount id that only appears inside other text', async () => {
		await db.insert(marketingCampaigns).values({
			id: randomUUID(),
			name: 'Mentions disc_a in the offer of another discount',
			status: 'Scheduled',
			channel: 'email',
			content: 'x',
			discountOffer: shared('disc_a_longer_id'),
		})
		const body = (await (await usedIn('disc_a')).json()) as {
			broadcasts: unknown[]
		}
		expect(body.broadcasts).toEqual([])
	})

	it('counts single-use codes already sent that still work, and not expired ones', async () => {
		const now = Date.now()
		await db.insert(discountIssuedCodes).values([
			{
				discountId: 'disc_a',
				code: 'A1',
				normalizedCode: 'A1',
				sourceType: 'campaign',
				sourceId: 'c1',
				customerId: 'cu1',
				expiresAt: now + 86_400_000,
			},
			{
				discountId: 'disc_a',
				code: 'A2',
				normalizedCode: 'A2',
				sourceType: 'campaign',
				sourceId: 'c1',
				customerId: 'cu2',
				expiresAt: now + 86_400_000,
			},
			{
				discountId: 'disc_a',
				code: 'A3',
				normalizedCode: 'A3',
				sourceType: 'campaign',
				sourceId: 'c1',
				customerId: 'cu3',
				expiresAt: now - 1000,
			},
			{
				discountId: 'disc_b',
				code: 'B1',
				normalizedCode: 'B1',
				sourceType: 'campaign',
				sourceId: 'c1',
				customerId: 'cu4',
				expiresAt: now + 86_400_000,
			},
		])
		const body = (await (await usedIn('disc_a')).json()) as {
			issuedCodes: number
		}
		expect(body.issuedCodes).toBe(2)
	})

	it('answers ids and names only: no recipient, address, code or customer', async () => {
		await broadcast('Scheduled', shared('disc_a'), 'Friday')
		await journey('active', 'disc_a')
		const text = JSON.stringify(await (await usedIn('disc_a')).json())
		expect(text).not.toContain('SAVE10')
		expect(text).not.toContain('@')
		const body = JSON.parse(text) as {
			broadcasts: Array<Record<string, unknown>>
			automations: Array<Record<string, unknown>>
		}
		expect(Object.keys(body).sort()).toEqual([
			'automations',
			'broadcasts',
			'issuedCodes',
		])
		expect(Object.keys(body.broadcasts[0]!).sort()).toEqual([
			'id',
			'name',
			'scheduledAt',
			'status',
		])
		expect(Object.keys(body.automations[0]!).sort()).toEqual(['id', 'name'])
	})

	it('needs a valid discounts token, and reads only the token’s organization', async () => {
		await broadcast('Scheduled', shared('disc_a'))
		expect(
			(await app.request('/operator/discounts/used-in?discountId=disc_a'))
				.status,
		).toBe(401)
		expect(
			(await usedIn('disc_a', await jwt(orgId, 'wrong-secret-but-long-enough')))
				.status,
		).toBe(401)
		// Another organization's token sees its own (empty) region only.
		const other = await usedIn('disc_a', await jwt(otherOrgId))
		expect(other.status).toBe(200)
		expect(await other.json()).toEqual({
			broadcasts: [],
			automations: [],
			issuedCodes: 0,
		})
	})

	it('refuses a missing or malformed discount id', async () => {
		const token = await jwt()
		for (const query of [
			'',
			'discountId=',
			'discountId=a%20b',
			'discountId=a,b',
		]) {
			const res = await app.request(`/operator/discounts/used-in?${query}`, {
				headers: { authorization: `Bearer ${token}` },
			})
			expect(res.status, query).toBe(400)
		}
	})
})
