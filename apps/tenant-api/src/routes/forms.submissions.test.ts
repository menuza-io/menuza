import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	destroyTenantDb,
	formResponseOutbox,
	getTenantDb,
	provisionTenantDb,
	websiteForms,
	websiteFormSubmissions,
} from '@repo/tenant-db'
import { drainFormResponseOutbox } from '../services/form-response-outbox.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { publicFormRoutes } from './forms.ts'

const orgId = 'clw9x0a12000008l00test78'

vi.mock('../lib/origin.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/origin.ts')>()
	return {
		...actual,
		resolveOrganizationForBrowserAuth: async () => ({
			id: 'clw9x0a12000008l00test78',
			slug: 'acme',
			dataRegion: 'us',
		}),
	}
})

const FORM = {
	id: 'catering',
	name: 'Catering request',
	fields: [
		{ id: 'name', type: 'name', label: 'Name', required: true },
		{
			id: 'fulfilment',
			type: 'single_choice',
			label: 'Delivery or pickup',
			required: true,
			options: ['Delivery', 'Pickup'],
		},
		{
			id: 'address',
			type: 'address',
			label: 'Address',
			required: true,
			showWhen: { fieldId: 'fulfilment', values: ['Delivery'] },
		},
		{
			id: 'branch',
			type: 'location',
			label: 'Branch',
			required: true,
			locationIds: ['loc-a'],
		},
	],
	successMessage: 'Thanks',
}

