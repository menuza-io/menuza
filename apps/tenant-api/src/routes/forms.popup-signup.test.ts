import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { publicFormRoutes } from './forms.ts'

const orgId = 'clw9x0a12000008l00test81'

vi.mock('../lib/origin.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/origin.ts')>()
	return {
		...actual,
		resolveOrganizationForBrowserAuth: async (origin: string | undefined) =>
			origin === 'https://acme.menuza.test'
				? { id: 'clw9x0a12000008l00test81', slug: 'acme', dataRegion: 'us' }
				: null,
	}
})

describe('POST /forms/popup-signup (#132)', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-popup-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.TURNSTILE_SECRET_KEY = ''
		syncEnvFromProcess()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({})),
		)
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/forms', publicFormRoutes)
	})

	afterEach(async () => {
		vi.unstubAllGlobals()
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function post(body: unknown, origin = 'https://acme.menuza.test') {
		return app.request('/forms/popup-signup', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: origin },
			body: JSON.stringify({ slug: 'acme', ...(body as object) }),
		})
	}
	const subscriptions = async () =>
		(await getTenantDb(orgId)).select().from(customerSubscriptions)

	it('stores an email with consent, pending until its owner confirms', async () => {
		const res = await post({
			popupId: 'pop1',
			channel: 'email',
			contact: 'Sam@Example.com',
			consent: true,
		})
		expect(res.status).toBe(201)
		const db = await getTenantDb(orgId)
		const [customer] = await db.select().from(customers)
		expect(customer).toMatchObject({ email: 'sam@example.com' })
		const [sub] = await subscriptions()
		expect(sub).toMatchObject({
			topic: 'marketing',
			channel: 'email',
			source: 'form',
			consentTextVersion: 'popup:pop1',
		})
		expect(sub!.confirmedEmailHash).toBeNull()
	})

	it('stores a phone number with SMS consent', async () => {
		const res = await post({
			popupId: 'pop1',
			channel: 'phone',
			contact: '(555) 123-4567',
			consent: true,
		})
		expect(res.status).toBe(201)
		const db = await getTenantDb(orgId)
		const [customer] = await db.select().from(customers)
		expect(customer!.phone).toBe('+15551234567')
		expect((await subscriptions())[0]).toMatchObject({ channel: 'sms' })
	})

	it('refuses a signup without explicit consent and stores nothing', async () => {
		for (const consent of [false, undefined, 'yes']) {
			const res = await post({
				popupId: 'pop1',
				channel: 'email',
				contact: 'a@b.co',
				consent,
			})
			expect(res.status).toBe(400)
		}
		const db = await getTenantDb(orgId)
		expect(await db.select().from(customers)).toHaveLength(0)
	})

	it('refuses extra fields and bad contacts', async () => {
		expect(
			(
				await post({
					popupId: 'p',
					channel: 'email',
					contact: 'a@b.co',
					consent: true,
					orders: 1,
				})
			).status,
		).toBe(400)
		expect(
			(
				await post({
					popupId: 'p',
					channel: 'email',
					contact: 'not-an-email',
					consent: true,
				})
			).status,
		).toBe(400)
		expect(
			(
				await post({
					popupId: 'p',
					channel: 'phone',
					contact: '123',
					consent: true,
				})
			).status,
		).toBe(400)
	})

	it('never subscribes or rewrites a customer who verified their phone', async () => {
		const db = await getTenantDb(orgId)
		await db.insert(customers).values({
			name: 'Owner',
			phone: '+15551234567',
			phoneVerified: true,
		})
		const res = await post({
			popupId: 'pop1',
			channel: 'phone',
			contact: '5551234567',
			consent: true,
		})
		expect(res.status).toBe(201)
		expect(await subscriptions()).toHaveLength(0)
		const [row] = await db
			.select()
			.from(customers)
			.where(and(eq(customers.phone, '+15551234567')))
		expect(row!.name).toBe('Owner')
	})

	it('a honeypot answers success and stores nothing; a foreign origin finds no site', async () => {
		const bot = await post({
			popupId: 'p',
			channel: 'email',
			contact: 'a@b.co',
			consent: true,
			website: 'http://spam.example',
		})
		expect(bot.status).toBe(201)
		const other = await post(
			{ popupId: 'p', channel: 'email', contact: 'a@b.co', consent: true },
			'https://evil.example',
		)
		expect(other.status).toBe(404)
		expect(await subscriptions()).toHaveLength(0)
	})
})
