import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customerPaymentMethods,
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	shopOrders,
} from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shopRoutes } from './shop.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'

const orgId = 'clw9x0a12000008l00test05'
const jwtSecret = 'test-jwt-secret-123456789'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn().mockResolvedValue({
		id: 'clw9x0a12000008l00test05',
		slug: 'shop-test',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}),
}))

describe('tenant shop routes', () => {
	let app: Hono
	let tempDir: string
	let accessToken: string
	let customerId: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-shop-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = jwtSecret
		syncEnvFromProcess()

		await provisionTenantDb(orgId)
		const db = await getTenantDb(orgId)
		const [customer] = await db
			.insert(customers)
			.values({
				name: 'Shop Customer',
				phone: '+15555550101',
				phoneVerified: true,
			})
			.returning()
		customerId = customer!.id

		accessToken = await new SignJWT({
			customerId,
			orgId,
			name: customer!.name,
			orgSlug: 'shop-test',
			type: 'access',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api')
			.setIssuer('menuza')
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode(jwtSecret))

		app = new Hono()
		app.route('/shop', shopRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	it('rejects unauthenticated customer requests', async () => {
		const response = await app.request('/shop/orders')
		expect(response.status).toBe(401)
	})

	it('returns only the authenticated customer’s orders', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(shopOrders).values({
			customerId,
			productName: 'Starter pack',
			amountCents: 1999,
			platformFeeCents: 200,
			orgPayoutCents: 1799,
			status: 'paid',
			stripePaymentIntentId: 'pi_customer_order',
		})
		const [otherCustomer] = await db
			.insert(customers)
			.values({ name: 'Other Customer', phone: '+15555550102' })
			.returning()
		await db.insert(shopOrders).values({
			customerId: otherCustomer!.id,
			productName: 'Private order',
			amountCents: 5000,
			platformFeeCents: 500,
			orgPayoutCents: 4500,
			status: 'paid',
			stripePaymentIntentId: 'pi_other_order',
		})

		const response = await app.request('/shop/orders', {
			headers: { Authorization: `Bearer ${accessToken}` },
		})

		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({
			orders: [
				expect.objectContaining({
					productName: 'Starter pack',
					amount: '$19.99',
					status: 'paid',
				}),
			],
		})
	})

	it('returns the authenticated customer’s saved payment methods', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customerPaymentMethods).values({
			customerId,
			stripePaymentMethodId: 'pm_123',
			brand: 'visa',
			last4: '4242',
			expMonth: 5,
			expYear: 2030,
		})

		const response = await app.request('/shop/payment-methods', {
			headers: { Authorization: `Bearer ${accessToken}` },
		})

		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({
			paymentMethods: [
				expect.objectContaining({
					id: expect.any(String),
					label: 'visa •••• 4242',
					expires: '05/30',
				}),
			],
		})
	})
})
