import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type PosOnlineOrderDetailResponse,
	type PosOnlineOrdersFeed,
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
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
	staffMembers,
	staffScopeAssignments,
} from '@repo/tenant-db'
import { ORG_A, ORG_B, stubStaffEnv } from '../../tests/staff-harness.ts'
import { hashPosSecret } from '../lib/pos-auth.ts'
import { mintPosStaffSession } from '../lib/pos-staff-session.ts'
import { reconcileLoyaltySource } from '../services/loyalty-purchase-service.ts'
import {
	activateProgram,
	claimAndQueue,
	insertCustomer,
	makeMember,
	NOW,
} from '../services/loyalty-test-fixture.ts'
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

	beforeEach(async () => {
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

	it('records partial and full refunds for a manager, never past what was paid', async () => {
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
		expect(seen).toMatchObject({ refundedCents: 500, refundableCents: 1000 })
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

	it('reaches only what the inbox shows: an order finished hours ago is the App’s', async () => {
		const old = new Date(Date.now() - 5 * 3_600_000)
		const id = await insertOrder({ status: 'completed', completedAt: old })
		const db = await getTenantDb(ORG_A)
		await db
			.insert(posHosts)
			.values({ staffId: cashierId, guestDetails: true, addedBy: 'operator' })
		expect((await call('GET', `/${id}`)).status).toBe(404)
		expect((await call('POST', `/${id}/contact`)).status).toBe(404)
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
