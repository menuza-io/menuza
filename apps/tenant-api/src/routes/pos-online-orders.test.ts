import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	POS_ONLINE_ORDERS_SEARCH_LIMIT,
	type PosOnlineOrderDetailResponse,
	type PosOnlineOrdersFeed,
	type PosOnlineOrdersSearch,
} from '@repo/common/pos-online-orders'
import {
	formatPosDeviceSecret,
	POS_STAFF_SESSION_HEADER,
} from '@repo/common/pos-orders'
import {
	destroyTenantDb,
	getTenantDb,
	posDevices,
	posHosts,
	posManagers,
	posOnlineOrderEvents,
	posOrders,
	printJobs,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
	staffMembers,
	staffScopeAssignments,
} from '@repo/tenant-db'
import { ORG_A, ORG_B, stubStaffEnv } from '../../tests/staff-harness.ts'
import {
	orderRefundKicksIdle,
	setOrderRefundKickForTest,
} from '../lib/order-refund-kick.ts'
import { hashPosSecret } from '../lib/pos-auth.ts'
import { seedPrintingFlagForTest } from '../lib/print-switches.ts'
import { createPrinter } from '../services/print-service.ts'
import { loadOrderSteps } from '../services/order-steps.ts'
import { mintPosStaffSession } from '../lib/pos-staff-session.ts'
import { reconcileLoyaltySource } from '../services/loyalty-purchase-service.ts'
import { applyProviderRefundStatus } from '../services/order-provider-refund-service.ts'
import {
	activateProgram,
	claimAndQueue,
	insertCustomer,
	makeMember,
	NOW,
} from '../services/loyalty-test-fixture.ts'
import { PHONE_SEARCHES_PER_HOUR } from '../services/pos-online-orders-service.ts'
import { posKdsRoutes } from './pos-kds.ts'
import { posOnlineOrdersRoutes } from './pos-online-orders.ts'

const LOCATION = 'loc-1'

