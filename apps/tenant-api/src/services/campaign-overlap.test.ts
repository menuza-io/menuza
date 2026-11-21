/**
 * #393: overlapping broadcasts are counted in the region, as a count and the
 * other broadcast's own title and time; no guest ever leaves it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	marketingCampaigns,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { operatorRoutes } from '../routes/operator.ts'
import { emailConsentHash } from './marketing-audience.ts'
import { findAudienceOverlaps } from './campaign-overlap.ts'

vi.mock('@repo/email', () => ({
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(false),
}))
vi.mock('@repo/sms', () => ({ sendSms: vi.fn() }))

const orgId = 'clw9x0a12000008l00overlap1'
const operatorSecret = 'test-operator-secret-123456789'
const HOUR = 60 * 60 * 1000
const SEND_AT = Date.UTC(2026, 10, 24, 15)

async function emailGuests(db: TenantDatabase, n: number, prefix = 'e') {
	const rows = await db
		.insert(customers)
		.values(
			Array.from({ length: n }, (_, i) => ({
				name: `${prefix}${i}`,
				email: `${prefix}${i}@example.com`,
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
	return rows
}

async function smsGuests(db: TenantDatabase, n: number) {
	const rows = await db
		.insert(customers)
		.values(
			Array.from({ length: n }, (_, i) => ({
				name: `s${i}`,
				phone: `+1555010${String(i).padStart(4, '0')}`,
				phoneVerified: true,
			})),
		)
		.returning()
	await db.insert(customerSubscriptions).values(
		rows.map((c) => ({
			customerId: c.id,
			topic: 'marketing' as const,
			channel: 'sms' as const,
			source: 'signup' as const,
			subscribedAt: new Date(),
		})),
	)
	return rows
}

async function campaign(
	db: TenantDatabase,
	values: Partial<typeof marketingCampaigns.$inferInsert> = {},
) {
	const id = randomUUID()
	await db.insert(marketingCampaigns).values({
		id,
		name: 'Taco Tuesday',
		channel: 'email',
		subject: 'Hi',
		content: 'Hello',
		status: 'Scheduled',
		scheduledAt: new Date(SEND_AT + 2 * HOUR),
		segmentationRules: JSON.stringify({ audience: 'all' }),
		...values,
	})
	return id
}

describe('overlapping broadcasts (#393)', () => {
	let tempDir: string
	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-overlap-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		process.env.JWT_SECRET = operatorSecret
		await provisionTenantDb(orgId)
	})
	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('two campaigns to the same audience in the same window overlap, with the count', async () => {
		const db = await getTenantDb(orgId)
		await emailGuests(db, 12)
		const other = await campaign(db, { name: 'Taco Tuesday' })
		const overlaps = await findAudienceOverlaps(db, {
			channel: 'email',
			audience: 'all',
			sendAtMs: SEND_AT,
		})
		expect(overlaps).toEqual([
			{
				campaignId: other,
				name: 'Taco Tuesday',
				channel: 'email',
				scheduledAt: SEND_AT + 2 * HOUR,
				overlapCount: 12,
				audienceCount: 12,
				otherAudienceCount: 12,
			},
		])
	})

	it('different audiences do not overlap', async () => {
		const db = await getTenantDb(orgId)
		await emailGuests(db, 12)
		await smsGuests(db, 12)
		// An email broadcast and a text broadcast reach different guests here.
		await campaign(db, { channel: 'sms', subject: null })
		expect(
			await findAudienceOverlaps(db, {
				channel: 'email',
				audience: 'all',
				sendAtMs: SEND_AT,
			}),
		).toEqual([])
	})

	it('a few shared guests are not "many"', async () => {
		const db = await getTenantDb(orgId)
		await emailGuests(db, 3)
		await campaign(db)
		expect(
			await findAudienceOverlaps(db, {
				channel: 'email',
				audience: 'all',
				sendAtMs: SEND_AT,
			}),
		).toEqual([])
	})

	it('only broadcasts in the 24-hour window are compared', async () => {
		const db = await getTenantDb(orgId)
		await emailGuests(db, 12)
		await campaign(db, { scheduledAt: new Date(SEND_AT + 3 * 24 * HOUR) })
		expect(
			await findAudienceOverlaps(db, {
				channel: 'email',
				audience: 'all',
				sendAtMs: SEND_AT,
			}),
		).toEqual([])
		const near = await campaign(db, {
			scheduledAt: new Date(SEND_AT - 20 * HOUR),
		})
		expect(
			(
				await findAudienceOverlaps(db, {
					channel: 'email',
					audience: 'all',
					sendAtMs: SEND_AT,
				})
			).map((overlap) => overlap.campaignId),
		).toEqual([near])
	})

	it('cancelled, finished and draft broadcasts do not count, and a broadcast is not compared with itself', async () => {
		const db = await getTenantDb(orgId)
		await emailGuests(db, 12)
		for (const status of [
			'Draft',
			'Cancelled',
			'Completed',
			'Failed',
		] as const) {
			await campaign(db, { status })
		}
		const mine = await campaign(db)
		expect(
			await findAudienceOverlaps(db, {
				channel: 'email',
				audience: 'all',
				sendAtMs: SEND_AT,
				excludeCampaignId: mine,
			}),
		).toEqual([])
	})

	it('a broadcast sending right now overlaps a send now', async () => {
		const db = await getTenantDb(orgId)
		await emailGuests(db, 12)
		const now = Date.now()
		const sending = await campaign(db, {
			status: 'Processing',
			scheduledAt: null,
		})
		const overlaps = await findAudienceOverlaps(db, {
			channel: 'email',
			audience: 'all',
			sendAtMs: now,
			now,
		})
		expect(overlaps).toMatchObject([{ campaignId: sending, scheduledAt: null }])
	})

	describe('the route', () => {
		const app = new Hono().route('/operator', operatorRoutes)
		async function token() {
			return new SignJWT({ orgId, role: 'operator' })
				.setProtectedHeader({ alg: 'HS256' })
				.setAudience('tenant-api-operator')
				.setIssuer(brand.shortName)
				.setExpirationTime('1h')
				.sign(new TextEncoder().encode(operatorSecret))
		}
		async function ask(query: string, authorized = true) {
			return app.request(`/operator/marketing/audience-overlap?${query}`, {
				headers: authorized ? { Authorization: `Bearer ${await token()}` } : {},
			})
		}

		it('answers counts only: no guest id, name, email or number is in the payload', async () => {
			const db = await getTenantDb(orgId)
			const guests = await emailGuests(db, 12)
			await campaign(db)
			const res = await ask(`channel=email&audience=all&sendAt=${SEND_AT}`)
			expect(res.status).toBe(200)
			const text = await res.text()
			const body = JSON.parse(text) as {
				overlaps: Array<Record<string, unknown>>
			}
			expect(body.overlaps).toHaveLength(1)
			expect(body.overlaps[0]).toMatchObject({
				overlapCount: 12,
				name: 'Taco Tuesday',
			})
			for (const guest of guests) {
				expect(text).not.toContain(guest.id)
				expect(text).not.toContain(guest.email!)
				expect(text).not.toContain(guest.name)
			}
		})

		it('needs the operator token and a valid query', async () => {
			expect((await ask('channel=email&sendAt=1', false)).status).toBe(401)
			expect((await ask('channel=fax&sendAt=1')).status).toBe(400)
			expect((await ask('channel=email')).status).toBe(400)
		})
	})
})
