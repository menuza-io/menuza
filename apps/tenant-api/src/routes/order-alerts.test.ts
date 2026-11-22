import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import { type OrdersAlertSettings } from '@repo/common/operator-alerts'
import {
	destroyTenantDb,
	getTenantDb,
	orderAlerts,
	posDevices,
	provisionTenantDb,
	restaurantOrders,
	runTenantTransaction,
	type RestaurantOrder,
} from '@repo/tenant-db'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { clearOrdersAlertSettingsCache } from '../lib/orders-alerts.ts'
import { insertOrder } from '../services/loyalty-test-fixture.ts'
import {
	deliverOrderAlerts,
	postQueuedPlacedAlerts,
	queueOrderPlacedAlert,
	runOrderAlertsTickForOrg,
} from '../services/order-alerts.ts'
import { operatorPosRoutes } from './operator-pos.ts'
import { posRoutes } from './pos.ts'

/**
 * Manager alerts about orders and tablets (#131, #241, #300, #190), region side:
 * the events this node posts to the App, when, how often and with what in them.
 * The App is the one boundary replaced (a recording `fetch`); the database, the
 * tick and the heartbeat route are real.
 */

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

const ORG = 'org_alerts_a'
const OTHER = 'org_alerts_b'
const LOC = 'loc-1'
const OPERATOR_TOKEN = 'test-operator-token-very-long-and-secure-12345'
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)
const MIN = 60_000
const DAY = 24 * 60 * MIN

const GUEST = [
	'Layla Hassan',
	'+966501234567',
	'layla@example.com',
	'Olaya Street',
]

const org = (id: string) => ({
	id,
	slug: id,
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'ksa',
})

function settingsFor(
	patch: Partial<OrdersAlertSettings['locations'][number]> = {},
	enabled = true,
): OrdersAlertSettings {
	return {
		enabled,
		locations: [
			{
				id: LOC,
				waitingMinutes: 10,
				// Open all day, yesterday to tomorrow.
				openIntervals: [{ startMs: NOW - DAY, endMs: NOW + DAY }],
				largeOrder: null,
				...patch,
			},
		],
	}
}

