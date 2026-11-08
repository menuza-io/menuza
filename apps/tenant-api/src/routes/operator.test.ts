import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	discountIssuedCodes,
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
import { verifyConsentToken } from '../lib/email-consent.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { emailConsentHash } from '../services/marketing-audience.ts'
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
	let readOnlyToken: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-op-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.JWT_SECRET = operatorSecret
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret

		await provisionTenantDb(testOrgId)

		const secret = new TextEncoder().encode(operatorSecret)
		// A token for someone who may update and delete (App mints the claims only
		// for people holding those permissions).
		validToken = await new SignJWT({
			orgId: testOrgId,
			role: 'operator',
			canUpdate: true,
			canDelete: true,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('1h')
			.sign(secret)
		// A read-only member's token: no write claims.
		readOnlyToken = await new SignJWT({ orgId: testOrgId, role: 'operator' })
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

	describe('a token with canUpdate but not canDelete', () => {
		async function updateOnlyToken() {
			return new SignJWT({
				orgId: testOrgId,
				role: 'operator',
				canUpdate: true,
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setAudience('tenant-api-operator')
				.setIssuer(brand.shortName)
				.setExpirationTime('1h')
				.sign(new TextEncoder().encode(operatorSecret))
		}

		it('can update a customer', async () => {
			const db = await getTenantDb(testOrgId)
			const [inserted] = await db
				.insert(customers)
				.values({ name: 'Before', phone: '+15550000012' })
				.returning()
			const token = await updateOnlyToken()

			const res = await app.request(`/operator/customers/${inserted!.id}`, {
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ name: 'After' }),
			})
			expect(res.status).toBe(200)
			const [after] = await db
				.select({ name: customers.name })
				.from(customers)
				.where(eq(customers.id, inserted!.id))
			expect(after?.name).toBe('After')
		})

		it('can create a campaign', async () => {
			const token = await updateOnlyToken()

			const res = await app.request('/operator/marketing/campaigns', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Update-only promo',
					channel: 'email',
					subject: 'Hello',
					content: 'Hi {{customer.name}}!',
					audience: 'verified',
				}),
			})
			expect(res.status).toBe(200)
		})
	})

	describe('a token without write claims (read-only member)', () => {
		it('lists customers but cannot update one', async () => {
			const db = await getTenantDb(testOrgId)
			const [inserted] = await db
				.insert(customers)
				.values({ name: 'Old Name', phone: '+15550000011' })
				.returning()

			const list = await app.request('/operator/customers', {
				headers: { Authorization: `Bearer ${readOnlyToken}` },
			})
			expect(list.status).toBe(200)

			const res = await app.request(`/operator/customers/${inserted!.id}`, {
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${readOnlyToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ name: 'Hijacked' }),
			})
			expect(res.status).toBe(403)
			const [after] = await db
				.select({ name: customers.name })
				.from(customers)
				.where(eq(customers.id, inserted!.id))
			expect(after?.name).toBe('Old Name')
		})

		it('cannot create a campaign', async () => {
			const res = await app.request('/operator/marketing/campaigns', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${readOnlyToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Blast',
					subject: 'Hi',
					content: 'Hello',
					channel: 'email',
				}),
			})
			expect(res.status).toBe(403)
		})
	})

	it('computes marketing metrics via SQL aggregates accurately', async () => {
		const db = await getTenantDb(testOrgId)
		// One message per campaign and customer, so one customer each.
		const people = await db
			.insert(customers)
			.values(
				[20, 21, 22, 23].map((n) => ({
					name: `Metrics User ${n}`,
					phone: `+155500000${n}`,
				})),
			)
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
			{ campaignId: camp!.id, customerId: people[0]!.id, status: 'Sent' },
			{ campaignId: camp!.id, customerId: people[1]!.id, status: 'Opened' },
			{ campaignId: camp!.id, customerId: people[2]!.id, status: 'Clicked' },
			{ campaignId: camp!.id, customerId: people[3]!.id, status: 'Failed' },
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
		const created = await db
			.insert(customers)
			.values([
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
				{
					// Verified but never consented: must not receive the broadcast.
					name: 'No Consent User',
					phone: '+15550000033',
					email: 'noconsent@example.com',
					phoneVerified: true,
				},
				{
					// Verified, consented, then opted out.
					name: 'Opted Out User',
					phone: '+15550000034',
					email: 'optedout@example.com',
					phoneVerified: true,
				},
			])
			.returning()
		const idOf = (name: string) => created.find((c) => c.name === name)!.id
		await db.insert(customerSubscriptions).values([
			...['Verified User', 'Unverified User', 'Opted Out User'].map((name) => {
				const customer = created.find((c) => c.name === name)!
				return {
					customerId: customer.id,
					topic: 'marketing' as const,
					channel: 'email' as const,
					source: 'signup' as const,
					subscribedAt: new Date(),
					confirmedEmailHash: emailConsentHash(customer.email!),
					...(name === 'Opted Out User' ? { unsubscribedAt: new Date() } : {}),
				}
			}),
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
		expect(messages[0]!.customerId).toBe(idOf('Verified User'))
	})

	it('only sends broadcasts to subscribed customers', async () => {
		const db = await getTenantDb(testOrgId)
		const created = await db
			.insert(customers)
			.values([
				{ name: 'Subscribed', email: 'in@example.com' },
				{ name: 'Opted Out', email: 'out@example.com' },
				{ name: 'Never Asked', email: 'never@example.com' },
			])
			.returning()
		const [subscribed, optedOut] = created
		await db.insert(customerSubscriptions).values([
			{
				customerId: subscribed!.id,
				topic: 'marketing',
				channel: 'email',
				source: 'signup',
				subscribedAt: new Date(),
				confirmedEmailHash: emailConsentHash('in@example.com'),
			},
			{
				customerId: optedOut!.id,
				topic: 'marketing',
				channel: 'email',
				source: 'signup',
				subscribedAt: new Date(),
				unsubscribedAt: new Date(),
			},
		])

		const res = await app.request('/operator/marketing/campaigns', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${validToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				name: 'Consent check',
				channel: 'email',
				subject: 'Hello',
				content: 'Hi {{customer.name}}!',
				audience: 'all',
			}),
		})
		expect(res.status).toBe(200)
		const body = await res.json()

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
		expect(messages.map((m) => m.customerId)).toEqual([subscribed!.id])

		// The broadcast carries a signed unsubscribe link and one-click headers.
		const sent = vi
			.mocked(sendTenantEmail)
			.mock.calls.map(([input]) => input)
			.filter((input) => input.to === 'in@example.com')
		expect(sent).toHaveLength(1)
		const headers = sent[0]!.extraHeaders!
		expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
		const url = /^<(.+)>$/.exec(headers['List-Unsubscribe']!)![1]!
		expect(sent[0]!.html).toContain(url)
		expect(sent[0]!.text).toContain(url)
		const token = new URL(url).searchParams.get('token')!
		expect(verifyConsentToken(token, 'unsubscribe')).toMatchObject({
			o: testOrgId,
			c: subscribed!.id,
			t: 'marketing',
		})
	})

	describe('broadcast coupons', () => {
		async function subscribedCustomers(emails: string[]) {
			const db = await getTenantDb(testOrgId)
			const created = await db
				.insert(customers)
				.values(emails.map((email) => ({ name: 'Guest', email })))
				.returning()
			await db.insert(customerSubscriptions).values(
				created.map((customer) => ({
					customerId: customer.id,
					topic: 'marketing',
					channel: 'email' as const,
					source: 'signup',
					subscribedAt: new Date(),
					confirmedEmailHash: emailConsentHash(customer.email!),
				})),
			)
			return created
		}

		function createCampaign(body: Record<string, unknown>) {
			return app.request('/operator/marketing/campaigns', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${validToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Coupon promo',
					channel: 'email',
					subject: 'A treat for you',
					audience: 'all',
					...body,
				}),
			})
		}

		async function waitForCompleted(campaignId: string) {
			const db = await getTenantDb(testOrgId)
			await vi.waitFor(
				async () => {
					const [camp] = await db
						.select()
						.from(marketingCampaigns)
						.where(eq(marketingCampaigns.id, campaignId))
					expect(camp?.status).toBe('Completed')
				},
				{ timeout: 3000, interval: 50 },
			)
		}

		it('sends each recipient their own single-use code', async () => {
			vi.mocked(sendTenantEmail).mockClear()
			const recipients = await subscribedCustomers([
				'a@example.com',
				'b@example.com',
			])
			const res = await createCampaign({
				content: 'Use {{couponCode}} for 10% off.',
				contentHtml: '<p>Use <b>{{couponCode}}</b> for 10% off.</p>',
				discountOffer: {
					mode: 'unique',
					discountId: 'disc_welcome',
					prefix: 'hello',
					validDays: 14,
				},
			})
			expect(res.status).toBe(200)
			const { campaignId } = await res.json()
			await waitForCompleted(campaignId)

			const db = await getTenantDb(testOrgId)
			const issued = await db.select().from(discountIssuedCodes)
			expect(issued).toHaveLength(2)
			expect(new Set(issued.map((row) => row.customerId))).toEqual(
				new Set(recipients.map((customer) => customer.id)),
			)
			for (const row of issued) {
				expect(row).toMatchObject({
					discountId: 'disc_welcome',
					sourceType: 'campaign',
					sourceId: campaignId,
				})
				expect(row.code).toMatch(/^HELLO-[A-HJ-NP-Z2-9]{8}$/)
				expect(row.expiresAt - row.createdAt).toBe(14 * 24 * 60 * 60 * 1000)
			}

			const sent = vi.mocked(sendTenantEmail).mock.calls.map(([input]) => input)
			expect(sent).toHaveLength(2)
			for (const input of sent) {
				const own = issued.find(
					(row) =>
						row.customerId ===
						recipients.find((customer) => customer.email === input.to)?.id,
				)!
				expect(input.text).toContain(`Use ${own.code} for 10% off.`)
				expect(input.html).toContain(`<b>${own.code}</b>`)
			}

			const detail = await app.request(
				`/operator/marketing/campaigns/${campaignId}`,
				{ headers: { Authorization: `Bearer ${validToken}` } },
			)
			expect((await detail.json()).campaign.discountOffer).toMatchObject({
				mode: 'unique',
				discountId: 'disc_welcome',
				prefix: 'HELLO',
			})
		})

		it('sends everyone the same code for a shared coupon', async () => {
			vi.mocked(sendTenantEmail).mockClear()
			await subscribedCustomers(['a@example.com', 'b@example.com'])
			const res = await createCampaign({
				subject: 'Code {{couponCode}} inside',
				content: 'Hello',
				discountOffer: {
					mode: 'shared',
					discountId: 'disc_welcome',
					code: 'save-10',
				},
			})
			expect(res.status).toBe(200)
			await waitForCompleted((await res.json()).campaignId)
			const subjects = vi
				.mocked(sendTenantEmail)
				.mock.calls.map(([input]) => input.subject)
			expect(subjects).toEqual(['Code SAVE-10 inside', 'Code SAVE-10 inside'])
			const db = await getTenantDb(testOrgId)
			expect(await db.select().from(discountIssuedCodes)).toHaveLength(0)
		})

		it('refuses the tag without a coupon, and a coupon without the tag', async () => {
			const withoutOffer = await createCampaign({
				content: 'Use {{couponCode}} today',
			})
			expect(withoutOffer.status).toBe(400)
			const withoutTag = await createCampaign({
				content: 'Nothing to see',
				discountOffer: {
					mode: 'unique',
					discountId: 'disc_welcome',
				},
			})
			expect(withoutTag.status).toBe(400)
			const db = await getTenantDb(testOrgId)
			expect(await db.select().from(marketingCampaigns)).toHaveLength(0)
		})
	})

	it('fails the broadcast fast in production without TENANT_API_URL', async () => {
		const saved = {
			NODE_ENV: process.env.NODE_ENV,
			TENANT_API_URL: process.env.TENANT_API_URL,
		}
		process.env.NODE_ENV = 'production'
		process.env.TENANT_API_URL = ''
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		vi.mocked(sendTenantEmail).mockClear()
		try {
			const db = await getTenantDb(testOrgId)
			const [subscribed] = await db
				.insert(customers)
				.values([{ name: 'Subscribed', email: 'in@example.com' }])
				.returning()
			await db.insert(customerSubscriptions).values({
				customerId: subscribed!.id,
				topic: 'marketing',
				channel: 'email',
				source: 'signup',
				subscribedAt: new Date(),
				confirmedEmailHash: emailConsentHash('in@example.com'),
			})
			const res = await app.request('/operator/marketing/campaigns', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${validToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'No origin',
					channel: 'email',
					subject: 'Hello',
					content: 'Hi',
					audience: 'all',
				}),
			})
			const body = await res.json()
			await vi.waitFor(
				async () => {
					const [camp] = await db
						.select()
						.from(marketingCampaigns)
						.where(eq(marketingCampaigns.id, body.campaignId))
					expect(camp?.status).toBe('Failed')
				},
				{ timeout: 3000, interval: 50 },
			)
			expect(sendTenantEmail).not.toHaveBeenCalled()
			const messages = await db
				.select()
				.from(marketingMessages)
				.where(eq(marketingMessages.campaignId, body.campaignId))
			// Failed fast: nothing was attempted per recipient.
			expect(messages).toEqual([])
			expect(JSON.stringify(log.mock.calls)).not.toContain('in@example.com')
		} finally {
			log.mockRestore()
			process.env.NODE_ENV = saved.NODE_ENV ?? ''
			process.env.TENANT_API_URL = saved.TENANT_API_URL ?? ''
		}
	})
})
