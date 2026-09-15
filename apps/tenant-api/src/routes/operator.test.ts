import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	marketingCampaigns,
	marketingMessages,
	provisionTenantDb,
} from '@repo/tenant-db'
import { brand } from '@repo/config/brand'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operatorRoutes } from './operator.ts'

const testOrgId = 'clw9x0a12000008l00test99'
const operatorSecret = 'test-operator-secret-123456789'

vi.mock('@repo/email', () => ({
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(false),
}))

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

describe('Operator Routes', () => {
	let tempDir: string
	let app: Hono
	let validToken: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-op-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = operatorSecret
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret

		await provisionTenantDb(testOrgId)

		const secret = new TextEncoder().encode(operatorSecret)
		validToken = await new SignJWT({
			orgId: testOrgId,
			role: 'operator',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('1h')
			.sign(secret)

		app = new Hono()
		app.route('/operator', operatorRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(testOrgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('rejects unauthenticated requests', async () => {
		const res = await app.request('/operator/customers')
		expect(res.status).toBe(401)
	})

	it('returns paginated customer list and total count', async () => {
		const db = await getTenantDb(testOrgId)
		await db.insert(customers).values([
			{ name: 'Customer 1', phone: '+15550000001', phoneVerified: true },
			{ name: 'Customer 2', phone: '+15550000002', phoneVerified: false },
			{ name: 'Customer 3', phone: '+15550000003', phoneVerified: true },
		])

		const res = await app.request('/operator/customers?page=1&limit=2', {
			headers: { Authorization: `Bearer ${validToken}` },
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.customers).toHaveLength(2)
		expect(body.total).toBe(3)
		expect(body.page).toBe(1)
		expect(body.limit).toBe(2)
		expect(body.customers[0]).not.toHaveProperty('phoneVerificationCode')
		expect(body.customers[0]).not.toHaveProperty('refreshTokenHash')
		expect(body.customers[0]).not.toHaveProperty('stripeCustomerId')
	})

	it('updates customer name and email', async () => {
		const db = await getTenantDb(testOrgId)
		const [inserted] = await db
			.insert(customers)
			.values({ name: 'Old Name', phone: '+15550000010' })
			.returning()

		const res = await app.request(`/operator/customers/${inserted!.id}`, {
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${validToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				name: 'New Name',
				email: 'customer@example.com',
			}),
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.customer.name).toBe('New Name')
		expect(body.customer.email).toBe('customer@example.com')
		expect(body.customer).not.toHaveProperty('phoneVerificationCode')
		expect(body.customer).not.toHaveProperty('refreshTokenHash')
		expect(body.customer).not.toHaveProperty('stripeCustomerId')
	})

	it('computes marketing metrics via SQL aggregates accurately', async () => {
		const db = await getTenantDb(testOrgId)
		const [cust] = await db
			.insert(customers)
			.values({ name: 'Metrics User', phone: '+15550000020' })
			.returning()

		const [camp] = await db
			.insert(marketingCampaigns)
			.values({
				name: 'Test Campaign',
				channel: 'email',
				content: 'Hello {{customer.name}}',
				status: 'Processing',
			})
			.returning()

		await db.insert(marketingMessages).values([
			{ campaignId: camp!.id, customerId: cust!.id, status: 'Sent' },
			{ campaignId: camp!.id, customerId: cust!.id, status: 'Opened' },
			{ campaignId: camp!.id, customerId: cust!.id, status: 'Clicked' },
			{ campaignId: camp!.id, customerId: cust!.id, status: 'Failed' },
		])

		const res = await app.request('/operator/marketing/metrics', {
			headers: { Authorization: `Bearer ${validToken}` },
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.metrics.emailsSent).toBe(3) // Sent, Opened, Clicked
		expect(body.metrics.activeCampaigns).toBe(1)
		expect(body.metrics.openRate).toBe('66.7') // 2 / 3
		expect(body.metrics.clickRate).toBe('33.3') // 1 / 3
	})

	it('dispatches campaigns and respects segmentation rules', async () => {
		const db = await getTenantDb(testOrgId)
		await db.insert(customers).values([
			{
				name: 'Verified User',
				phone: '+15550000031',
				email: 'verified@example.com',
				phoneVerified: true,
			},
			{
				name: 'Unverified User',
				phone: '+15550000032',
				email: 'unverified@example.com',
				phoneVerified: false,
			},
		])

		// Create campaign targeting only verified users
		const res = await app.request('/operator/marketing/campaigns', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${validToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				name: 'Verified Promo',
				channel: 'email',
				subject: 'Special Offer',
				content: 'Hi {{customer.name}}!',
				audience: 'verified',
			}),
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.success).toBe(true)

		// Wait for background dispatch to finish
		await vi.waitFor(
			async () => {
				const [camp] = await db
					.select()
					.from(marketingCampaigns)
					.where(eq(marketingCampaigns.id, body.campaignId))
				expect(camp?.status).toBe('Completed')
				expect(camp?.targetAudienceCount).toBe(1)
			},
			{ timeout: 3000, interval: 50 },
		)

		const messages = await db
			.select()
			.from(marketingMessages)
			.where(eq(marketingMessages.campaignId, body.campaignId))
		expect(messages).toHaveLength(1)
		expect(messages[0]!.status).toBe('Sent')
	})
})
