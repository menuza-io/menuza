import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	customerSubscriptions,
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { loadBroadcastAudience } from '../services/marketing-audience.ts'
import { signConsentToken, unsubscribeUrl } from '../lib/email-consent.ts'
import { RESEND_INTERVAL_MS, subscriptionRoutes } from './subscriptions.ts'

const orgId = 'clw9x0a12000008l00test07'
const jwtSecret = 'test-jwt-secret-123456789'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn().mockResolvedValue({
		id: 'clw9x0a12000008l00test07',
		slug: 'subs-test',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}),
}))

vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

async function tokenFor(customerId: string) {
	return new SignJWT({
		customerId,
		orgId,
		name: 'Sam',
		orgSlug: 'subs-test',
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api')
		.setIssuer(brand.slug)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(jwtSecret))
}

describe('customer subscription routes', () => {
	let app: Hono
	let tempDir: string
	let customerId: string
	let accessToken: string

	const put = (path: string, body: unknown, token = accessToken) =>
		app.request(`/subscriptions/${path}`, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})
	const get = () =>
		app.request('/subscriptions', {
			headers: { Authorization: `Bearer ${accessToken}` },
		})

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-subs-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = jwtSecret
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		vi.mocked(sendTenantEmail).mockClear()
		syncEnvFromProcess()

		await provisionTenantDb(orgId)
		const db = await getTenantDb(orgId)
		const [customer] = await db
			.insert(customers)
			.values({
				name: 'Sam',
				phone: '+15555550111',
				phoneVerified: true,
				email: 'sam@example.com',
			})
			.returning()
		customerId = customer!.id
		accessToken = await tokenFor(customerId)

		app = new Hono()
		app.route('/subscriptions', subscriptionRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	it('requires a signed-in customer', async () => {
		expect((await app.request('/subscriptions')).status).toBe(401)
	})

	it('starts with no consent, opts in, and records the source', async () => {
		await expect((await get()).json()).resolves.toEqual({ subscriptions: [] })
		const res = await put('marketing/email', {
			subscribed: true,
			source: 'signup',
		})
		expect(res.status).toBe(200)
		await expect((await get()).json()).resolves.toEqual({
			subscriptions: [
				{
					topic: 'marketing',
					channel: 'email',
					subscribed: true,
					confirmed: false,
				},
			],
		})
		const db = await getTenantDb(orgId)
		const row = await db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, customerId))
			.get()
		expect(row).toMatchObject({ source: 'signup', unsubscribedAt: null })
	})

	it('keeps the opt-out on record and re-subscribes on the same row', async () => {
		await put('marketing/sms', { subscribed: true })
		await put('marketing/sms', { subscribed: false })
		const db = await getTenantDb(orgId)
		const rows = await db.select().from(customerSubscriptions).all()
		expect(rows).toHaveLength(1)
		expect(rows[0]!.unsubscribedAt).toBeInstanceOf(Date)
		await put('marketing/sms', { subscribed: true, source: 'checkout' })
		const after = await db.select().from(customerSubscriptions).all()
		expect(after).toHaveLength(1)
		expect(after[0]).toMatchObject({ source: 'checkout', unsubscribedAt: null })
	})

	it('refuses an sms subscription for an unverified phone', async () => {
		const db = await getTenantDb(orgId)
		const [unverified] = await db
			.insert(customers)
			.values({ name: '', phone: '+15555550112', phoneVerified: false })
			.returning()
		const res = await put(
			'marketing/sms',
			{ subscribed: true },
			await tokenFor(unverified!.id),
		)
		expect(res.status).toBe(409)
	})

	it('refuses an email subscription without an address', async () => {
		const db = await getTenantDb(orgId)
		const [noEmail] = await db
			.insert(customers)
			.values({ name: '', phone: '+15555550113', phoneVerified: true })
			.returning()
		const res = await put(
			'marketing/email',
			{ subscribed: true },
			await tokenFor(noEmail!.id),
		)
		expect(res.status).toBe(409)
	})

	it('rejects unknown topics, channels and sources', async () => {
		expect((await put('promos/email', { subscribed: true })).status).toBe(404)
		expect((await put('marketing/fax', { subscribed: true })).status).toBe(404)
		expect(
			(await put('marketing/email', { subscribed: true, source: 'popup' }))
				.status,
		).toBe(400)
	})

	it('does not let a customer claim a server-side provenance', async () => {
		for (const source of ['operator', 'import', 'form']) {
			expect(
				(await put('marketing/sms', { subscribed: true, source })).status,
			).toBe(400)
		}
		expect(
			(await put('marketing/sms', { subscribed: true, source: 'checkout' }))
				.status,
		).toBe(200)
	})

	describe('email double opt-in and unsubscribe', () => {
		const confirmLink = () => {
			const text = vi.mocked(sendTenantEmail).mock.calls.at(-1)![0].text
			const url = /(https?:\/\/\S+)/.exec(text)![1]!
			return new URL(url)
		}
		const audience = async () =>
			loadBroadcastAudience(await getTenantDb(orgId), { channel: 'email' })

		it('stays pending, emails a link, and counts only after the owner confirms', async () => {
			const res = await put('marketing/email', { subscribed: true })
			await expect(res.json()).resolves.toMatchObject({ pending: true })
			expect(sendTenantEmail).toHaveBeenCalledTimes(1)
			expect(vi.mocked(sendTenantEmail).mock.calls[0]![0].to).toBe(
				'sam@example.com',
			)
			expect(await audience()).toEqual([])

			const link = confirmLink()
			// A scanner opening the link (GET) confirms nothing.
			expect((await app.request(link.pathname + link.search)).status).toBe(200)
			expect(await audience()).toEqual([])

			const done = await app.request(link.pathname + link.search, {
				method: 'POST',
			})
			expect(done.status).toBe(200)
			expect((await audience()).map((c) => c.id)).toEqual([customerId])
			// Idempotent.
			expect(
				(await app.request(link.pathname + link.search, { method: 'POST' }))
					.status,
			).toBe(200)

			// Asking again while confirmed sends nothing and stays confirmed.
			const again = await put('marketing/email', { subscribed: true })
			await expect(again.json()).resolves.toMatchObject({ pending: false })
			expect(sendTenantEmail).toHaveBeenCalledTimes(1)
			expect(await audience()).toHaveLength(1)
		})

		describe('confirmation delivery', () => {
			const send = vi.mocked(sendTenantEmail)
			const putEmail = async () =>
				(await put('marketing/email', { subscribed: true })).json()
			const backdate = async (ms: number) => {
				const db = await getTenantDb(orgId)
				await db
					.update(customerSubscriptions)
					.set({ updatedAt: new Date(Date.now() - ms) })
			}

			it('reports a sent link', async () => {
				await expect(putEmail()).resolves.toMatchObject({
					pending: true,
					confirmationSent: true,
				})
			})

			it.each([
				[
					'an error result',
					() =>
						send.mockResolvedValueOnce({
							status: 'error',
							error: { message: 'sam@example.com bounced', statusCode: 500 },
						} as never),
				],
				[
					'a skipped send',
					() => send.mockResolvedValueOnce({ status: 'skipped' } as never),
				],
				[
					'a thrown error',
					() => send.mockRejectedValueOnce(new Error('sam@example.com down')),
				],
			])(
				'reports %s, logs no address, and lets the next request resend at once',
				async (_name, arrange) => {
					const log = vi.spyOn(console, 'error').mockImplementation(() => {})
					arrange()
					await expect(putEmail()).resolves.toMatchObject({
						pending: true,
						confirmationSent: false,
					})
					expect(JSON.stringify(log.mock.calls)).not.toContain(
						'sam@example.com',
					)
					expect(log).toHaveBeenCalled()
					log.mockRestore()
					// The failed send did not start the resend wait.
					await expect(putEmail()).resolves.toMatchObject({
						pending: true,
						confirmationSent: true,
					})
					expect(send).toHaveBeenCalledTimes(2)
				},
			)

			it('resends for a pending subscription, at most once per interval', async () => {
				await putEmail()
				const throttled = await putEmail()
				expect(throttled).toMatchObject({
					pending: true,
					confirmationSent: false,
				})
				expect(throttled.retryAfter).toBeGreaterThan(0)
				expect(send).toHaveBeenCalledTimes(1)

				await backdate(RESEND_INTERVAL_MS + 1000)
				await expect(putEmail()).resolves.toMatchObject({
					confirmationSent: true,
				})
				expect(send).toHaveBeenCalledTimes(2)
				// The resend link works.
				const link = confirmLink()
				expect(
					(await app.request(link.pathname + link.search, { method: 'POST' }))
						.status,
				).toBe(200)
				expect(await audience()).toHaveLength(1)
			})

			it('a resend keeps the original source and subscription time', async () => {
				await put('marketing/email', { subscribed: true, source: 'signup' })
				await backdate(RESEND_INTERVAL_MS + 1000)
				await put('marketing/email', { subscribed: true, source: 'checkout' })
				const db = await getTenantDb(orgId)
				const [row] = await db.select().from(customerSubscriptions)
				expect(row!.source).toBe('signup')
			})
		})

		it('rejects forged, tampered, wrong-kind and expired links', async () => {
			await put('marketing/email', { subscribed: true })
			const link = confirmLink()
			const token = link.searchParams.get('token')!
			const post = (route: string, t: string) =>
				app.request(`/subscriptions/${route}?token=${encodeURIComponent(t)}`, {
					method: 'POST',
				})
			expect((await post('confirm', token + 'x')).status).toBe(400)
			expect((await post('confirm', 'junk')).status).toBe(400)
			// A confirm token is not an unsubscribe token, and vice versa.
			expect((await post('unsubscribe', token)).status).toBe(400)
			const expired = signConsentToken({
				k: 'confirm',
				o: orgId,
				c: customerId,
				t: 'marketing',
				e: 'x',
				x: Date.now() - 1000,
			})
			expect((await post('confirm', expired)).status).toBe(400)
			expect(await audience()).toEqual([])
		})

		it('does not confirm an address that changed after the link was sent', async () => {
			await put('marketing/email', { subscribed: true })
			const link = confirmLink()
			const db = await getTenantDb(orgId)
			await db
				.update(customers)
				.set({ email: 'other@example.com' })
				.where(eq(customers.id, customerId))
			const res = await app.request(link.pathname + link.search, {
				method: 'POST',
			})
			expect(res.status).toBe(410)
			expect(await audience()).toEqual([])
		})

		it('unsubscribes with one POST, idempotently, and never for another customer', async () => {
			const db = await getTenantDb(orgId)
			await put('marketing/email', { subscribed: true })
			const link = confirmLink()
			await app.request(link.pathname + link.search, { method: 'POST' })
			expect(await audience()).toHaveLength(1)

			const url = new URL(
				unsubscribeUrl('http://tenant.test', {
					orgId,
					customerId,
					topic: 'marketing',
				}),
			)
			// Opening the link changes nothing; the POST (also the RFC 8058
			// one-click call) does.
			expect((await app.request(url.pathname + url.search)).status).toBe(200)
			expect(await audience()).toHaveLength(1)
			for (let i = 0; i < 2; i++) {
				const res = await app.request(url.pathname + url.search, {
					method: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					body: 'List-Unsubscribe=One-Click',
				})
				expect(res.status).toBe(200)
			}
			expect(await audience()).toEqual([])
			const [row] = await db.select().from(customerSubscriptions).all()
			expect(row!.unsubscribedAt).toBeInstanceOf(Date)
		})
	})
})