describe('order and tablet alerts (region)', () => {
	let directory: string
	let app: Hono
	const posted: Array<Record<string, unknown>> = []
	let settings: OrdersAlertSettings | null
	let notifyStatus = 200

	const mint = (scope = 'orders:read') =>
		new SignJWT({ orgId: ORG, role: 'operator', scope })
			.setSubject('user_manager_1')
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode(OPERATOR_TOKEN))

	async function pair(label: string, locationId: string | null = LOC) {
		const writer = await mint('orders:write')
		const created = await app.request('/operator/pos/pairing-codes', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${writer}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				label,
				terminalCode: label.slice(0, 4),
				locationId,
			}),
		})
		const { code } = (await created.json()) as { code: string }
		const paired = await app.request('/pos/pair', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code }),
		})
		return (await paired.json()) as {
			deviceSecret: string
			device: { id: string }
		}
	}

	const heartbeat = (secret: string, body: unknown = {}) =>
		app.request('/pos/heartbeat', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${secret}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		})

	const tick = async (now = NOW) => {
		const db = await getTenantDb(ORG)
		return runOrderAlertsTickForOrg(ORG, { now, db })
	}

	async function waiting(
		minutesAgo: number,
		overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		return insertOrder(ORG, {
			status: 'accepted',
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			locationId: LOC,
			contactName: 'Layla Hassan',
			contactPhone: '+966501234567',
			contactEmail: 'layla@example.com',
			deliveryAddress: 'Olaya Street',
			createdAt: new Date(NOW - minutesAgo * MIN),
			paidAt: null,
			completedAt: null,
			...overrides,
		})
	}

	const events = (kind: string) => posted.filter((event) => event.kind === kind)

	async function setDevice(
		id: string,
		patch: Partial<typeof posDevices.$inferInsert>,
	) {
		const db = await getTenantDb(ORG)
		await db.update(posDevices).set(patch).where(eq(posDevices.id, id))
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-alerts-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'ksa')
		vi.stubEnv('APP_URL', 'https://app.example.test')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'test-internal-token-very-long-12345')
		vi.stubEnv('TENANT_OPERATOR_TOKEN', OPERATOR_TOKEN)
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('POS_ENABLED', '')
		vi.stubEnv('ORDERS_ALERTS_ENABLED', '')
		posted.length = 0
		notifyStatus = 200
		settings = settingsFor()
		clearOrdersAlertSettingsCache()
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				if (String(url).includes('/resources/orders/alert-settings')) {
					return settings
						? Response.json(settings)
						: new Response('down', { status: 503 })
				}
				if (String(url).includes('/resources/orders/notify')) {
					posted.push(JSON.parse(String(init?.body)))
					return notifyStatus === 200
						? Response.json({ inApp: 1, emailed: 0, pushed: 0, texted: 0 })
						: new Response('no', { status: notifyStatus })
				}
				return new Response('down', { status: 503 })
			}),
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === ORG || id === OTHER ? (org(id) as never) : null,
		)
		await provisionTenantDb(ORG)
		await provisionTenantDb(OTHER)
		app = new Hono()
		app.route('/pos', posRoutes)
		app.route('/operator/pos', operatorPosRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(ORG)
			await destroyTenantDb(OTHER)
		} finally {
			fs.rmSync(directory, { recursive: true, force: true })
			vi.unstubAllEnvs()
			vi.unstubAllGlobals()
			vi.clearAllMocks()
		}
	})

	describe('an order left New (#131)', () => {
		it('sends one alert for an order left New for 10 minutes, naming its number and no guest', async () => {
			await waiting(11)
			const result = await tick()
			expect(result.waiting).toBe(1)
			const [event] = events('orders_waiting')
			expect(event).toMatchObject({
				kind: 'orders_waiting',
				orgId: ORG,
				locationId: LOC,
				orderNumbers: [expect.stringMatching(/^N-\d+$/)],
			})
			for (const guest of GUEST)
				expect(JSON.stringify(posted)).not.toContain(guest)
			// And only once, however often the tick runs.
			await tick(NOW + 5 * MIN)
			await tick(NOW + 30 * MIN)
			expect(events('orders_waiting')).toHaveLength(1)
		})

		it('is quiet for an order under the limit, and says when it will cross it', async () => {
			await waiting(9)
			const result = await tick()
			expect(events('orders_waiting')).toHaveLength(0)
			expect(result.nextDueAt).toBe(NOW + 1 * MIN)
		})

		it('counts a paid online order from when it was paid, not when it was placed', async () => {
			await waiting(30, {
				paymentMethod: 'online',
				paymentStatus: 'paid',
				paidAt: new Date(NOW - 2 * MIN),
			})
			await tick()
			expect(events('orders_waiting')).toHaveLength(0)
			await tick(NOW + 9 * MIN)
			expect(events('orders_waiting')).toHaveLength(1)
		})

		it('ignores orders that are not New, not online, not paid or scheduled for later', async () => {
			await waiting(30, { status: 'preparing' })
			await waiting(30, { status: 'completed' })
			await waiting(30, { status: 'cancelled' })
			await waiting(30, { fulfillment: 'dine_in' })
			await waiting(30, { tabId: 'tab-1' })
			await waiting(30, { paymentMethod: 'online', paymentStatus: 'pending' })
			await waiting(30, { scheduledFor: new Date(NOW + 3 * 60 * MIN) })
			await tick()
			expect(events('orders_waiting')).toHaveLength(0)
		})

		it('counts an order waiting for acceptance as New', async () => {
			await waiting(15, { status: 'pending_acceptance' })
			await tick()
			expect(events('orders_waiting')).toHaveLength(1)
		})

		it('makes one alert of several orders waiting within five minutes of each other', async () => {
			await waiting(9.5 * 1)
			await waiting(10.5)
			await waiting(12)
			await tick()
			const waitingEvents = events('orders_waiting')
			expect(waitingEvents).toHaveLength(1)
			expect((waitingEvents[0]!.orderNumbers as string[]).length).toBe(3)
			// Every one of them has had its alert.
			await tick(NOW + 20 * MIN)
			expect(events('orders_waiting')).toHaveLength(1)
		})

		it('uses the location’s own limit', async () => {
			settings = settingsFor({ waitingMinutes: 20 })
			await waiting(15)
			await tick()
			expect(events('orders_waiting')).toHaveLength(0)
			await tick(NOW + 6 * MIN)
			expect(events('orders_waiting')).toHaveLength(1)
		})

		it('stays quiet outside opening hours plus an hour, then alerts when they open', async () => {
			settings = settingsFor({
				openIntervals: [
					{ startMs: NOW + 5 * 60 * MIN, endMs: NOW + 10 * 60 * MIN },
				],
			})
			await waiting(30)
			await tick()
			expect(events('orders_waiting')).toHaveLength(0)
			// Within an hour of opening.
			await tick(NOW + 4.5 * 60 * MIN)
			expect(events('orders_waiting')).toHaveLength(1)
		})

		it('tries again when the App cannot be reached, without losing the alert', async () => {
			await waiting(12)
			notifyStatus = 503
			await tick()
			expect(events('orders_waiting')).toHaveLength(1)
			notifyStatus = 200
			await tick(NOW + MIN)
			expect(events('orders_waiting')).toHaveLength(2)
			await tick(NOW + 2 * MIN)
			expect(events('orders_waiting')).toHaveLength(2)
		})
	})

	describe('scheduled orders due soon, and payments to review (#131)', () => {
		it('alerts once for a scheduled order due in 15 minutes and still New', async () => {
			await waiting(120, { scheduledFor: new Date(NOW + 10 * MIN) })
			await waiting(120, { scheduledFor: new Date(NOW + 60 * MIN) })
			const result = await tick()
			const due = events('orders_due_soon')
			expect(due).toHaveLength(1)
			expect(due[0]).toMatchObject({ dueAtMs: NOW + 10 * MIN })
			expect((due[0]!.orderNumbers as string[]).length).toBe(1)
			// The later one is told 15 minutes before it.
			expect(result.nextDueAt).toBe(NOW + 45 * MIN)
			await tick(NOW + 46 * MIN)
			expect(events('orders_due_soon')).toHaveLength(2)
			for (const guest of GUEST)
				expect(JSON.stringify(posted)).not.toContain(guest)
		})

		it('does not alert for a scheduled order already being made', async () => {
			await waiting(120, {
				scheduledFor: new Date(NOW + 5 * MIN),
				status: 'preparing',
			})
			await tick()
			expect(events('orders_due_soon')).toHaveLength(0)
		})

		it('alerts once for a payment that needs review, at any hour', async () => {
			settings = settingsFor({ openIntervals: [] })
			await waiting(1, {
				status: 'payment_review',
				paymentStatus: 'review',
				paymentMethod: 'online',
			})
			await tick()
			await tick(NOW + 10 * MIN)
			const review = events('orders_payment_review')
			expect(review).toHaveLength(1)
			expect(review[0]).toMatchObject({
				orderNumber: expect.stringMatching(/^N-/),
			})
		})
	})

	describe('kill switch and flag', () => {
		it('with ORDERS_ALERTS_ENABLED=false nothing is posted, and nothing is posted later', async () => {
			await waiting(30)
			vi.stubEnv('ORDERS_ALERTS_ENABLED', 'false')
			clearOrdersAlertSettingsCache()
			const result = await tick()
			expect(posted).toHaveLength(0)
			expect(result.waiting).toBe(0)
			vi.stubEnv('ORDERS_ALERTS_ENABLED', '')
			// Turned back on: the order that waited while it was off is still New,
			// so it is told about now; what was dropped is not replayed.
			const db = await getTenantDb(ORG)
			expect(await db.select().from(orderAlerts)).toHaveLength(0)
		})

		it('drops queued new-order alerts while it is off, so there is no backlog', async () => {
			const db = await getTenantDb(ORG)
			const id = await waiting(0, { paymentMethod: 'handoff' })
			const [order] = await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, id))
			const ids: string[] = []
			await runTenantTransaction(db, (tx) =>
				queueOrderPlacedAlert(tx, order as RestaurantOrder, {
					now: NOW,
					collectAlert: (alertId) => ids.push(alertId),
				}),
			)
			expect(ids).toHaveLength(1)
			vi.stubEnv('ORDERS_ALERTS_ENABLED', 'false')
			await tick()
			vi.stubEnv('ORDERS_ALERTS_ENABLED', '')
			const [row] = await db.select().from(orderAlerts)
			expect(row!.status).toBe('dropped')
			await tick(NOW + 5 * MIN)
			expect(events('order_placed')).toHaveLength(0)
		})

		it('does nothing while the organization has the flag off', async () => {
			settings = settingsFor({}, false)
			await waiting(30)
			await tick()
			expect(posted).toHaveLength(0)
		})

		it('alerts nothing, and asks again soon, when the App cannot be asked', async () => {
			settings = null
			await waiting(30)
			const result = await tick()
			expect(posted).toHaveLength(0)
			expect(result.nextDueAt).toBe(NOW + 2 * MIN)
		})
	})

	describe('a new order (#241, #300)', () => {
		async function place(
			overrides: Partial<typeof restaurantOrders.$inferInsert> = {},
		) {
			const db = await getTenantDb(ORG)
			const id = await waiting(0, {
				lines: [
					{ itemId: 'a', quantity: 2 },
					{ itemId: 'b', quantity: 3 },
				] as never,
				totalCents: 12345,
				currency: 'SAR',
				...overrides,
			})
			const [order] = await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, id))
			const ids: string[] = []
			await runTenantTransaction(db, (tx) =>
				queueOrderPlacedAlert(tx, order as RestaurantOrder, {
					now: NOW,
					collectAlert: (alertId) => ids.push(alertId),
				}),
			)
			return { db, order: order as RestaurantOrder, ids }
		}

		it('posts the number, type, time, total, dish count and large flag, and no guest', async () => {
			const { db, order, ids } = await place({ largeOrder: true })
			await postQueuedPlacedAlerts(ORG, db, { ids })
			const [event] = events('order_placed')
			expect(event).toEqual({
				kind: 'order_placed',
				orgId: ORG,
				eventId: order.id,
				locationId: LOC,
				orderNumber: order.number,
				fulfillment: 'pickup',
				scheduledForMs: null,
				totalCents: 12345,
				currency: 'SAR',
				dishCount: 5,
				large: true,
			})
			for (const guest of GUEST)
				expect(JSON.stringify(posted)).not.toContain(guest)
			const [row] = await db.select().from(orderAlerts)
			expect(row).toMatchObject({ kind: 'placed', status: 'sent' })
		})

		it('carries the wanted time of a scheduled order', async () => {
			const at = new Date(NOW + 3 * 60 * MIN)
			const { db, ids } = await place({ scheduledFor: at })
			await postQueuedPlacedAlerts(ORG, db, { ids })
			expect(events('order_placed')[0]).toMatchObject({
				scheduledForMs: at.getTime(),
			})
		})

		it('queues one alert per order, however often the write runs', async () => {
			const { db, order, ids } = await place()
			const again: string[] = []
			await runTenantTransaction(db, (tx) =>
				queueOrderPlacedAlert(tx, order, {
					now: NOW,
					collectAlert: (id) => again.push(id),
				}),
			)
			expect(again).toHaveLength(0)
			await postQueuedPlacedAlerts(ORG, db, { ids })
			await postQueuedPlacedAlerts(ORG, db, { now: NOW + MIN })
			expect(events('order_placed')).toHaveLength(1)
		})

		it('does not alert for an unpaid online order, a table round or a Station sale', async () => {
			const db = await getTenantDb(ORG)
			for (const overrides of [
				{ paymentMethod: 'online' as const, paymentStatus: 'pending' as const },
				{ fulfillment: 'dine_in' as const },
				{ tabId: 'tab-9' },
			]) {
				const id = await waiting(0, overrides)
				const [order] = await db
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, id))
				const ids: string[] = []
				await runTenantTransaction(db, (tx) =>
					queueOrderPlacedAlert(tx, order as RestaurantOrder, {
						now: NOW,
						collectAlert: (alertId) => ids.push(alertId),
					}),
				)
				expect(ids).toHaveLength(0)
			}
		})

		it('retries after a failed post and stops at a refusal', async () => {
			const { db, ids } = await place()
			notifyStatus = 503
			await postQueuedPlacedAlerts(ORG, db, { ids })
			const [pending] = await db.select().from(orderAlerts)
			expect(pending).toMatchObject({ status: 'pending', attempts: 1 })
			expect(pending!.nextAttemptAt).toBeGreaterThan(NOW)
			notifyStatus = 200
			await postQueuedPlacedAlerts(ORG, db, { now: pending!.nextAttemptAt + 1 })
			const [sent] = await db.select().from(orderAlerts)
			expect(sent!.status).toBe('sent')
			expect(events('order_placed')).toHaveLength(2)

			const second = await place()
			notifyStatus = 400
			await postQueuedPlacedAlerts(ORG, second.db, { ids: second.ids })
			const rows = await second.db.select().from(orderAlerts)
			expect(rows.find((r) => r.id === second.ids[0])!.status).toBe('dropped')
		})

		it('does not post for an order cancelled before the alert went out', async () => {
			const { db, order, ids } = await place()
			await db
				.update(restaurantOrders)
				.set({ status: 'cancelled' })
				.where(eq(restaurantOrders.id, order.id))
			await postQueuedPlacedAlerts(ORG, db, { ids })
			expect(events('order_placed')).toHaveLength(0)
		})

		it('posts after commit when the write hands its ids over', async () => {
			const { ids } = await place()
			deliverOrderAlerts(ORG, ids)
			await vi.waitFor(() => expect(events('order_placed')).toHaveLength(1))
		})

		it('tells again, shortly before it starts, about a scheduled large order only', async () => {
			settings = settingsFor({
				largeOrder: { itemThreshold: 8, remindMinutes: 60 },
			})
			await waiting(300, {
				scheduledFor: new Date(NOW + 50 * MIN),
				largeOrder: true,
				totalCents: 90000,
				currency: 'SAR',
			})
			await waiting(300, {
				scheduledFor: new Date(NOW + 50 * MIN),
				largeOrder: false,
			})
			await waiting(300, {
				scheduledFor: new Date(NOW + 5 * 60 * MIN),
				largeOrder: true,
			})
			await tick()
			const soon = events('large_order_soon')
			expect(soon).toHaveLength(1)
			expect(soon[0]).toMatchObject({
				totalCents: 90000,
				currency: 'SAR',
				scheduledForMs: NOW + 50 * MIN,
			})
			await tick(NOW + 10 * MIN)
			expect(events('large_order_soon')).toHaveLength(1)
			for (const guest of GUEST)
				expect(JSON.stringify(posted)).not.toContain(guest)
		})
	})

	describe('a Station tablet going offline (#190)', () => {
		async function tablet(label = 'Kitchen', locationId: string | null = LOC) {
			const paired = await pair(label, locationId)
			return paired
		}

		it('is watched only after its first heartbeat, which stores battery and version', async () => {
			const { deviceSecret, device } = await tablet()
			const db = await getTenantDb(ORG)
			// A pairing alone is not a heartbeat.
			expect(
				(
					await db.select().from(posDevices).where(eq(posDevices.id, device.id))
				)[0]!.lastHeartbeatAt,
			).toBeNull()
			const response = await heartbeat(deviceSecret, {
				batteryPct: 61,
				appVersion: '2.4.0',
			})
			expect(await response.json()).toEqual({ enabled: true })
			const [row] = await db
				.select()
				.from(posDevices)
				.where(eq(posDevices.id, device.id))
			expect(row).toMatchObject({ batteryPercent: 61, appVersion: '2.4.0' })
			expect(row!.lastHeartbeatAt).not.toBeNull()
			expect(row!.lastSeenAt).not.toBeNull()
		})

		it('keeps its old behavior for an organization without manager alerts', async () => {
			settings = settingsFor({}, false)
			const { deviceSecret, device } = await tablet()
			const response = await heartbeat(deviceSecret, { batteryPct: 40 })
			expect(await response.json()).toEqual({ enabled: false })
			const db = await getTenantDb(ORG)
			const [row] = await db
				.select()
				.from(posDevices)
				.where(eq(posDevices.id, device.id))
			expect(row!.batteryPercent).toBeNull()
			expect(row!.lastHeartbeatAt).toBeNull()
		})

		it('refuses a heartbeat without the device secret', async () => {
			const response = await app.request('/pos/heartbeat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			})
			expect(response.status).toBe(401)
			expect((await heartbeat('not-a-device-secret')).status).toBe(401)
		})

		it('alerts once after 5 minutes of silence in opening hours, and not before', async () => {
			const { device } = await tablet()
			await setDevice(device.id, {
				lastSeenAt: NOW - 4 * MIN,
				lastHeartbeatAt: NOW - 4 * MIN,
			})
			let result = await tick()
			expect(events('station_offline')).toHaveLength(0)
			expect(result.nextDueAt).toBe(NOW + 1 * MIN)

			await setDevice(device.id, {
				lastSeenAt: NOW - 6 * MIN,
				lastHeartbeatAt: NOW - 6 * MIN,
			})
			result = await tick()
			const [event] = events('station_offline')
			expect(event).toMatchObject({
				kind: 'station_offline',
				deviceId: device.id,
				deviceLabel: 'Kitchen',
				state: 'offline',
				minutes: 6,
				allKitchenOffline: false,
				locationId: LOC,
			})
			// One alert per outage.
			await tick(NOW + 10 * MIN)
			await tick(NOW + 60 * MIN)
			expect(events('station_offline')).toHaveLength(1)
		})

		it('does not alert outside opening hours plus half an hour, or without opening hours', async () => {
			const { device } = await tablet()
			await setDevice(device.id, {
				lastSeenAt: NOW - 10 * MIN,
				lastHeartbeatAt: NOW - 10 * MIN,
			})
			settings = settingsFor({
				openIntervals: [{ startMs: NOW + 60 * MIN, endMs: NOW + 5 * 60 * MIN }],
			})
			clearOrdersAlertSettingsCache()
			await tick()
			expect(events('station_offline')).toHaveLength(0)
			settings = settingsFor({ openIntervals: null })
			clearOrdersAlertSettingsCache()
			await tick()
			expect(events('station_offline')).toHaveLength(0)
			// Within half an hour of opening it does.
			settings = settingsFor({
				openIntervals: [{ startMs: NOW + 25 * MIN, endMs: NOW + 5 * 60 * MIN }],
			})
			clearOrdersAlertSettingsCache()
			await tick()
			expect(events('station_offline')).toHaveLength(1)
		})

		it('never alerts for a removed tablet, a spare, or one that never connected', async () => {
			const removed = await tablet('Old till')
			const spare = await tablet('Spare tablet')
			const never = await tablet('New one')
			const silent = {
				lastSeenAt: NOW - 20 * MIN,
				lastHeartbeatAt: NOW - 20 * MIN,
			}
			await setDevice(removed.device.id, {
				...silent,
				revokedAt: NOW - 10 * MIN,
			})
			await setDevice(spare.device.id, silent)
			await setDevice(never.device.id, {
				lastSeenAt: null,
				lastHeartbeatAt: null,
			})
			await tick()
			expect(events('station_offline')).toHaveLength(0)
		})

		it('says it is back online and clears the outage when the tablet returns', async () => {
			const { device } = await tablet()
			await setDevice(device.id, {
				lastSeenAt: NOW - 6 * MIN,
				lastHeartbeatAt: NOW - 6 * MIN,
			})
			await tick()
			expect(events('station_offline')).toHaveLength(1)
			const db = await getTenantDb(ORG)
			const [alerted] = await db
				.select()
				.from(posDevices)
				.where(eq(posDevices.id, device.id))
			expect(alerted!.offlineAlertedAt).toBe(NOW - 6 * MIN)

			// It checks in again nine minutes later.
			await setDevice(device.id, {
				lastSeenAt: NOW + 3 * MIN,
				lastHeartbeatAt: NOW + 3 * MIN,
			})
			const result = await tick(NOW + 4 * MIN)
			expect(result.tabletsBack).toBe(1)
			const back = events('station_offline').filter(
				(e) => e.state === 'back_online',
			)
			expect(back).toHaveLength(1)
			expect(back[0]).toMatchObject({ minutes: 9, deviceLabel: 'Kitchen' })
			const [after] = await db
				.select()
				.from(posDevices)
				.where(eq(posDevices.id, device.id))
			expect(after!.offlineAlertedAt).toBeNull()
			await tick(NOW + 5 * MIN)
			expect(
				events('station_offline').filter((e) => e.state === 'back_online'),
			).toHaveLength(1)

			// A second outage is a new alert.
			await setDevice(device.id, { lastSeenAt: NOW + 5 * MIN })
			await tick(NOW + 12 * MIN)
			expect(
				events('station_offline').filter((e) => e.state === 'offline'),
			).toHaveLength(2)
		})

		it('tells the critical case at once, repeats every five minutes, and stops when the order is started', async () => {
			const kitchenA = await tablet('Pass')
			const kitchenB = await tablet('Grill')
			const silent = {
				lastSeenAt: NOW - 6 * MIN,
				lastHeartbeatAt: NOW - 6 * MIN,
			}
			await setDevice(kitchenA.device.id, silent)
			await setDevice(kitchenB.device.id, silent)
			const orderId = await waiting(1)
			await tick()
			let critical = events('station_offline').filter(
				(e) => e.allKitchenOffline === true,
			)
			expect(critical).toHaveLength(1)
			expect(critical[0]).toMatchObject({
				waitingOrderNumber: expect.stringMatching(/^N-/),
				locationId: LOC,
			})
			// Not again within five minutes, again after.
			await tick(NOW + 2 * MIN)
			expect(
				events('station_offline').filter((e) => e.allKitchenOffline === true),
			).toHaveLength(1)
			await tick(NOW + 5 * MIN + 1)
			critical = events('station_offline').filter(
				(e) => e.allKitchenOffline === true,
			)
			expect(critical).toHaveLength(2)
			expect(new Set(critical.map((e) => e.eventId)).size).toBe(2)
			// Someone starts the order: it stops.
			const db = await getTenantDb(ORG)
			await db
				.update(restaurantOrders)
				.set({ status: 'preparing' })
				.where(eq(restaurantOrders.id, orderId))
			await tick(NOW + 11 * MIN)
			expect(
				events('station_offline').filter((e) => e.allKitchenOffline === true),
			).toHaveLength(2)
		})

		it('is not critical while one kitchen tablet is online, or with no order waiting', async () => {
			const down = await tablet('Pass')
			const up = await tablet('Grill')
			await setDevice(down.device.id, {
				lastSeenAt: NOW - 20 * MIN,
				lastHeartbeatAt: NOW - 20 * MIN,
			})
			await setDevice(up.device.id, {
				lastSeenAt: NOW - MIN,
				lastHeartbeatAt: NOW - MIN,
			})
			await waiting(1)
			await tick()
			expect(
				events('station_offline').filter((e) => e.allKitchenOffline === true),
			).toHaveLength(0)
			await setDevice(up.device.id, { lastSeenAt: NOW - 20 * MIN })
			const db = await getTenantDb(ORG)
			await db.delete(restaurantOrders)
			await tick(NOW + MIN)
			expect(
				events('station_offline').filter((e) => e.allKitchenOffline === true),
			).toHaveLength(0)
		})

		it('lists battery and version for the Terminals page', async () => {
			const { deviceSecret } = await tablet()
			await heartbeat(deviceSecret, { batteryPct: 77, appVersion: '3.0.1' })
			const response = await app.request('/operator/pos/terminals', {
				headers: { authorization: `Bearer ${await mint()}` },
			})
			const body = (await response.json()) as {
				devices: Array<{
					batteryPercent: number | null
					appVersion: string | null
				}>
			}
			expect(body.devices[0]).toMatchObject({
				batteryPercent: 77,
				appVersion: '3.0.1',
			})
		})
	})
})