describe('Station Orders app API (/pos/online-orders)', () => {
	let dir: string
	const app = new Hono()
		.route('/pos/online-orders', posOnlineOrdersRoutes)
		.route('/pos/kds', posKdsRoutes)
	let secret: string
	let deviceId: string
	let otherSecret: string
	let cashier: string
	let manager: string
	let cashierId: string
	let managerId: string
	let keys = 0

	async function addDevice(
		label: string,
		code: string,
		values: Partial<typeof posDevices.$inferInsert> = {},
	) {
		const db = await getTenantDb(ORG_A)
		const id = crypto.randomUUID()
		const token = formatPosDeviceSecret(ORG_A, id, 'x'.repeat(43))
		await db.insert(posDevices).values({
			id,
			label,
			terminalCode: code,
			locationId: LOCATION,
			signInRequired: true,
			ordersEnabled: true,
			secretHash: hashPosSecret(token),
			pairedBy: 'operator',
			...values,
		})
		return { id, token }
	}

	async function addStaff(first: string, role: 'cashier' | 'manager') {
		const db = await getTenantDb(ORG_A)
		const staffId = crypto.randomUUID()
		await db
			.insert(staffMembers)
			.values({ id: staffId, firstName: first, lastName: 'Smith' })
		await db
			.insert(staffScopeAssignments)
			.values({ staffId, scopeId: LOCATION, pinLookup: `set-${staffId}` })
		if (role === 'manager')
			await db.insert(posManagers).values({ staffId, addedBy: 'operator' })
		return staffId
	}

	async function session(staffId: string, device = deviceId) {
		return (
			await mintPosStaffSession({
				orgId: ORG_A,
				deviceId: device,
				staffId,
				role: 'cashier',
			})
		).token
	}

	async function insertOrder(
		values: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		const db = await getTenantDb(ORG_A)
		const id = values.id ?? crypto.randomUUID()
		await db.insert(restaurantOrders).values({
			orgId: ORG_A,
			number: 'W-1',
			status: 'accepted',
			paymentMethod: 'online',
			paymentStatus: 'paid',
			fulfillment: 'pickup',
			locationId: LOCATION,
			locationName: 'Main',
			contactName: 'Layla Guest',
			contactPhone: '+15551234567',
			contactEmail: 'layla@example.com',
			currency: 'USD',
			subtotalCents: 1500,
			taxCents: 0,
			totalCents: 1500,
			lines: [
				{
					itemId: 'burger',
					itemName: 'Burger',
					quantity: 2,
					totalCents: 1500,
					instructions: 'No onion',
					options: [
						{
							groupId: 'g',
							groupName: 'Cheese',
							optionId: 'o',
							optionName: 'Cheddar',
							half: null,
							quantity: 1,
							priceCents: 0,
							totalCents: 0,
						},
					],
				},
			],
			idempotencyKey: crypto.randomUUID(),
			requestHash: 'x',
			receiptTokenHash: 'y',
			paidAt: new Date(),
			// Paid online through a bound Checkout Session (refunds go back
			// through the provider).
			paymentProcessor: 'connect',
			paymentSessionId: `cs_station_${crypto.randomUUID()}`,
			...values,
			id,
		})
		return id
	}

	async function call(
		method: string,
		suffix: string,
		options: {
			body?: unknown
			token?: string
			staff?: string | null
			key?: string
		} = {},
	) {
		const staff = options.staff === undefined ? cashier : options.staff
		return app.request(`/pos/online-orders${suffix}`, {
			method,
			headers: {
				Authorization: `Bearer ${options.token ?? secret}`,
				'Content-Type': 'application/json',
				...(staff ? { [POS_STAFF_SESSION_HEADER]: staff } : {}),
				...(options.key ? { 'Idempotency-Key': options.key } : {}),
			},
			...(options.body === undefined
				? {}
				: { body: JSON.stringify(options.body) }),
		})
	}
	async function feed(staff = cashier, token = secret) {
		const response = await call('GET', '', { staff, token })
		expect(response.status).toBe(200)
		return (await response.json()) as PosOnlineOrdersFeed
	}
	async function detail(id: string, staff = cashier) {
		const response = await call('GET', `/${id}`, { staff })
		expect(response.status).toBe(200)
		return (await response.json()) as PosOnlineOrderDetailResponse
	}
	async function command(id: string, body: unknown, staff = cashier) {
		return call('POST', `/${id}/command`, { body, staff })
	}
	async function refund(id: string, body: unknown, staff = manager) {
		return call('POST', `/${id}/refunds`, {
			body,
			staff,
			key: `station-refund-${++keys}`,
		})
	}

	const kicks: Array<{ orgId: string; refundId: string }> = []

	beforeEach(async () => {
		kicks.length = 0
		setOrderRefundKickForTest(async (request) => {
			kicks.push(request)
			return { status: 'sent' }
		})
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-orders-'))
		stubStaffEnv(dir)
		vi.stubEnv('POS_ENABLED', '')
		for (const org of [ORG_A, ORG_B]) await provisionTenantDb(org)
		;({ id: deviceId, token: secret } = await addDevice('Counter', 'C1'))
		;({ token: otherSecret } = await addDevice('Counter 2', 'C2'))
		cashierId = await addStaff('Sam', 'cashier')
		managerId = await addStaff('Mona', 'manager')
		cashier = await session(cashierId)
		manager = await session(managerId)
	})
	afterEach(async () => {
		await orderRefundKicksIdle()
		setOrderRefundKickForTest(null)
		for (const org of [ORG_A, ORG_B]) await destroyTenantDb(org)
		fs.rmSync(dir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('lists the location’s online orders, no-store, with the phone masked and no email', async () => {
		const id = await insertOrder()
		await insertOrder({ number: 'W-2', locationId: 'elsewhere' })
		await insertOrder({
			number: 'W-3',
			paymentMethod: 'online',
			paymentStatus: 'pending',
		})
		const response = await call('GET', '')
		expect(response.headers.get('cache-control')).toContain('no-store')
		const raw = await response.text()
		expect(raw).not.toMatch(/15551234567|layla@example/)
		const data = JSON.parse(raw) as PosOnlineOrdersFeed
		expect(data.orders.map((order) => order.id)).toEqual([id])
		expect(data.orders[0]).toMatchObject({
			number: 'W-1',
			status: 'accepted',
			guestName: 'Layla Guest',
			itemCount: 2,
			openedAt: null,
		})
		expect(data.grants).toMatchObject({
			view: true,
			manage: true,
			contact: false,
			cancel: false,
			refund: false,
		})
		const one = await detail(id)
		expect(one.order.phoneMasked).toBe('•••• 4567')
		expect(JSON.stringify(one)).not.toMatch(/15551234567|layla@example/)
		expect(one.order.lines[0]).toMatchObject({
			name: 'Burger',
			instructions: 'No onion',
			options: [{ name: 'Cheddar', quantity: 1 }],
		})
	})

	it('lists phone orders waiting to be collected, read only', async () => {
		const db = await getTenantDb(ORG_A)
		await db.insert(posOrders).values({
			id: crypto.randomUUID(),
			deviceId,
			number: 'C1-0007',
			businessDate: '2026-11-12',
			revision: 1,
			status: 'open',
			orderType: 'takeaway',
			orderSource: 'phone',
			customerPhone: '+15559990000',
			guestName: 'Omar',
			pickupAt: Date.now() + 30 * 60_000,
			locationId: LOCATION,
			currency: 'USD',
			subtotalCents: 900,
			taxCents: 0,
			totalCents: 900,
			lines: [],
			adjustments: [],
			rungUpAt: Date.now(),
		})
		const raw = JSON.stringify(await feed())
		expect(raw).toContain('C1-0007')
		expect(raw).not.toContain('15559990000')
	})

	it('opening an order silences the new-order alert on every tablet at the location, and records who', async () => {
		const id = await insertOrder()
		expect((await feed()).orders[0]!.openedAt).toBeNull()
		expect((await command(id, { action: 'open' })).status).toBe(200)
		const other = await session(managerId, (await feedDeviceId(otherSecret))!)
		const seen = await feed(other, otherSecret)
		expect(seen.orders[0]!.openedAt).toEqual(expect.any(Number))
		const db = await getTenantDb(ORG_A)
		const events = await db.select().from(posOnlineOrderEvents)
		expect(events).toMatchObject([
			{ action: 'opened', staffId: cashierId, deviceId, orderId: id },
		])
		// Opening again records nothing new.
		await command(id, { action: 'open' })
		expect(await db.select().from(posOnlineOrderEvents)).toHaveLength(1)
	})

	async function feedDeviceId(token: string) {
		const db = await getTenantDb(ORG_A)
		const rows = await db.select().from(posDevices)
		return rows.find((row) => row.secretHash === hashPosSecret(token))?.id
	}

	it('marks ready and hands over, updating the order everywhere (kitchen too) and recording the person', async () => {
		const id = await insertOrder()
		let current = (await detail(id)).order
		const ready = await command(id, {
			action: 'ready',
			expectedVersion: current.version,
		})
		expect(ready.status).toBe(200)
		current = ((await ready.json()) as PosOnlineOrderDetailResponse).order
		expect(current.status).toBe('ready')
		const kitchen = (await (
			await app.request('/pos/kds', {
				headers: {
					Authorization: `Bearer ${secret}`,
					[POS_STAFF_SESSION_HEADER]: cashier,
				},
			})
		).json()) as {
			tickets: Array<{ id: string; lines: Array<{ stage: string }> }>
		}
		expect(kitchen.tickets.find((t) => t.id === id)?.lines[0]?.stage).toBe(
			'ready',
		)
		const done = await command(id, {
			action: 'handed_over',
			expectedVersion: current.version,
		})
		expect(done.status).toBe(200)
		const db = await getTenantDb(ORG_A)
		const [row] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, id))
		expect(row).toMatchObject({ status: 'completed' })
		expect(row!.completedAt).not.toBeNull()
		const history = (await detail(id)).order.history
		expect(history.map((entry) => entry.action).sort()).toEqual([
			'handed_over',
			'ready',
		])
		expect(history[0]!.staffName).toBe('Sam S.')
		// The order's steps (#243): which screen did each, and which Station
		// person (an opaque id, never a name).
		const steps = await loadOrderSteps(db, id)
		expect(
			steps.map((entry) => [entry.step, entry.actorKind, entry.source]),
		).toEqual([
			['ready', 'station', 'station_orders'],
			['handed_over', 'station', 'station_orders'],
		])
		expect(steps[0]!.actorId).toMatch(/^staff:/)
		expect(JSON.stringify(steps)).not.toContain('Sam')
	})

	it('refuses a stale version with 409 and changes nothing', async () => {
		const id = await insertOrder()
		const seen = (await detail(id)).order
		expect(
			(await command(id, { action: 'ready', expectedVersion: seen.version }))
				.status,
		).toBe(200)
		const stale = await command(
			id,
			{
				action: 'cancel',
				expectedVersion: seen.version,
				reason: 'guest_request',
			},
			manager,
		)
		expect(stale.status).toBe(409)
		expect(await stale.json()).toMatchObject({ error: 'stale_version' })
		expect((await detail(id)).order.status).toBe('ready')
	})

	it('never hands over a pay-at-handoff order before the payment is recorded', async () => {
		const id = await insertOrder({
			paymentMethod: 'handoff',
			paymentStatus: 'unpaid',
			paidAt: null,
		})
		const seen = (await detail(id)).order
		const refused = await command(id, {
			action: 'handed_over',
			expectedVersion: seen.version,
		})
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({ error: 'payment_required' })
		const handed = await command(id, {
			action: 'handed_over',
			expectedVersion: seen.version,
			markPaid: true,
		})
		expect(handed.status).toBe(200)
		const order = ((await handed.json()) as PosOnlineOrderDetailResponse).order
		expect(order).toMatchObject({ status: 'completed', paymentStatus: 'paid' })
		expect(order.history.map((entry) => entry.action).sort()).toEqual([
			'handed_over',
			'paid',
		])
	})

	it('cancels only for a manager, with a reason, and the kitchen shows the stop-prep warning', async () => {
		const id = await insertOrder()
		const seen = (await detail(id)).order
		const body = {
			action: 'cancel',
			expectedVersion: seen.version,
			reason: 'out_of_stock',
		}
		const denied = await command(id, body)
		expect(denied.status).toBe(403)
		expect(await denied.json()).toMatchObject({ error: 'permission_required' })
		expect((await command(id, body, manager)).status).toBe(200)
		const after = (await detail(id, manager)).order
		expect(after.status).toBe('cancelled')
		expect(after.history[0]).toMatchObject({
			action: 'cancelled',
			reason: 'out_of_stock',
			staffName: 'Mona S.',
		})
		const kitchen = (await (
			await app.request('/pos/kds', {
				headers: {
					Authorization: `Bearer ${secret}`,
					[POS_STAFF_SESSION_HEADER]: cashier,
				},
			})
		).json()) as { tickets: Array<{ id: string; cancelled: boolean }> }
		expect(kitchen.tickets.find((t) => t.id === id)?.cancelled).toBe(true)
	})

	it('refunds an online order through the payment provider for a manager, never past what was paid', async () => {
		const id = await insertOrder({
			status: 'completed',
			completedAt: new Date(),
		})
		let seen = (await detail(id, manager)).order
		expect(seen.refundableCents).toBe(1500)
		const denied = await refund(
			id,
			{ expectedVersion: seen.version, amountCents: 500, note: 'Cold fries' },
			cashier,
		)
		expect(denied.status).toBe(403)
		const tooMuch = await refund(id, {
			expectedVersion: seen.version,
			amountCents: 1501,
			note: 'Cold fries',
		})
		expect(tooMuch.status).toBe(422)
		expect(await tooMuch.json()).toMatchObject({
			error: 'refund_exceeds_payment',
			refundableCents: 1500,
		})
		const partial = await refund(id, {
			expectedVersion: seen.version,
			amountCents: 500,
			note: 'Cold fries',
		})
		expect(partial.status).toBe(201)
		seen = ((await partial.json()) as PosOnlineOrderDetailResponse).order
		// Booked with the provider: nothing came back yet, 500 is on its way.
		expect(seen).toMatchObject({
			refundedCents: 0,
			refundPendingCents: 500,
			refundableCents: 1000,
			refundStatus: 'pending',
			refunds: [{ amountCents: 500, kind: 'provider', status: 'pending' }],
		})
		expect(seen.history[0]).toMatchObject({
			action: 'refunded',
			amountCents: 500,
			reason: 'partial',
			staffName: 'Mona S.',
		})
		const db = await getTenantDb(ORG_A)
		const [row] = await db.select().from(restaurantOrderRefunds)
		expect(row).toMatchObject({
			amountCents: 500,
			note: 'Cold fries',
			actorId: `staff:${managerId}`,
			kind: 'provider',
			origin: 'station',
			status: 'pending',
		})
		// The region tells the App to execute it (ids only).
		await orderRefundKicksIdle()
		expect(kicks).toEqual([{ orgId: ORG_A, refundId: row!.id }])
		// One provider refund at a time.
		const busy = await refund(id, {
			expectedVersion: seen.version,
			full: true,
			note: 'Whole order',
		})
		expect(busy.status).toBe(409)
		expect(await busy.json()).toMatchObject({ error: 'refund_pending' })

		const settled = await applyProviderRefundStatus({
			orgId: ORG_A,
			refundId: row!.id,
			status: 'succeeded',
			providerRefundId: 're_station_1',
		})
		expect(settled.ok).toBe(true)
		seen = (await detail(id, manager)).order
		expect(seen).toMatchObject({
			refundedCents: 500,
			refundableCents: 1000,
			refundStatus: 'partial',
		})
		// Nothing waits on the provider: the key is left out, not 0.
		expect(seen).not.toHaveProperty('refundPendingCents')
		const before = seen.version
		// The provider takes it back later (succeeded, then failed): Station
		// reads "failed", the 500 is refundable again, and the version moves.
		const reversed = await applyProviderRefundStatus({
			orgId: ORG_A,
			refundId: row!.id,
			status: 'failed',
			providerRefundId: 're_station_1',
			failureCode: 'card_closed',
		})
		expect(reversed.ok).toBe(true)
		seen = (await detail(id, manager)).order
		expect(seen.version).not.toBe(before)
		expect(seen).toMatchObject({
			refundedCents: 0,
			refundableCents: 1500,
			refundStatus: 'failed',
			refunds: [
				{ amountCents: 500, status: 'failed', failureCode: 'card_closed' },
			],
		})
		expect(
			(
				await refund(id, {
					expectedVersion: seen.version,
					full: true,
					note: 'Whole order',
				})
			).status,
		).toBe(201)
		expect((await detail(id)).order.refundableCents).toBe(0)
	})

	it('records refunds of payment taken at handoff, with no provider and no kick', async () => {
		const id = await insertOrder({
			status: 'completed',
			completedAt: new Date(),
			paymentMethod: 'handoff',
			paymentProcessor: null,
			paymentSessionId: null,
		})
		let seen = (await detail(id, manager)).order
		expect(seen.refundableCents).toBe(1500)
		const partial = await refund(id, {
			expectedVersion: seen.version,
			amountCents: 500,
			note: 'Cold fries',
		})
		expect(partial.status).toBe(201)
		seen = ((await partial.json()) as PosOnlineOrderDetailResponse).order
		expect(seen).toMatchObject({
			refundedCents: 500,
			refundableCents: 1000,
			refundStatus: 'partial',
			refunds: [{ kind: 'record', status: 'succeeded' }],
		})
		// The version the screen saw before the refund is stale now.
		expect(
			(
				await refund(id, {
					expectedVersion: (await detail(id)).order.version,
					full: true,
					note: 'Whole order',
				})
			).status,
		).toBe(201)
		expect((await detail(id)).order.refundableCents).toBe(0)
		await orderRefundKicksIdle()
		expect(kicks).toEqual([])
	})

	it('cancels a paid online order with a full refund for a manager, mapping the reason', async () => {
		const id = await insertOrder()
		const seen = (await detail(id, manager)).order
		const body = {
			action: 'cancel',
			expectedVersion: seen.version,
			reason: 'guest_request',
			refund: 'full',
		}
		const response = await command(id, body, manager)
		expect(response.status).toBe(200)
		const answer = (await response.json()) as PosOnlineOrderDetailResponse
		expect(answer.refundOutcome).toEqual({ started: true, code: null })
		expect(answer.order).toMatchObject({
			status: 'cancelled',
			refundStatus: 'pending',
			refundPendingCents: 1500,
			refundableCents: 0,
		})
		const db = await getTenantDb(ORG_A)
		const [order] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, id))
		expect(order).toMatchObject({
			cancelReason: 'guest_asked',
			cancelledBy: 'operator',
		})
		const [row] = await db.select().from(restaurantOrderRefunds)
		expect(row).toMatchObject({
			origin: 'station',
			actorId: `staff:${managerId}`,
			amountCents: 1500,
		})
		await orderRefundKicksIdle()
		expect(kicks).toEqual([{ orgId: ORG_A, refundId: row!.id }])

		// Payment taken at handoff is never refunded with the cancel.
		const handoff = await insertOrder({
			number: 'W-2',
			paymentMethod: 'handoff',
			paymentProcessor: null,
			paymentSessionId: null,
		})
		const refused = await command(
			handoff,
			{
				action: 'cancel',
				expectedVersion: (await detail(handoff, manager)).order.version,
				reason: 'other',
				refund: 'full',
			},
			manager,
		)
		expect(refused.status).toBe(400)
	})

	it('cancels a disputed order without a refund and says why', async () => {
		const id = await insertOrder({ disputeStatus: 'open' })
		const seen = (await detail(id, manager)).order
		expect(seen.disputed).toBe(true)
		const response = await command(
			id,
			{
				action: 'cancel',
				expectedVersion: seen.version,
				reason: 'too_busy',
				refund: 'full',
			},
			manager,
		)
		expect(response.status).toBe(200)
		const answer = (await response.json()) as PosOnlineOrderDetailResponse
		expect(answer.refundOutcome).toEqual({
			started: false,
			code: 'payment_disputed',
		})
		expect(answer.order.status).toBe('cancelled')
	})

	it('a refund that takes loyalty points back needs the App grant, which no till has', async () => {
		await activateProgram(ORG_A)
		await insertCustomer(ORG_A, { id: 'cus_1' })
		const memberId = await makeMember(ORG_A, { customerId: 'cus_1' })
		const id = await insertOrder({
			status: 'completed',
			completedAt: new Date(),
		})
		const source = { type: 'restaurant_order' as const, id }
		await claimAndQueue(ORG_A, { memberId, source })
		await reconcileLoyaltySource(ORG_A, source, { now: NOW })
		const seen = (await detail(id)).order
		const response = await refund(id, {
			expectedVersion: seen.version,
			amountCents: 100,
			note: 'Cold fries',
		})
		expect(response.status).toBe(403)
		expect(await response.json()).toMatchObject({
			error: 'loyalty_refund_forbidden',
		})
	})

	it('reveals the full contact only to people with the contact permission, and records it', async () => {
		const id = await insertOrder()
		expect((await call('POST', `/${id}/contact`)).status).toBe(403)
		const db = await getTenantDb(ORG_A)
		await db
			.insert(posHosts)
			.values({ staffId: cashierId, guestDetails: true, addedBy: 'operator' })
		const response = await call('POST', `/${id}/contact`)
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toContain('no-store')
		expect(await response.json()).toEqual({
			phone: '+15551234567',
			email: 'layla@example.com',
		})
		expect((await detail(id)).order.history[0]).toMatchObject({
			action: 'contact_viewed',
		})
	})

	it('opens an order with a very long, multi-language dish name', async () => {
		const longName = JSON.stringify(
			Object.fromEntries(
				['en', 'ar', 'es', 'fr', 'de', 'zh'].map((locale) => [
					locale,
					'Slow-roasted '.repeat(10),
				]),
			),
		)
		expect(longName.length).toBeGreaterThan(400)
		const id = await insertOrder({
			lines: [
				{
					itemId: 'dish',
					itemName: longName,
					quantity: 1,
					totalCents: 1500,
					instructions: null,
					options: [],
				},
			],
		})
		expect((await detail(id)).order.lines[0]!.name).toBe(longName)
	})

	it('changes only what the inbox shows: an order finished hours ago opens read-only, its contact and refunds are the App’s', async () => {
		const old = new Date(Date.now() - 5 * 3_600_000)
		const id = await insertOrder({ status: 'completed', completedAt: old })
		const ancient = await insertOrder({
			number: 'W-9',
			status: 'completed',
			createdAt: new Date(Date.now() - 10 * 86_400_000),
			completedAt: new Date(Date.now() - 10 * 86_400_000),
		})
		const db = await getTenantDb(ORG_A)
		await db
			.insert(posHosts)
			.values({ staffId: cashierId, guestDetails: true, addedBy: 'operator' })
		const read = await detail(id)
		expect(read.order.phoneMasked).toBe('•••• 4567')
		expect(JSON.stringify(read)).not.toMatch(/15551234567|layla@example/)
		// Past what search reaches, it is the App's alone.
		expect((await call('GET', `/${ancient}`)).status).toBe(404)
		expect((await call('POST', `/${id}/contact`)).status).toBe(404)
		expect(
			(
				await command(
					id,
					{
						action: 'cancel',
						expectedVersion: read.order.version,
						reason: 'other',
					},
					manager,
				)
			).status,
		).toBe(404)
		expect(
			(await command(id, { action: 'reprint', ticket: 'guest' })).status,
		).toBe(404)
		expect(
			(
				await refund(id, {
					expectedVersion: 'a'.repeat(64),
					full: true,
					note: 'Whole order',
				})
			).status,
		).toBe(404)
	})

	describe('search (today and the last 7 days)', () => {
		async function search(params: Record<string, string>, staff = cashier) {
			return call('GET', `/search?${new URLSearchParams(params).toString()}`, {
				staff,
			})
		}
		async function found(params: Record<string, string>, staff = cashier) {
			const response = await search(params, staff)
			expect(response.status).toBe(200)
			expect(response.headers.get('cache-control')).toContain('no-store')
			return (await response.json()) as PosOnlineOrdersSearch
		}

		it('finds an order by its number, past the inbox, newest first, never with a phone or email', async () => {
			const days = (n: number) => new Date(Date.now() - n * 86_400_000)
			const today = await insertOrder({ number: 'W-1042' })
			const lastWeek = await insertOrder({
				number: 'W-1041',
				status: 'completed',
				createdAt: days(6),
				completedAt: days(6),
			})
			await insertOrder({
				number: 'W-1040',
				status: 'completed',
				createdAt: days(12),
				completedAt: days(12),
			})
			await insertOrder({ number: 'W-1043', locationId: 'elsewhere' })
			const response = await search({ q: '104' })
			const raw = await response.text()
			expect(raw).not.toMatch(/15551234567|layla@example/)
			const data = JSON.parse(raw) as PosOnlineOrdersSearch
			expect(data.results.map((order) => order.id)).toEqual([today, lastWeek])
			expect(data.truncated).toBe(false)
			expect((await found({ q: 'w-1041' })).results[0]?.number).toBe('W-1041')
		})

		it('finds by guest name, filters by state and order type, and takes wildcards literally', async () => {
			const ready = await insertOrder({
				number: 'W-7',
				status: 'ready',
				contactName: 'Omar 100%',
			})
			await insertOrder({
				number: 'W-8',
				fulfillment: 'delivery',
				contactName: 'Omar Two',
				deliveryAddress: '1 Road',
			})
			expect((await found({ q: 'omar' })).results).toHaveLength(2)
			expect(
				(await found({ q: 'omar', state: 'ready' })).results.map((o) => o.id),
			).toEqual([ready])
			expect(
				(await found({ q: 'omar', fulfillment: 'delivery' })).results.map(
					(o) => o.number,
				),
			).toEqual(['W-8'])
			expect((await found({ q: '0%' })).results.map((o) => o.id)).toEqual([
				ready,
			])
			expect((await found({ q: 'r_' })).results).toHaveLength(0)
			// One character would list everyone.
			expect((await search({ q: 'o' })).status).toBe(400)
		})

		it('finds names with accented capitals as typed, and ASCII names in any case', async () => {
			const id = await insertOrder({ contactName: 'Émile Durand' })
			expect((await found({ q: 'Émile' })).results.map((o) => o.id)).toEqual([
				id,
			])
			expect((await found({ q: 'DURAND' })).results.map((o) => o.id)).toEqual([
				id,
			])
		})

		it('opens an order past the inbox without its address or notes, unless the person may see contacts', async () => {
			const days = (n: number) => new Date(Date.now() - n * 86_400_000)
			const id = await insertOrder({
				number: 'W-OLDDEL',
				status: 'completed',
				fulfillment: 'delivery',
				deliveryAddress: '9 Private Lane',
				createdAt: days(3),
				completedAt: days(3),
			})
			const asCashier = (await detail(id)).order
			expect(asCashier.delivery).toBeNull()
			expect(asCashier.lines.every((line) => line.instructions === null)).toBe(
				true,
			)
			const response = await call('GET', `/${id}`, { staff: manager })
			const asManager = (
				(await response.json()) as PosOnlineOrderDetailResponse
			).order
			expect(asManager.delivery?.address).toBe('9 Private Lane')
			expect(asManager.lines[0]?.instructions).toBe('No onion')
		})

		it('searches the phone’s last digits only with the contact permission', async () => {
			const id = await insertOrder({ contactPhone: '+1 (555) 123-0111' })
			await insertOrder({ number: 'W-2' })
			const refused = await search({ phone: '0111' })
			expect(refused.status).toBe(403)
			expect(await refused.json()).toMatchObject({
				error: 'permission_required',
			})
			// Even a malformed phone search is refused the same way.
			expect((await search({ phone: 'x' })).status).toBe(403)
			const data = await found({ phone: '0111' }, manager)
			expect(data.results.map((order) => order.id)).toEqual([id])
			// Ids and timestamps can contain the same digit runs by chance (a random
			// id did, once): only the words of the result are checked.
			expect(
				JSON.stringify(data.results, (key, value) =>
					key === 'id' || typeof value === 'number' ? undefined : value,
				),
			).not.toMatch(/555|0111/)
			// Exactly the four digits the masked phone shows: no fewer (a sweep),
			// no more (rebuilding the number digit by digit).
			expect((await search({ phone: '11' }, manager)).status).toBe(400)
			expect((await search({ phone: '30111' }, manager)).status).toBe(400)
			const db = await getTenantDb(ORG_A)
			const recorded = await db
				.select()
				.from(posOnlineOrderEvents)
				.where(eq(posOnlineOrderEvents.action, 'phone_searched'))
			expect(recorded).toHaveLength(1)
			expect(recorded[0]).toMatchObject({
				staffId: managerId,
				orderId: 'search',
			})
		})

		it('limits how many phone searches one person may run in an hour', async () => {
			const db = await getTenantDb(ORG_A)
			await db.insert(posOnlineOrderEvents).values(
				Array.from({ length: PHONE_SEARCHES_PER_HOUR }, () => ({
					orderId: 'search',
					locationId: LOCATION,
					deviceId,
					staffId: managerId,
					action: 'phone_searched' as const,
					at: Date.now() - 60_000,
				})),
			)
			const limited = await search({ phone: '0111' }, manager)
			expect(limited.status).toBe(429)
			expect(await limited.json()).toMatchObject({ error: 'search_limit' })
		})

		it('asks for one of text or phone, and never reaches further back than eight days', async () => {
			expect((await search({})).status).toBe(400)
			expect((await search({ q: 'w', phone: '1234' }, manager)).status).toBe(
				400,
			)
			const nineDays = new Date(Date.now() - 9 * 86_400_000)
			await insertOrder({
				number: 'W-OLD',
				status: 'completed',
				createdAt: nineDays,
				completedAt: nineDays,
			})
			const data = await found({ q: 'w-old', since: '0' })
			expect(data.results).toHaveLength(0)
			expect(data.since).toBeGreaterThan(Date.now() - 8 * 86_400_000 - 60_000)
			// Still open (placed long ago for pickup now): in the inbox, so found.
			const open = await insertOrder({ number: 'W-LATER', createdAt: nineDays })
			expect(
				(await found({ q: 'w-later' })).results.map((order) => order.id),
			).toEqual([open])
		})

		it('caps the results and says so', async () => {
			for (let index = 0; index < POS_ONLINE_ORDERS_SEARCH_LIMIT + 2; index++)
				await insertOrder({ number: `W-${index}` })
			const data = await found({ q: 'w-' })
			expect(data.results).toHaveLength(POS_ONLINE_ORDERS_SEARCH_LIMIT)
			expect(data.truncated).toBe(true)
		})

		it('keeps device, switch and staff-session checks', async () => {
			expect((await search({ q: 'w' }, null as never)).status).toBe(401)
			const db = await getTenantDb(ORG_A)
			await db
				.update(posDevices)
				.set({ ordersEnabled: false })
				.where(eq(posDevices.id, deviceId))
			expect((await search({ q: 'w' })).status).toBe(403)
		})
	})

	it('limits how many contacts one person may reveal in an hour', async () => {
		const db = await getTenantDb(ORG_A)
		await db
			.insert(posHosts)
			.values({ staffId: cashierId, guestDetails: true, addedBy: 'operator' })
		const id = await insertOrder()
		await db.insert(posOnlineOrderEvents).values(
			Array.from({ length: 30 }, () => ({
				orderId: id,
				locationId: LOCATION,
				deviceId,
				staffId: cashierId,
				action: 'contact_viewed' as const,
				at: Date.now() - 60_000,
			})),
		)
		const limited = await call('POST', `/${id}/contact`)
		expect(limited.status).toBe(429)
		expect(await limited.json()).toMatchObject({ error: 'contact_limit' })
		// Someone else still can.
		expect(
			(await call('POST', `/${id}/contact`, { staff: manager })).status,
		).toBe(200)
	})

	describe('summary keys', () => {
		it('leaves a key out while it holds its default', async () => {
			const id = await insertOrder()
			const data = await feed()
			for (const order of data.orders) {
				expect(order).not.toHaveProperty('refundStatus')
				expect(order).not.toHaveProperty('refundPendingCents')
				expect(order).not.toHaveProperty('disputed')
				expect(order).not.toHaveProperty('acceptanceDeadlineAt')
				expect(order).not.toHaveProperty('rejectedReason')
			}
			expect((await detail(id)).order).not.toHaveProperty('disputed')
		})

		it('sends a key once it differs from its default', async () => {
			await insertOrder({ disputeStatus: 'open' })
			const [order] = (await feed()).orders
			expect(order).toMatchObject({ disputed: true })
		})
	})

	describe('manual acceptance (#107)', () => {
		const waiting = (
			values: Partial<typeof restaurantOrders.$inferInsert> = {},
		) =>
			insertOrder({
				status: 'pending_acceptance',
				acceptanceDeadlineAt: new Date(Date.now() + 5 * 60_000),
				...values,
			})

		it('lists a waiting order first, with its deadline; others keep their shape', async () => {
			const open = await insertOrder({ number: 'W-1' })
			const id = await waiting({ number: 'W-2' })
			const data = await feed()
			expect(data.orders.map((order) => order.id)).toEqual([id, open])
			const [first, second] = data.orders
			expect(first).toMatchObject({
				status: 'pending_acceptance',
				acceptanceDeadlineAt: expect.any(Number),
			})
			expect(second).not.toHaveProperty('acceptanceDeadlineAt')
			expect(second).not.toHaveProperty('rejectedReason')
			const found = await call('GET', '/search?q=W-2&state=open')
			expect(found.status).toBe(200)
			expect(
				((await found.json()) as PosOnlineOrdersSearch).results.map(
					(order) => order.id,
				),
			).toEqual([id])
		})

		it('accepts for anyone signed in, with the version, once; the kitchen then shows it', async () => {
			const id = await waiting()
			const seen = (await detail(id)).order
			const response = await command(id, {
				action: 'accept',
				expectedVersion: seen.version,
			})
			expect(response.status).toBe(200)
			const answer = (await response.json()) as PosOnlineOrderDetailResponse
			expect(answer.order.status).toBe('accepted')
			expect(answer.order.history[0]).toMatchObject({
				action: 'accepted',
				staffName: 'Sam S.',
			})
			const db = await getTenantDb(ORG_A)
			const [order] = await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, id))
			expect(order?.acceptedAt).not.toBeNull()
			// A second screen with the old version loses.
			const again = await command(id, {
				action: 'accept',
				expectedVersion: seen.version,
			})
			expect(again.status).toBe(409)
			expect(await again.json()).toMatchObject({ error: 'stale_version' })
			const kitchen = await app.request('/pos/kds', {
				headers: {
					Authorization: `Bearer ${secret}`,
					[POS_STAFF_SESSION_HEADER]: cashier,
				},
			})
			expect(kitchen.status).toBe(200)
			expect(
				(
					(await kitchen.json()) as { tickets: Array<{ id: string }> }
				).tickets.map((ticket) => ticket.id),
			).toContain(id)
		})

		it('rejects for a manager only, refunding a paid online order in full', async () => {
			const id = await waiting()
			const version = (await detail(id)).order.version
			const body = {
				action: 'reject',
				expectedVersion: version,
				reason: 'out_of_stock',
			}
			expect((await command(id, body)).status).toBe(403)
			const response = await command(id, body, manager)
			expect(response.status).toBe(200)
			const answer = (await response.json()) as PosOnlineOrderDetailResponse
			expect(answer.refundOutcome).toEqual({ started: true, code: null })
			expect(answer.order).toMatchObject({
				status: 'cancelled',
				rejectedReason: 'out_of_stock',
				refundStatus: 'pending',
				refundPendingCents: 1500,
			})
			expect(answer.order.history[0]).toMatchObject({
				action: 'rejected',
				reason: 'out_of_stock',
			})
			const db = await getTenantDb(ORG_A)
			const [order] = await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, id))
			expect(order).toMatchObject({
				rejectedReason: 'out_of_stock',
				cancelReason: 'out_of_stock',
				cancelledBy: 'operator',
			})
			const [row] = await db
				.select()
				.from(restaurantOrderRefunds)
				.where(eq(restaurantOrderRefunds.orderId, id))
			expect(row).toMatchObject({
				origin: 'station',
				actorId: `staff:${managerId}`,
				amountCents: 1500,
				status: 'pending',
			})
			await orderRefundKicksIdle()
			expect(kicks).toEqual([{ orgId: ORG_A, refundId: row!.id }])

			// Too late to accept it now.
			const accept = await command(id, {
				action: 'accept',
				expectedVersion: answer.order.version,
			})
			expect(accept.status).toBe(409)
			expect(await accept.json()).toMatchObject({ error: 'order_not_pending' })
		})

		it('answers 409 order_not_pending to a plain cancel of a waiting order: only reject turns it down', async () => {
			const id = await waiting()
			const version = (await detail(id)).order.version
			for (const body of [
				{ action: 'cancel', expectedVersion: version, reason: 'guest_request' },
				{
					action: 'cancel',
					expectedVersion: version,
					reason: 'other',
					refund: 'none',
				},
			]) {
				const response = await command(id, body, manager)
				expect(response.status).toBe(409)
				expect(await response.json()).toMatchObject({
					error: 'order_not_pending',
				})
			}
			const db = await getTenantDb(ORG_A)
			const [order] = await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, id))
			expect(order).toMatchObject({
				status: 'pending_acceptance',
				rejectedReason: null,
				cancelReason: null,
			})
			expect(
				await db
					.select()
					.from(restaurantOrderRefunds)
					.where(eq(restaurantOrderRefunds.orderId, id)),
			).toEqual([])
		})

		it('refuses reject reasons outside the list, and a reject once it was accepted', async () => {
			const id = await insertOrder({
				acceptanceDeadlineAt: new Date(Date.now() + 5 * 60_000),
				acceptedAt: new Date(),
			})
			const version = (await detail(id)).order.version
			expect(
				(
					await command(
						id,
						{
							action: 'reject',
							expectedVersion: version,
							reason: 'guest_request',
						},
						manager,
					)
				).status,
			).toBe(400)
			const reject = await command(
				id,
				{ action: 'reject', expectedVersion: version, reason: 'too_busy' },
				manager,
			)
			expect(reject.status).toBe(409)
			expect(await reject.json()).toMatchObject({ error: 'order_not_pending' })
		})
	})

	it('records reprints without changing the order', async () => {
		const id = await insertOrder()
		const before = (await detail(id)).order.version
		const response = await command(id, { action: 'reprint', ticket: 'kitchen' })
		expect(response.status).toBe(200)
		const after = ((await response.json()) as PosOnlineOrderDetailResponse)
			.order
		expect(after.version).toBe(before)
		expect(after.history[0]).toMatchObject({
			action: 'reprinted',
			reason: 'kitchen',
		})
	})

	it('sends a reprint to a cloud printer at the location, and tells the tablet not to print itself (#117)', async () => {
		// The order context is not reachable here: nothing may leave the process.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('no', { status: 404 })),
		)
		const db = await getTenantDb(ORG_A)
		const id = await insertOrder()
		// No printer: the tablet prints, as it always did.
		const plain = (await (
			await command(id, { action: 'reprint', ticket: 'guest' })
		).json()) as PosOnlineOrderDetailResponse
		expect(plain.cloudPrinted).toBeUndefined()
		expect(plain.order.cloudPrinters).toBeUndefined()
		seedPrintingFlagForTest(ORG_A, true)
		await createPrinter(
			db,
			ORG_A,
			{
				locationId: LOCATION,
				name: 'Pass',
				protocol: 'star_cloudprnt',
				widthMm: 80,
				copies: 1,
				routes: {
					kitchen: 'all',
					stationIds: [],
					receipts: true,
					isDefault: false,
					deliveryAddress: false,
					arabicFont: false,
				},
			},
			'operator',
		)
		const printed = (await (
			await command(id, { action: 'reprint', ticket: 'kitchen' })
		).json()) as PosOnlineOrderDetailResponse
		expect(printed.cloudPrinted).toBe(true)
		expect(printed.order.cloudPrinters).toBe(true)
		expect(await db.select().from(printJobs)).toHaveLength(1)
		vi.unstubAllGlobals()
	})

	describe('security', () => {
		it('refuses a forged device, another organization, a revoked terminal and the kill switch', async () => {
			const forged = formatPosDeviceSecret(ORG_A, deviceId, 'y'.repeat(43))
			expect((await call('GET', '', { token: forged })).status).toBe(401)
			expect(
				(await call('GET', '', { token: secret.replace(ORG_A, ORG_B) })).status,
			).toBe(401)
			const db = await getTenantDb(ORG_A)
			await db
				.update(posDevices)
				.set({ revokedAt: Date.now() })
				.where(eq(posDevices.id, deviceId))
			const revoked = await call('GET', '')
			expect(revoked.status).toBe(401)
			expect(await revoked.json()).toMatchObject({ error: 'device_revoked' })
			vi.stubEnv('POS_ENABLED', 'false')
			expect((await call('GET', '', { token: otherSecret })).status).toBe(503)
		})

		it('refuses a terminal with the app switched off, without sign-in, or without a location', async () => {
			const db = await getTenantDb(ORG_A)
			const id = await insertOrder()
			await db
				.update(posDevices)
				.set({ ordersEnabled: false })
				.where(eq(posDevices.id, deviceId))
			for (const [method, suffix, body] of [
				['GET', '', undefined],
				['GET', `/${id}`, undefined],
				['POST', `/${id}/command`, { action: 'open' }],
				['POST', `/${id}/contact`, undefined],
			] as const) {
				const response = await call(method, suffix, { body })
				expect(response.status, `${method} ${suffix}`).toBe(403)
				expect(await response.json()).toMatchObject({
					error: 'orders_not_enabled',
				})
			}
			await db
				.update(posDevices)
				.set({ ordersEnabled: true, signInRequired: false })
				.where(eq(posDevices.id, deviceId))
			expect(await (await call('GET', '')).json()).toMatchObject({
				error: 'orders_needs_sign_in',
			})
			await db
				.update(posDevices)
				.set({ signInRequired: true, locationId: null })
				.where(eq(posDevices.id, deviceId))
			expect(await (await call('GET', '')).json()).toMatchObject({
				error: 'orders_needs_location',
			})
		})

		it('requires a current staff session bound to this terminal', async () => {
			expect((await call('GET', '', { staff: null })).status).toBe(401)
			const elsewhere = await session(
				cashierId,
				(await feedDeviceId(otherSecret))!,
			)
			expect((await call('GET', '', { staff: elsewhere })).status).toBe(401)
			const db = await getTenantDb(ORG_A)
			await db
				.update(staffScopeAssignments)
				.set({ active: false })
				.where(eq(staffScopeAssignments.staffId, cashierId))
			expect((await call('GET', '')).status).toBe(401)
		})

		it('never reaches another location’s order, whatever the action', async () => {
			const id = await insertOrder({ locationId: 'elsewhere' })
			const version = 'a'.repeat(64)
			for (const [suffix, body, staff] of [
				[`/${id}`, undefined, manager],
				[`/${id}/command`, { action: 'open' }, manager],
				[
					`/${id}/command`,
					{ action: 'ready', expectedVersion: version },
					manager,
				],
				[
					`/${id}/command`,
					{ action: 'cancel', expectedVersion: version, reason: 'other' },
					manager,
				],
				[`/${id}/contact`, undefined, manager],
			] as const) {
				const response = await call(
					body || suffix.endsWith('contact') ? 'POST' : 'GET',
					suffix,
					{
						body,
						staff,
					},
				)
				expect(response.status, suffix).toBe(404)
			}
			expect(
				(
					await refund(id, {
						expectedVersion: version,
						full: true,
						note: 'Whole order',
					})
				).status,
			).toBe(404)
			const db = await getTenantDb(ORG_A)
			const [row] = await db
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, id))
			expect(row).toMatchObject({ status: 'accepted', refundedCents: 0 })
		})

		it('refuses each grant the person lacks: cancel, refund and contact for a cashier', async () => {
			const id = await insertOrder({
				status: 'completed',
				completedAt: new Date(),
			})
			const version = (await detail(id)).order.version
			for (const response of [
				await command(id, {
					action: 'cancel',
					expectedVersion: version,
					reason: 'other',
				}),
				await refund(
					id,
					{ expectedVersion: version, full: true, note: 'Whole order' },
					cashier,
				),
				await call('POST', `/${id}/contact`),
			])
				expect(response.status).toBe(403)
		})

		it('keeps the history append-only', async () => {
			const id = await insertOrder()
			await command(id, { action: 'open' })
			const db = await getTenantDb(ORG_A)
			await expect(
				db.update(posOnlineOrderEvents).set({ staffId: null }),
			).rejects.toThrow()
			await expect(db.delete(posOnlineOrderEvents)).rejects.toThrow()
		})
	})
})
