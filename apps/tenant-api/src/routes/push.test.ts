import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customerPushDevices,
	customerPushPreferences,
	customerSubscriptions,
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	pushMessages,
	restaurantOrders,
} from '@repo/tenant-db'
import { payloadHoldsPersonalData } from '@repo/common/push'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCustomerAppInfoCache } from '../lib/customer-app-info.ts'
import { openPushToken } from '../lib/push-seal.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { deliverOrderPushes } from '../services/push-hooks.ts'
import { MockPushProvider, setPushProvider } from '../services/push-provider.ts'
import {
	processPushReceipts,
	pushGate,
	sendPushToCustomer,
} from '../services/push-service.ts'
import { insertOrder } from '../services/loyalty-test-fixture.ts'
import {
	orderMessageBatch,
	queueOrderStatusMessages,
} from '../services/order-messages.ts'
import { erasePerson } from '../services/person-erasure-service.ts'
import { pushRoutes } from './push.ts'

const orgId = 'clw9x0a12000008l00test13'
const jwtSecret = 'test-jwt-secret-123456789'
const SITE = 'https://acme.menuza.test'

const info = vi.hoisted(() => ({
	value: {
		app: {
			id: 'app_1',
			displayName: 'Acme',
			iosBundleId: 'com.acme.app',
			androidPackage: 'com.acme.app',
			stores: {},
			inviteEmail: true,
		},
		push: {
			enabled: true,
			marketing: true,
			credentials: { ios: true, android: true },
		},
	} as unknown,
}))
vi.mock('../lib/customer-app-info.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getCustomerAppInfo: vi.fn(async () => info.value),
}))
vi.mock('../lib/reservations-context.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getReservationsContext: vi.fn(async () => ({
		organization: { siteOrigin: 'https://acme.menuza.test' },
	})),
}))
vi.mock('../lib/origin.ts', () => {
	const organization = {
		id: 'clw9x0a12000008l00test13',
		slug: 'push-test',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}
	return {
		findActiveOrganizationById: vi.fn().mockResolvedValue(organization),
		lookupActiveOrganization: vi
			.fn()
			.mockResolvedValue({ status: 'found', organization }),
	}
})

let app: Hono
let tempDir: string
let provider: MockPushProvider
let aliceId: string
let bobId: string
let alice: string
let bob: string

const ALICE = {
	name: 'Alice Wonderland',
	phone: '+15555550301',
	email: 'alice@example.com',
}
const tokenOf = (n: number) =>
	`ExponentPushToken[device${String(n).padStart(8, '0')}]`