describe('public form submissions', () => {
	let tempDir: string
	let app: Hono
	const fetchCalls: Array<{ url: string; body: string }> = []

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-forms-sub-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-token-123456789'
		process.env.APP_URL = 'https://app.menuza.test'
		process.env.TURNSTILE_SECRET_KEY = ''
		syncEnvFromProcess()
		fetchCalls.length = 0
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				fetchCalls.push({ url: String(input), body: String(init?.body ?? '') })
				return Response.json({ inApp: 1, emailed: 0 })
			}),
		)
		await provisionTenantDb(orgId)
		const db = await getTenantDb(orgId)
		await db.insert(websiteForms).values(FORM)
		app = new Hono()
		app.route('/forms', publicFormRoutes)
	})

	afterEach(async () => {
		vi.unstubAllGlobals()
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function submit(body: unknown) {
		return app.request('/forms/catering/submissions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Origin: 'https://acme.menuza.test',
			},
			body: JSON.stringify({ slug: 'acme', ...(body as object) }),
		})
	}

	async function stored() {
		const db = await getTenantDb(orgId)
		return db.select().from(websiteFormSubmissions)
	}

	it('stores an address in the region and composes it from its parts', async () => {
		const res = await submit({
			values: {
				name: 'Sam',
				fulfilment: 'Delivery',
				address: { street: '1 Main St', city: 'Riyadh', postcode: '11564' },
				branch: 'loc-a',
			},
			locationLabels: { branch: 'Downtown' },
		})
		expect(res.status).toBe(201)
		const rows = await stored()
		expect(rows).toHaveLength(1)
		expect(rows[0]!.values).toMatchObject({
			address: '1 Main St, Riyadh, 11564',
			branch: 'Downtown',
			'branch:location_id': 'loc-a',
		})
	})

	it('drops a value sent for a hidden field and does not require it', async () => {
		const res = await submit({
			values: {
				name: 'Sam',
				fulfilment: 'Pickup',
				// Hidden for Pickup: required, yet missing is fine; sent is dropped.
				address: { street: 'secret street' },
				branch: 'loc-a',
			},
		})
		expect(res.status).toBe(201)
		const rows = await stored()
		expect(rows[0]!.values).toEqual({
			name: 'Sam',
			fulfilment: 'Pickup',
			branch: 'loc-a',
			'branch:location_id': 'loc-a',
		})
		const noAddress = await submit({
			values: { name: 'Al', fulfilment: 'Pickup', branch: 'loc-a' },
		})
		expect(noAddress.status).toBe(201)
	})

	it('refuses a location outside the chosen list', async () => {
		const res = await submit({
			values: { name: 'Sam', fulfilment: 'Pickup', branch: 'loc-z' },
		})
		expect(res.status).toBe(400)
		expect(await stored()).toHaveLength(0)
	})

	it('keeps operator-only settings out of the public form', async () => {
		const res = await app.request('/forms/catering?slug=acme', {
			headers: { Origin: 'https://acme.menuza.test' },
		})
		const body = (await res.json()) as { form: Record<string, unknown> }
		expect(body.form).not.toHaveProperty('notify')
		expect(body.form).not.toHaveProperty('restricted')
	})

	it('queues one ids-only event per stored response and sends it without values', async () => {
		await submit({
			values: { name: 'Secret Name', fulfilment: 'Pickup', branch: 'loc-a' },
		})
		const db = await getTenantDb(orgId)
		await vi.waitFor(async () => {
			const [done] = await db.select().from(formResponseOutbox)
			expect(done?.status).toBe('sent')
		})
		const rows = await db.select().from(formResponseOutbox)
		expect(rows).toHaveLength(1)
		await db
			.update(formResponseOutbox)
			.set({ status: 'pending', nextAttemptAt: new Date(0) })
			.where(eq(formResponseOutbox.id, rows[0]!.id))
		fetchCalls.length = 0
		const totals = await drainFormResponseOutbox(orgId, { db })
		expect(totals.sent).toBe(1)
		expect(fetchCalls).toHaveLength(1)
		expect(fetchCalls[0]!.url).toBe(
			'https://app.menuza.test/resources/forms/notify',
		)
		expect(fetchCalls[0]!.body).not.toContain('Secret Name')
		expect(fetchCalls[0]!.body).not.toContain('Pickup')
		const event = JSON.parse(fetchCalls[0]!.body) as Record<string, unknown>
		expect(Object.keys(event).sort()).toEqual([
			'at',
			'count',
			'eventId',
			'formId',
			'formName',
			'notify',
			'orgId',
			'restricted',
		])
	})

	it('never notifies for a honeypot, an invalid or a bot-blocked submission', async () => {
		const honeypot = await submit({
			website: 'http://spam.example',
			values: { name: 'Bot' },
		})
		expect(honeypot.status).toBe(201)
		const invalid = await submit({ values: { name: 'Sam' } })
		expect(invalid.status).toBe(400)
		process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA'
		syncEnvFromProcess()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ success: false })),
		)
		const blocked = await submit({
			turnstileToken: 'bad',
			values: { name: 'Sam', fulfilment: 'Pickup', branch: 'loc-a' },
		})
		expect(blocked.status).toBe(403)
		const db = await getTenantDb(orgId)
		expect(await db.select().from(formResponseOutbox)).toHaveLength(0)
		expect(await stored()).toHaveLength(0)
	})

	it('retries a delivery the App could not take, then gives up on a rejection', async () => {
		await submit({
			values: { name: 'Sam', fulfilment: 'Pickup', branch: 'loc-a' },
		})
		const db = await getTenantDb(orgId)
		// The drain started by the submission settles first (the stub answers 200).
		await vi.waitFor(async () => {
			const [done] = await db.select().from(formResponseOutbox)
			expect(done?.status).toBe('sent')
		})
		const [row] = await db.select().from(formResponseOutbox)
		await db
			.update(formResponseOutbox)
			.set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(0) })
			.where(eq(formResponseOutbox.id, row!.id))
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('x', { status: 503 })),
		)
		expect((await drainFormResponseOutbox(orgId, { db })).retry).toBe(1)
		const [retried] = await db.select().from(formResponseOutbox)
		expect(retried!.status).toBe('pending')
		expect(retried!.attempts).toBe(1)
		await db
			.update(formResponseOutbox)
			.set({ nextAttemptAt: new Date(0) })
			.where(eq(formResponseOutbox.id, row!.id))
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('x', { status: 400 })),
		)
		expect((await drainFormResponseOutbox(orgId, { db })).failed).toBe(1)
	})
})
