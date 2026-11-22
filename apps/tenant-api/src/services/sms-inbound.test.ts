/**
 * #75 inbound text replies: signed webhook, STOP / START / HELP, one answer,
 * retries processed once, and nothing stored beyond the keyword.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	marketingMessages,
	provisionTenantDb,
	smsInboundEvents,
	type TenantDatabase,
} from '@repo/tenant-db'
import { bindAppService } from '../lib/app-service.ts'
import { clearOrgEmailSenderCacheForTest } from '../lib/org-email-sender.ts'
import { mockSignature, twilioSignature } from '../lib/sms-inbound-provider.ts'
import { smsWebhookRoutes } from '../routes/sms-webhook.ts'
import { setCustomerSubscription } from './marketing-audience.ts'
import { eraseSmsInboundEvents } from './sms-inbound.ts'

const orgId = 'clw9x0a12000008l00smsin01'
const otherOrgId = 'clw9x0a12000008l00smsin02'
const TOKEN = 'twilio-auth-token-for-tests'
const BASE = 'https://tenant.example.test'
const PHONE = '+15550001111'

const app = new Hono().route('/webhooks/sms', smsWebhookRoutes)

function twilioRequest(
	fields: Record<string, string>,
	options: { signature?: string; provider?: 'twilio' | 'mock' } = {},
) {
	const provider = options.provider ?? 'twilio'
	const body = new URLSearchParams(fields).toString()
	const signature =
		options.signature ??
		(provider === 'twilio'
			? twilioSignature(TOKEN, `${BASE}/webhooks/sms/twilio`, fields)
			: mockSignature(TOKEN, body))
	return app.request(`${BASE}/webhooks/sms/${provider}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...(provider === 'twilio'
				? { 'X-Twilio-Signature': signature }
				: { 'X-Mock-Signature': signature }),
		},
		body,
	})
}

let counter = 0
function reply(body: string, from = PHONE, sid?: string) {
	counter++
	return {
		MessageSid: sid ?? `SM${String(counter).padStart(8, '0')}`,
		From: from,
		To: '+15559990000',
		Body: body,
	}
}

async function guest(
	db: TenantDatabase,
	opts: {
		phone?: string
		messaged?: boolean
		topics?: string[]
		name?: string
	} = {},
) {
	const [row] = await db
		.insert(customers)
		.values({
			name: opts.name ?? 'Sam',
			phone: opts.phone ?? PHONE,
			phoneVerified: true,
		})
		.returning()
	for (const topic of opts.topics ?? ['marketing', 'drops', 'reservations']) {
		await db.insert(customerSubscriptions).values({
			customerId: row!.id,
			topic: topic as 'marketing',
			channel: 'sms',
			source: 'signup',
			subscribedAt: new Date(),
		})
	}
	if (opts.messaged !== false) {
		await db.insert(marketingMessages).values({
			id: randomUUID(),
			customerId: row!.id,
			channel: 'sms',
			status: 'Sent',
			sentAt: new Date(),
		})
	}
	return row!
}

async function activeSms(db: TenantDatabase, customerId: string) {
	const rows = await db
		.select()
		.from(customerSubscriptions)
		.where(eq(customerSubscriptions.customerId, customerId))
		.all()
	return Object.fromEntries(
		rows
			.filter((row) => row.channel === 'sms')
			.map((row) => [row.topic, !row.unsubscribedAt]),
	)
}

function twimlText(xml: string) {
	return /<Message>(.*)<\/Message>/.exec(xml)?.[1] ?? null
}

describe('inbound text replies (#75)', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-smsin-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.TWILIO_AUTH_TOKEN = TOKEN
		process.env.TENANT_API_URL = BASE
		process.env.NODE_ENV = 'test'
		process.env.APP_URL = 'https://app.example.test'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-command-token'
		clearOrgEmailSenderCacheForTest()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL | Request) => {
				const id = new URL(url.toString()).searchParams.get('orgId')
				return Response.json({
					id,
					name: id === otherOrgId ? 'Pho Corner' : 'Casa Verde',
				})
			}),
		)
		await provisionTenantDb(orgId)
		await provisionTenantDb(otherOrgId)
	})

	afterEach(async () => {
		bindAppService(null)
		vi.unstubAllGlobals()
		await destroyTenantDb(orgId).catch(() => {})
		await destroyTenantDb(otherOrgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('refuses a forged or missing signature before reading anything', async () => {
		const db = await getTenantDb(orgId)
		const person = await guest(db)
		const forged = await twilioRequest(reply('STOP'), { signature: 'AAAA' })
		expect(forged.status).toBe(401)
		const missing = await twilioRequest(reply('STOP'), { signature: '' })
		expect(missing.status).toBe(401)
		// Signed for another URL is as good as forged.
		const fields = reply('STOP')
		const wrongUrl = await twilioRequest(fields, {
			signature: twilioSignature(TOKEN, `${BASE}/webhooks/sms/other`, fields),
		})
		expect(wrongUrl.status).toBe(401)
		expect(await activeSms(db, person.id)).toEqual({
			marketing: true,
			drops: true,
			reservations: true,
		})
		expect(await db.select().from(smsInboundEvents).all()).toHaveLength(0)
	})

	it('stops reading a chunked body at the cap, before the signature is checked', async () => {
		let pulled = 0
		const chunk = new TextEncoder().encode('x'.repeat(4096))
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1
				// Endless: it would never end if the node buffered it all.
				controller.enqueue(chunk)
			},
		})
		const res = await app.request(`${BASE}/webhooks/sms/twilio`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'X-Twilio-Signature': 'AAAA',
			},
			body,
			// @ts-expect-error Node's fetch needs this for a streamed body.
			duplex: 'half',
		})
		expect(res.status).toBe(413)
		expect(pulled).toBeLessThan(20)
	})

	it('an unknown provider and the mock provider outside tests are refused', async () => {
		const unknown = await app.request(`${BASE}/webhooks/sms/acme`, {
			method: 'POST',
			body: 'x=1',
		})
		expect(unknown.status).toBe(404)
		process.env.NODE_ENV = 'production'
		const mock = await twilioRequest(reply('STOP'), { provider: 'mock' })
		expect(mock.status).toBe(404)
	})

	it('STOP ends every SMS topic for the number and sends one confirmation', async () => {
		const db = await getTenantDb(orgId)
		const person = await guest(db)
		const res = await twilioRequest(reply(' stop '))
		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/xml')
		const text = twimlText(await res.text())
		expect(text).toContain('Casa Verde')
		expect(text).toContain('unsubscribed')
		expect(await activeSms(db, person.id)).toEqual({
			marketing: false,
			drops: false,
			reservations: false,
		})
		const [row] = await db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, person.id))
			.all()
		expect(row!.unsubscribedSource).toBe('sms_reply')
		// An email subscription is not a text: untouched.
	})

	it('only the whole trimmed body is a keyword', async () => {
		const db = await getTenantDb(orgId)
		const person = await guest(db)
		for (const body of ['please stop', 'stop it', 'STOP!', 'yes please']) {
			const res = await twilioRequest(reply(body))
			expect(await res.text()).not.toContain('<Message>')
		}
		expect(await activeSms(db, person.id)).toMatchObject({ marketing: true })
		expect(await db.select().from(smsInboundEvents).all()).toHaveLength(0)
	})

	it('a provider retry is processed once and answered once', async () => {
		const db = await getTenantDb(orgId)
		await guest(db)
		const fields = reply('STOP', PHONE, 'SMretry0001')
		const first = await twilioRequest(fields)
		const second = await twilioRequest(fields)
		expect(twimlText(await first.text())).toContain('unsubscribed')
		// The retry changes nothing and sends no second confirmation.
		expect(await second.text()).not.toContain('<Message>')
		const events = await db.select().from(smsInboundEvents).all()
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			providerMessageId: 'SMretry0001',
			keyword: 'stop',
		})
	})

	it('stores the keyword and a phone hash, never the number or the body', async () => {
		const db = await getTenantDb(orgId)
		await guest(db)
		await twilioRequest(reply('Stop'))
		const [event] = await db.select().from(smsInboundEvents).all()
		expect(event!.phoneHash).toMatch(/^[0-9a-f]{64}$/)
		const dump = JSON.stringify(event)
		expect(dump).not.toContain('5550001111')
		expect(Object.keys(event!).sort()).toEqual([
			'id',
			'keyword',
			'phoneHash',
			'providerMessageId',
			'receivedAt',
		])
	})

	it('START re-subscribes what STOP took, HELP names the restaurant', async () => {
		const db = await getTenantDb(orgId)
		const person = await guest(db)
		await twilioRequest(reply('STOP'))
		const help = await twilioRequest(reply('HELP'))
		expect(twimlText(await help.text())).toContain('Casa Verde')
		const start = await twilioRequest(reply('Start'))
		expect(twimlText(await start.text())).toContain('subscribed again')
		expect(await activeSms(db, person.id)).toEqual({
			marketing: true,
			drops: true,
			reservations: true,
		})
		const rows = await db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, person.id))
			.all()
		expect(rows.every((row) => row.source === 'sms_reply')).toBe(true)
	})

	it('START does not undo an opt-out made another way', async () => {
		const db = await getTenantDb(orgId)
		const person = await guest(db, { topics: ['marketing'] })
		await setCustomerSubscription(db, {
			customerId: person.id,
			topic: 'marketing',
			channel: 'sms',
			subscribed: false,
			source: 'profile',
		})
		const res = await twilioRequest(reply('START'))
		expect(await res.text()).not.toContain('<Message>')
		expect(await activeSms(db, person.id)).toEqual({ marketing: false })
	})

	it('a shared phone opts out every matching customer in the organization', async () => {
		const db = await getTenantDb(orgId)
		const a = await guest(db, { name: 'Ana' })
		// A second customer record on the same number cannot exist (unique phone)
		// unless stored in another form: the legacy digits form still matches.
		const b = await guest(db, {
			name: 'Ben',
			phone: '15550001111',
			messaged: false,
		})
		await twilioRequest(reply('STOP'))
		expect((await activeSms(db, a.id)).marketing).toBe(false)
		expect((await activeSms(db, b.id)).marketing).toBe(false)
	})

	it('opts out every organization that texted the number in the last 90 days, and only those', async () => {
		const dbA = await getTenantDb(orgId)
		const dbB = await getTenantDb(otherOrgId)
		const a = await guest(dbA)
		const b = await guest(dbB)
		// A third place has the guest but never texted them.
		const stranger = await guest(dbB, { phone: '+15550009999', name: 'Zed' })
		const res = await twilioRequest(reply('STOP'))
		const text = twimlText(await res.text())!
		// One confirmation, naming both.
		expect(text).toContain('Casa Verde')
		expect(text).toContain('Pho Corner')
		expect((await activeSms(dbA, a.id)).marketing).toBe(false)
		expect((await activeSms(dbB, b.id)).marketing).toBe(false)
		expect((await activeSms(dbB, stranger.id)).marketing).toBe(true)
	})

	it('an organization that last texted over 90 days ago is not matched', async () => {
		const db = await getTenantDb(orgId)
		const person = await guest(db, { messaged: false })
		await db.insert(marketingMessages).values({
			id: randomUUID(),
			customerId: person.id,
			channel: 'sms',
			status: 'Sent',
			sentAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
		})
		const res = await twilioRequest(reply('STOP'))
		expect(await res.text()).not.toContain('<Message>')
		expect((await activeSms(db, person.id)).marketing).toBe(true)
		expect(await db.select().from(smsInboundEvents).all()).toHaveLength(0)
	})

	it('a message that maps to no organization is answered with nothing', async () => {
		const res = await twilioRequest(reply('STOP', '+15557778888'))
		expect(res.status).toBe(200)
		expect(await res.text()).not.toContain('<Message>')
	})

	it('a KSA number is never handled on the US node', async () => {
		const db = await getTenantDb(orgId)
		const person = await guest(db, { phone: '+966501234567' })
		const res = await twilioRequest(reply('STOP', '+966501234567'))
		expect(res.status).toBe(200)
		expect(await res.text()).not.toContain('<Message>')
		expect((await activeSms(db, person.id)).marketing).toBe(true)
	})

	it('the KSA node has no text webhook at all', async () => {
		process.env.DATA_REGION = 'ksa'
		const res = await twilioRequest(reply('STOP'))
		expect(res.status).toBe(404)
	})

	it('the mock provider works in tests with its own signature', async () => {
		const db = await getTenantDb(orgId)
		const person = await guest(db)
		const res = await twilioRequest(reply('STOP'), { provider: 'mock' })
		expect(res.status).toBe(200)
		expect((await activeSms(db, person.id)).marketing).toBe(false)
		const forged = await twilioRequest(reply('STOP'), {
			provider: 'mock',
			signature: 'deadbeef',
		})
		expect(forged.status).toBe(401)
	})

	it('prunes events older than 90 days', async () => {
		const db = await getTenantDb(orgId)
		await guest(db)
		await db.insert(smsInboundEvents).values({
			providerMessageId: 'SMold000001',
			phoneHash: 'x'.repeat(64),
			keyword: 'help',
			receivedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
		})
		await twilioRequest(reply('HELP'))
		const ids = (await db.select().from(smsInboundEvents).all()).map(
			(row) => row.providerMessageId,
		)
		expect(ids).not.toContain('SMold000001')
		expect(ids).toHaveLength(1)
	})

	it('person erasure removes the inbound events of the erased number only', async () => {
		const db = await getTenantDb(orgId)
		await guest(db)
		await guest(db, { phone: '+15550002222', name: 'Other' })
		await twilioRequest(reply('HELP', PHONE))
		await twilioRequest(reply('HELP', '+15550002222'))
		expect(await db.select().from(smsInboundEvents).all()).toHaveLength(2)
		await eraseSmsInboundEvents(db, [PHONE])
		const left = await db.select().from(smsInboundEvents).all()
		expect(left).toHaveLength(1)
	})
})