async function jwt(customerId: string) {
	return new SignJWT({
		customerId,
		orgId,
		orgSlug: 'push-test',
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api')
		.setIssuer('menuza')
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(jwtSecret))
}

function call(
	method: string,
	route: string,
	body?: unknown,
	bearer: string | null = alice,
) {
	return app.request(route, {
		method,
		headers: {
			...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

const register = (
	n: number,
	extra: Record<string, unknown> = {},
	bearer: string | null = alice,
) =>
	call(
		'POST',
		'/push/devices',
		{ token: tokenOf(n), platform: 'ios', locale: 'en', ...extra },
		bearer,
	)

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-push-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.JWT_SECRET = jwtSecret
	process.env.AUTH_HMAC_SECRET = 'push-test-hmac-secret-very-long-1234567890'
	// varlock keeps removed keys in its config, so reset to explicit values.
	process.env.PUSH_ENABLED = 'true'
	process.env.PUSH_KSA_APPROVED = 'no'
	syncEnvFromProcess()
	clearCustomerAppInfoCache()
	info.value = {
		app: {
			id: 'app_1',
			displayName: 'Acme',
			iosBundleId: 'com.acme.app',
			androidPackage: 'com.acme.app',
			stores: {},
			inviteEmail: true,
		},
		push: {
			enabled: true,
			marketing: true,
			credentials: { ios: true, android: true },
		},
	}
	provider = new MockPushProvider()
	setPushProvider(provider)
	await provisionTenantDb(orgId)
	const db = await getTenantDb(orgId)
	const [a] = await db
		.insert(customers)
		.values({ ...ALICE, phoneVerified: true })
		.returning()
	const [b] = await db
		.insert(customers)
		.values({ name: 'Bob Builder', phone: '+15555550302', phoneVerified: true })
		.returning()
	aliceId = a!.id
	bobId = b!.id
	alice = await jwt(aliceId)
	bob = await jwt(bobId)
	app = new Hono()
	app.route('/push', pushRoutes)
})

afterEach(async () => {
	setPushProvider(null)
	await destroyTenantDb(orgId)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('gating (#105: flag, kill switch, KSA, credentials)', () => {
	it('answers push_not_enabled while customer_app.push is off', async () => {
		info.value = {
			...(info.value as object),
			push: {
				enabled: false,
				marketing: false,
				credentials: { ios: true, android: true },
			},
		}
		const response = await register(1)
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({ error: 'push_not_enabled' })
		expect((await call('GET', '/push/preferences')).status).toBe(409)
	})

	it('answers push_not_enabled when the app has no credentials for the platform', async () => {
		info.value = {
			...(info.value as object),
			push: {
				enabled: true,
				marketing: true,
				credentials: { ios: false, android: true },
			},
		}
		expect((await register(1)).status).toBe(409)
		expect((await register(2, { platform: 'android' })).status).toBe(201)
	})

	it('has a kill switch: PUSH_ENABLED=false stops registration and sending', async () => {
		process.env.PUSH_ENABLED = 'false'
		expect((await register(1)).status).toBe(409)
		process.env.PUSH_ENABLED = 'true'
		expect((await register(1)).status).toBe(201)
		process.env.PUSH_ENABLED = 'off'
		const db = await getTenantDb(orgId)
		const result = await sendPushToCustomer(db, {
			orgId,
			customerId: aliceId,
			kind: 'booking',
			ref: 'x',
			build: () => null,
		})
		expect(result).toMatchObject({ sent: 0, reason: 'not_enabled' })
	})

	it('stays off on the KSA node until legal approves', async () => {
		try {
			process.env.DATA_REGION = 'ksa'
			// Asked as the KSA node itself: the feature flag alone is not enough there.
			expect(await pushGate(orgId)).toEqual({
				ok: false,
				code: 'push_not_enabled',
			})
			process.env.PUSH_KSA_APPROVED = 'true'
			expect((await pushGate(orgId)).ok).toBe(true)
			process.env.PUSH_KSA_APPROVED = 'no'
			expect((await pushGate(orgId)).ok).toBe(false)
		} finally {
			process.env.DATA_REGION = 'us'
			process.env.PUSH_KSA_APPROVED = 'no'
		}
		expect((await pushGate(orgId)).ok).toBe(true)
	})

	it('needs a customer token and is refused for a bad token body without echoing it', async () => {
		expect((await register(1, {}, null)).status).toBe(401)
		const bad = await call('POST', '/push/devices', {
			token: 'Alice-Wonderland-secret',
			platform: 'ios',
		})
		expect(bad.status).toBe(400)
		const text = await bad.text()
		expect(text).toContain('push_token_invalid')
		expect(text).not.toContain('Wonderland')
	})
})

describe("every push route needs the guest's own token", () => {
	const routes: Array<[string, string, unknown?]> = [
		[
			'POST',
			'/push/devices',
			{ token: 'ExponentPushToken[abcdefghijklmnop]', platform: 'ios' },
		],
		['DELETE', '/push/devices/dev_1'],
		['GET', '/push/preferences'],
		['PUT', '/push/preferences', { orders: false }],
		['POST', '/push/opened', { messageId: 'm1' }],
	]

	it.each(routes)(
		'%s %s refuses no token and a forged one',
		async (method, route, body) => {
			expect((await call(method, route, body, null)).status).toBe(401)
			const forged = await new SignJWT({
				customerId: aliceId,
				orgId,
				orgSlug: 'push-test',
				type: 'access',
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setAudience('tenant-api')
				.setIssuer('menuza')
				.setExpirationTime('15m')
				.sign(new TextEncoder().encode('some-other-secret-123456789'))
			expect((await call(method, route, body, forged)).status).toBe(401)
		},
	)
})

describe('devices', () => {
	it('stores the token sealed, searchable only by its hash, once per phone', async () => {
		const first = await register(1)
		expect(first.status).toBe(201)
		const again = await register(1)
		expect(again.status).toBe(201)
		const db = await getTenantDb(orgId)
		const rows = await db.select().from(customerPushDevices)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.tokenCiphertext).not.toContain('ExponentPushToken')
		expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
		expect(openPushToken(rows[0]!.tokenCiphertext)).toBe(tokenOf(1))
	})

	it('moves a phone to the guest who signs in on it', async () => {
		await register(1)
		await register(1, {}, bob)
		const db = await getTenantDb(orgId)
		const rows = await db.select().from(customerPushDevices)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.customerId).toBe(bobId)
	})

	it('keeps at most 10 devices per customer and drops the oldest', async () => {
		for (let n = 1; n <= 12; n += 1) {
			expect((await register(n)).status).toBe(201)
			await new Promise((resolve) => setTimeout(resolve, 2))
		}
		const db = await getTenantDb(orgId)
		const rows = await db
			.select()
			.from(customerPushDevices)
			.where(eq(customerPushDevices.customerId, aliceId))
		expect(rows).toHaveLength(10)
		const tokens = rows.map((row) => openPushToken(row.tokenCiphertext))
		expect(tokens).not.toContain(tokenOf(1))
		expect(tokens).not.toContain(tokenOf(2))
		expect(tokens).toContain(tokenOf(12))
	})

	it('signing out deletes the device, and only the owner can', async () => {
		const { id } = (await (await register(1)).json()) as { id: string }
		expect(
			(await call('DELETE', `/push/devices/${id}`, undefined, bob)).status,
		).toBe(404)
		expect((await call('DELETE', `/push/devices/${id}`)).status).toBe(204)
		const db = await getTenantDb(orgId)
		expect(await db.select().from(customerPushDevices)).toHaveLength(0)
		expect((await call('DELETE', `/push/devices/${id}`)).status).toBe(404)
	})
})

describe('preferences (#105: categories on by default, marketing opt-in)', () => {
	it('reads service categories on and marketing off', async () => {
		const body = (await (
			await call('GET', '/push/preferences')
		).json()) as Record<string, unknown>
		expect(body).toMatchObject({
			orders: true,
			bookings: true,
			rewards: true,
			marketing: false,
			hasDevice: false,
			marketingAvailable: true,
		})
	})

	it('switches a service category off', async () => {
		const response = await call('PUT', '/push/preferences', { orders: false })
		expect(await response.json()).toMatchObject({
			orders: false,
			bookings: true,
		})
		const db = await getTenantDb(orgId)
		expect(await db.select().from(customerPushPreferences)).toHaveLength(1)
	})

	it('records Offers and news as a push subscription with its source, only with a device', async () => {
		expect(
			(
				await call('PUT', '/push/preferences', {
					marketing: true,
					source: 'app_prompt',
				})
			).status,
		).toBe(409)
		await register(1)
		const response = await call('PUT', '/push/preferences', {
			marketing: true,
			source: 'app_prompt',
		})
		expect(await response.json()).toMatchObject({ marketing: true })
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, aliceId))
		expect(row).toMatchObject({
			topic: 'marketing',
			channel: 'push',
			source: 'app_prompt',
			unsubscribedAt: null,
		})
		const off = await call('PUT', '/push/preferences', { marketing: false })
		expect(await off.json()).toMatchObject({ marketing: false })
		const [after] = await db
			.select()
			.from(customerSubscriptions)
			.where(eq(customerSubscriptions.customerId, aliceId))
		expect(after!.unsubscribedAt).not.toBeNull()
	})

	it('refuses marketing opt-in while marketing.push is off, and refuses the generic route', async () => {
		await register(1)
		info.value = {
			...(info.value as object),
			push: {
				enabled: true,
				marketing: false,
				credentials: { ios: true, android: true },
			},
		}
		expect(
			(await call('PUT', '/push/preferences', { marketing: true })).status,
		).toBe(409)
		info.value = {
			...(info.value as object),
			push: {
				enabled: true,
				marketing: true,
				credentials: { ios: true, android: true },
			},
		}
		const subscriptions = new Hono()
		const { subscriptionRoutes } = await import('./subscriptions.ts')
		subscriptions.route('/subscriptions', subscriptionRoutes)
		const via = await subscriptions.request('/subscriptions/marketing/push', {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${alice}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ subscribed: true }),
		})
		expect(via.status).toBe(409)
	})

	it('refuses unknown keys', async () => {
		expect(
			(await call('PUT', '/push/preferences', { orders: true, name: 'Alice' }))
				.status,
		).toBe(400)
	})
})

describe('sending: once per event, by category, with consent', () => {
	const build = () => () => ({
		title: 'Order A1 is ready',
		body: 'Your order is ready for pickup.',
		data: {
			kind: 'order_status' as const,
			url: `${SITE}/menu/success?order=o1`,
		},
	})

	async function withDevices(...numbers: number[]) {
		for (const n of numbers) await register(n)
		return getTenantDb(orgId)
	}

	it('sends to every device once, and a repeated event sends nothing more', async () => {
		const db = await withDevices(1, 2)
		const send = () =>
			sendPushToCustomer(db, {
				orgId,
				customerId: aliceId,
				kind: 'order_status',
				ref: 'o1:ready',
				category: 'orders',
				build: build(),
			})
		expect(await send()).toMatchObject({ sent: 2 })
		expect(provider.sent).toHaveLength(2)
		expect(await send()).toMatchObject({ sent: 0 })
		expect(provider.sent).toHaveLength(2)
		const rows = await db.select().from(pushMessages)
		expect(rows).toHaveLength(2)
		expect(rows.every((row) => row.status === 'sent' && row.ticketId)).toBe(
			true,
		)
		// A different event is a different push.
		await sendPushToCustomer(db, {
			orgId,
			customerId: aliceId,
			kind: 'order_status',
			ref: 'o1:cancelled',
			category: 'orders',
			build: build(),
		})
		expect(provider.sent).toHaveLength(4)
	})

	it('respects the guest’s switch for the category', async () => {
		const db = await withDevices(1)
		await call('PUT', '/push/preferences', { orders: false })
		const result = await sendPushToCustomer(db, {
			orgId,
			customerId: aliceId,
			kind: 'order_status',
			ref: 'o1:ready',
			category: 'orders',
			build: build(),
		})
		expect(result).toMatchObject({ sent: 0, reason: 'category_off' })
		expect(provider.sent).toHaveLength(0)
	})

	it('sends marketing only to a guest who opted in', async () => {
		const db = await withDevices(1)
		const marketing = () =>
			sendPushToCustomer(db, {
				orgId,
				customerId: aliceId,
				kind: 'marketing',
				ref: 'camp_1',
				campaignId: 'camp_1',
				build: build(),
			})
		expect(await marketing()).toMatchObject({ sent: 0, reason: 'no_consent' })
		await call('PUT', '/push/preferences', {
			marketing: true,
			source: 'profile',
		})
		expect(await marketing()).toMatchObject({ sent: 1 })
	})

	it('deletes a device whose token the service calls invalid', async () => {
		const db = await withDevices(1, 2)
		provider.invalidTokens.add(tokenOf(1))
		await sendPushToCustomer(db, {
			orgId,
			customerId: aliceId,
			kind: 'booking',
			ref: 'b1:confirmation:1',
			category: 'bookings',
			build: build(),
		})
		const rows = await db.select().from(customerPushDevices)
		expect(rows).toHaveLength(1)
		expect(openPushToken(rows[0]!.tokenCiphertext)).toBe(tokenOf(2))
		const log = await db.select().from(pushMessages)
		expect(log.map((row) => row.status).sort()).toEqual([
			'invalid_token',
			'sent',
		])
	})

	it('records a provider failure with a short code and never throws', async () => {
		const db = await withDevices(1)
		provider.failingTokens.add(tokenOf(1))
		const result = await sendPushToCustomer(db, {
			orgId,
			customerId: aliceId,
			kind: 'booking',
			ref: 'b1',
			category: 'bookings',
			build: build(),
		})
		expect(result.sent).toBe(0)
		const [row] = await db.select().from(pushMessages)
		expect(row).toMatchObject({ status: 'failed', errorCode: 'provider_error' })
	})

	it('reads delivery receipts and drops tokens reported invalid later', async () => {
		const db = await withDevices(1, 2)
		await sendPushToCustomer(db, {
			orgId,
			customerId: aliceId,
			kind: 'order_status',
			ref: 'o1:ready',
			category: 'orders',
			build: build(),
		})
		const sent = await db.select().from(pushMessages)
		provider.receiptStatus.set(sent[0]!.ticketId!, 'invalid_token')
		const result = await processPushReceipts(db, Date.now() + 5 * 60_000)
		expect(result).toEqual({ checked: 2, delivered: 1, invalid: 1 })
		expect(await db.select().from(customerPushDevices)).toHaveLength(1)
		const states = (await db.select().from(pushMessages))
			.map((row) => row.status)
			.sort()
		expect(states).toEqual(['delivered', 'invalid_token'])
	})

	it('opens: the app reports a tap on its own message only', async () => {
		const db = await withDevices(1)
		await sendPushToCustomer(db, {
			orgId,
			customerId: aliceId,
			kind: 'order_status',
			ref: 'o1:ready',
			category: 'orders',
			build: build(),
		})
		const [row] = await db.select().from(pushMessages)
		expect(
			(await call('POST', '/push/opened', { messageId: row!.id }, bob)).status,
		).toBe(404)
		expect(
			(await call('POST', '/push/opened', { messageId: row!.id })).status,
		).toBe(204)
		const [after] = await db.select().from(pushMessages)
		expect(after!.openedAt).not.toBeNull()
		// What the phone received carries its own message id for exactly this.
		expect(provider.sent[0]!.payload.data.messageId).toBe(row!.id)
	})
})

describe('order status pushes (#105: once per order and status, only what matters)', () => {
	async function orderFor(
		customerId: string | null,
		overrides: Record<string, unknown> = {},
	) {
		const id = await insertOrder(orgId, {
			customerId,
			status: 'accepted',
			number: 'A12',
			contactName: ALICE.name,
			contactPhone: ALICE.phone,
			deliveryAddress: '12 Rabbit Hole Lane',
			...overrides,
		})
		const db = await getTenantDb(orgId)
		return (
			await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, id))
		)[0]!
	}

	async function change(
		order: Awaited<ReturnType<typeof orderFor>>,
		prev: string,
		next: string,
	) {
		const db = await getTenantDb(orgId)
		const batch = orderMessageBatch()
		await queueOrderStatusMessages(
			db,
			order as never,
			prev as never,
			next as never,
			batch.context(),
		)
		batch.deliver(orgId)
		const { orderMessagesIdle } = await import('../services/order-messages.ts')
		await orderMessagesIdle()
	}

	it('pushes accepted, ready and cancelled to a signed-in guest, opening their order', async () => {
		await register(1)
		const order = await orderFor(aliceId)
		await change(order, 'pending_acceptance', 'accepted')
		await change(order, 'accepted', 'ready')
		await change(order, 'ready', 'cancelled')
		expect(provider.sent.map((d) => d.payload.title)).toEqual([
			'Order A12 accepted',
			'Order A12 is ready',
			'Order A12 was cancelled',
		])
		expect(provider.sent[1]!.payload.data.url).toBe(
			`${SITE}/menu/success?order=${order.id}`,
		)
	})

	it('stays quiet for statuses that do not matter, and for orders with no signed-in guest', async () => {
		await register(1)
		const order = await orderFor(aliceId)
		for (const next of ['payment_review', 'expired', 'preparing', 'completed'])
			await change(order, 'accepted', next)
		const guest = await orderFor(null)
		await change(guest, 'accepted', 'ready')
		expect(provider.sent).toHaveLength(0)
	})

	it('fires once per order and status even if the hook runs twice', async () => {
		await register(1)
		const order = await orderFor(aliceId)
		await change(order, 'accepted', 'ready')
		await change(order, 'accepted', 'ready')
		const db = await getTenantDb(orgId)
		await deliverOrderPushes(orgId, [
			{
				orderId: order.id,
				customerId: aliceId,
				number: 'A12',
				status: 'ready',
				fulfillment: 'pickup',
			},
		])
		expect(provider.sent).toHaveLength(1)
		expect(await db.select().from(pushMessages)).toHaveLength(1)
	})

	it('never carries a name, phone, email or address (tested over the real payloads)', async () => {
		await register(1)
		await call('PUT', '/push/preferences', { marketing: true })
		const order = await orderFor(aliceId, { contactEmail: ALICE.email })
		await change(order, 'pending_acceptance', 'accepted')
		await change(order, 'accepted', 'ready')
		await change(order, 'ready', 'cancelled')
		const db = await getTenantDb(orgId)
		await sendPushToCustomer(db, {
			orgId,
			customerId: aliceId,
			kind: 'marketing',
			ref: 'camp',
			campaignId: 'camp',
			build: ({ locale, siteOrigin }) => ({
				title: 'New dish',
				body: 'Try the lamb',
				data: { kind: 'marketing', url: `${siteOrigin}/menu` },
			}),
		})
		expect(provider.sent.length).toBeGreaterThanOrEqual(4)
		for (const delivery of provider.sent) {
			expect(
				payloadHoldsPersonalData(delivery.payload, [
					ALICE.name,
					'Alice',
					ALICE.phone,
					ALICE.email,
					'12 Rabbit Hole Lane',
				]),
			).toEqual([])
			expect(Object.keys(delivery.payload.data).sort()).toEqual(
				expect.arrayContaining(['kind', 'url']),
			)
		}
	})
})

describe('person erasure (#105)', () => {
	it('removes the guest’s devices, switches and send log', async () => {
		await register(1)
		await call('PUT', '/push/preferences', { orders: false })
		const db = await getTenantDb(orgId)
		await sendPushToCustomer(db, {
			orgId,
			customerId: aliceId,
			kind: 'booking',
			ref: 'b1',
			category: 'bookings',
			build: () => ({
				title: 'Booking confirmed',
				body: 'x',
				data: { kind: 'booking', url: null },
			}),
		})
		expect(await db.select().from(pushMessages)).toHaveLength(1)
		await erasePerson(db, { customerId: aliceId }, { actorId: 'op_1' })
		const stillThere = await db
			.select()
			.from(customerPushDevices)
			.where(eq(customerPushDevices.customerId, aliceId))
		const log = await db
			.select()
			.from(pushMessages)
			.where(eq(pushMessages.customerId, aliceId))
		const prefs = await db
			.select()
			.from(customerPushPreferences)
			.where(eq(customerPushPreferences.customerId, aliceId))
		expect([stillThere.length, log.length, prefs.length]).toEqual([0, 0, 0])
	})
})
