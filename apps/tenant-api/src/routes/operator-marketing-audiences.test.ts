import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	marketingCampaigns,
	marketingMessages,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchBroadcast } from '../services/broadcast-dispatch.ts'
import { emailConsentHash } from '../services/marketing-audience.ts'
import { insertOrder } from '../services/loyalty-test-fixture.ts'
import { marketingAudienceRoutes } from './operator-marketing-audiences.ts'
import { operatorRoutes } from './operator.ts'

vi.mock('@repo/email', () => ({
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(false),
}))
vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('../lib/marketing-notify.ts', () => ({
	postMarketingNotify: vi.fn().mockResolvedValue({ status: 'delivered' }),
}))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgId = 'clw9x0a12000008l00audi02'
const secret = 'test-operator-secret-123456789'

function mint(claims: Record<string, unknown> = {}) {
	return new SignJWT({
		orgId,
		role: 'operator',
		area: 'marketing',
		sub: 'user-1',
		canUpdate: true,
		canDelete: true,
		...claims,
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(secret))
}

const definition = {
	match: 'all',
	rules: [{ field: 'orders_count', op: 'gte', value: 1 }],
}

describe('operator marketing audiences routes (#98)', () => {
	let dir: string
	let app: Hono
	let db: TenantDatabase

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-aud-routes-'))
		process.env.TENANT_DB_DIR = dir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.JWT_SECRET = secret
		process.env.TENANT_OPERATOR_TOKEN = secret
		process.env.TENANT_API_URL = 'https://tenant.example.com'
		await provisionTenantDb(orgId)
		db = await getTenantDb(orgId)
		app = new Hono()
		app.route('/operator/marketing/audiences', marketingAudienceRoutes)
		app.route('/operator', operatorRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(dir, { recursive: true, force: true })
	})

	async function call(
		method: string,
		route: string,
		body?: unknown,
		token?: string,
	) {
		return app.request(`/operator/marketing/audiences${route}`, {
			method,
			headers: {
				Authorization: `Bearer ${token ?? (await mint())}`,
				'Content-Type': 'application/json',
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	}

	it('refuses a missing, forged, wrong-area or read-only token', async () => {
		const none = await app.request('/operator/marketing/audiences')
		expect(none.status).toBe(401)
		expect((await call('GET', '', undefined, 'not-a-token')).status).toBe(401)
		for (const area of ['customers', 'automations']) {
			const token = await mint({ area })
			expect((await call('GET', '', undefined, token)).status, area).toBe(401)
		}
		const readOnly = await mint({ canUpdate: false, canDelete: false })
		expect((await call('GET', '', undefined, readOnly)).status).toBe(200)
		expect(
			(await call('POST', '', { name: 'A', definition }, readOnly)).status,
		).toBe(403)
	})

	it('creates, lists with counts, updates, and deletes an audience', async () => {
		const created = await call('POST', '', { name: 'Ordered', definition })
		expect(created.status).toBe(201)
		const { audience } = (await created.json()) as { audience: { id: string } }
		const list = (await (await call('GET', '')).json()) as {
			audiences: Array<{ name: string; counts: { size: number | null } }>
		}
		// Four ready-made audiences plus this one.
		expect(list.audiences).toHaveLength(5)
		expect(
			list.audiences.find((a) => a.name === 'Ordered')?.counts.size,
		).toBeNull()
		const stale = await call('PUT', `/${audience.id}`, {
			name: 'Ordered 2',
			definition,
			expectedVersion: 7,
		})
		expect(stale.status).toBe(409)
		expect(await stale.json()).toEqual({ error: 'audience_version_changed' })
		const ok = await call('PUT', `/${audience.id}`, {
			name: 'Ordered 2',
			definition,
			expectedVersion: 1,
		})
		expect(ok.status).toBe(200)
		expect((await call('DELETE', `/${audience.id}`)).status).toBe(200)
		expect((await call('GET', `/${audience.id}`)).status).toBe(404)
	})

	it('refuses sensitive rules, bad shapes and out-of-scope locations without echoing values', async () => {
		const sensitive = await call('POST', '', {
			name: 'Allergic',
			definition: {
				match: 'all',
				rules: [{ field: 'allergy', value: 'peanut' }],
			},
		})
		expect(sensitive.status).toBe(422)
		const body = await sensitive.text()
		expect(body).toBe(JSON.stringify({ error: 'sensitive_rule_not_allowed' }))
		expect(body).not.toContain('peanut')

		const tooMany = await call('POST', '', {
			name: 'Many',
			definition: {
				match: 'all',
				rules: Array.from({ length: 21 }, () => ({
					field: 'phone_verified',
					value: true,
				})),
			},
		})
		expect(tooMany.status).toBe(400)
		expect(await tooMany.json()).toEqual({ error: 'invalid_audience' })

		const scoped = await mint({ locationIds: ['loc_1'] })
		const outside = await call(
			'POST',
			'/preview',
			{
				definition: {
					match: 'all',
					rules: [{ field: 'orders_count', op: 'gte', value: 1 }],
				},
			},
			scoped,
		)
		expect(outside.status).toBe(403)
		expect(await outside.json()).toEqual({ error: 'location_out_of_scope' })
	})

	it('previews counts only: no guest, and sizes under 5 as null', async () => {
		const [guest] = await db
			.insert(customers)
			.values({
				name: 'Secret Name',
				email: 'secret@example.com',
				phone: '+15550001111',
				phoneVerified: true,
			})
			.returning()
		await insertOrder(orgId, { customerId: guest!.id })
		const res = await call('POST', '/preview', { definition })
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(JSON.parse(text)).toEqual({
			counts: { size: null, email: null, sms: null },
		})
		expect(text).not.toMatch(/Secret|secret@|\+1555/)
	})

	it('a broadcast to a saved audience reaches only consented guests inside it', async () => {
		const rows = await db
			.insert(customers)
			.values(
				Array.from({ length: 4 }, (_, i) => ({
					name: `G${i}`,
					email: `g${i}@example.com`,
				})),
			)
			.returning()
		await db.insert(customerSubscriptions).values(
			rows.map((c) => ({
				customerId: c.id,
				topic: 'marketing' as const,
				channel: 'email' as const,
				source: 'signup' as const,
				subscribedAt: new Date(),
				confirmedEmailHash: emailConsentHash(c.email!),
			})),
		)
		// Two guests ordered; one of them has no subscription row at all.
		await insertOrder(orgId, { customerId: rows[0]!.id })
		await insertOrder(orgId, { customerId: rows[1]!.id })
		const [noConsent] = await db
			.insert(customers)
			.values({ name: 'Ordered no consent', email: 'nc@example.com' })
			.returning()
		await insertOrder(orgId, { customerId: noConsent!.id })

		const created = await call('POST', '', { name: 'Ordered', definition })
		const { audience } = (await created.json()) as { audience: { id: string } }
		const make = await app.request('/operator/marketing/campaigns', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${await mint()}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				name: 'Saved audience send',
				channel: 'email',
				subject: 'Hi',
				content: 'Hello {{name}}',
				audienceId: audience.id,
				saveAsDraft: true,
			}),
		})
		expect(make.status).toBe(200)
		const { campaignId } = (await make.json()) as { campaignId: string }
		const stored = await db
			.select()
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, campaignId))
			.get()
		expect(JSON.stringify(stored!.segmentationRules)).toContain(audience.id)

		const lease = new Date()
		await db
			.update(marketingCampaigns)
			.set({ status: 'Processing', updatedAt: lease })
			.where(eq(marketingCampaigns.id, campaignId))
		const outcome = await dispatchBroadcast(orgId, campaignId, lease)
		expect(outcome).not.toBe('failed')
		const sent = await db
			.select({ customerId: marketingMessages.customerId })
			.from(marketingMessages)
			.where(eq(marketingMessages.campaignId, campaignId))
			.all()
		expect(sent.map((m) => m.customerId).sort()).toEqual(
			[rows[0]!.id, rows[1]!.id].sort(),
		)

		// Deleting the audience while a broadcast is not finished is refused; once
		// it finished, the saved audience can go, and a stale send then fails.
		const completed = await db
			.select({ status: marketingCampaigns.status })
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, campaignId))
			.get()
		expect(completed?.status).toBe('Completed')
	})
})
