/**
 * #152 in the region: the App's occasion job schedules a broadcast with the
 * internal token; another broadcast within 2 days of the occasion is a conflict
 * and nothing is created.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	destroyTenantDb,
	getTenantDb,
	marketingCampaigns,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { marketingInternalRoutes } from './marketing-internal.ts'

vi.mock('@repo/email', () => ({
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(false),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	findActiveOrganizationById: vi.fn(async (id: string) => ({
		id,
		dataRegion: 'us',
		slug: 'acme',
	})),
}))

const orgId = 'clw9x0a12000008l00occasn01'
const TOKEN = 'test-internal-command-token'
const DAY = 24 * 60 * 60 * 1000
const app = new Hono().route('/api/marketing', marketingInternalRoutes)

function post(body: Record<string, unknown>, authorized = true) {
	return app.request('/api/marketing/campaigns/auto-schedule', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(authorized ? { Authorization: `Bearer ${TOKEN}` } : {}),
		},
		body: JSON.stringify(body),
	})
}

const day = (offset: number) => new Date(Date.now() + offset * DAY)
const body = (overrides: Record<string, unknown> = {}) => ({
	orgId,
	name: "Mother's Day",
	channel: 'email',
	subject: "Mother's Day at Casa Verde",
	content: 'Join us',
	contentHtml: '<p>Join us</p>',
	contentBlocks: '[]',
	scheduledAt: day(7).toISOString(),
	occasionDate: day(14).toISOString().slice(0, 10),
	...overrides,
})

async function existing(
	db: TenantDatabase,
	at: Date,
	status = 'Scheduled' as const,
) {
	await db.insert(marketingCampaigns).values({
		id: randomUUID(),
		name: 'Other',
		channel: 'email',
		subject: 's',
		content: 'c',
		status,
		scheduledAt: at,
		segmentationRules: JSON.stringify({ audience: 'all' }),
	})
}

describe('POST /api/marketing/campaigns/auto-schedule (#152)', () => {
	let tempDir: string
	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-occasion-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.INTERNAL_COMMAND_TOKEN = TOKEN
		await provisionTenantDb(orgId)
	})
	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('needs the internal token', async () => {
		expect((await post(body(), false)).status).toBe(401)
	})

	it('creates a Scheduled broadcast the operator can edit or cancel, and sends nothing', async () => {
		const res = await post(body())
		expect(res.status).toBe(201)
		const { campaignId } = (await res.json()) as { campaignId: string }
		const db = await getTenantDb(orgId)
		const row = await db
			.select()
			.from(marketingCampaigns)
			.where(eq(marketingCampaigns.id, campaignId))
			.get()
		expect(row).toMatchObject({
			status: 'Scheduled',
			channel: 'email',
			name: "Mother's Day",
			contentHtml: '<p>Join us</p>',
		})
		expect(row?.scheduledAt?.getTime()).toBeGreaterThan(Date.now())
		expect(JSON.parse(row!.segmentationRules as string)).toEqual({
			audience: 'all',
		})
	})

	it('is a conflict when another broadcast is scheduled within 2 days of the occasion, and creates nothing', async () => {
		const db = await getTenantDb(orgId)
		await existing(db, day(15))
		const res = await post(body())
		expect(res.status).toBe(409)
		expect(await res.json()).toEqual({ error: 'occasion_conflict' })
		expect(await db.select().from(marketingCampaigns).all()).toHaveLength(1)
	})

	it('is a conflict within 2 days of the planned send too, and a sending broadcast counts', async () => {
		const db = await getTenantDb(orgId)
		await existing(db, day(8.5), 'Processing')
		expect((await post(body())).status).toBe(409)
	})

	it('a broadcast further than 2 days away, or one that is cancelled or finished, is no conflict', async () => {
		const db = await getTenantDb(orgId)
		await existing(db, day(20))
		await existing(db, day(14), 'Cancelled' as never)
		await existing(db, day(14), 'Completed' as never)
		expect((await post(body())).status).toBe(201)
	})

	it('refuses a time in the past, an unknown audience and an unknown field', async () => {
		expect(
			(await post(body({ scheduledAt: day(-1).toISOString() }))).status,
		).toBe(400)
		expect((await post(body({ audienceId: 'nope' }))).status).toBe(404)
		expect((await post(body({ phone: '+15550001111' }))).status).toBe(400)
		const db = await getTenantDb(orgId)
		expect(await db.select().from(marketingCampaigns).all()).toHaveLength(0)
	})
})
