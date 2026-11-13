import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type KdsFeed } from '@repo/common/kds'
import { formatPosDeviceSecret } from '@repo/common/pos-orders'
import { type RestaurantOrderContext } from '@repo/common/restaurant-orders'
import {
	destroyTenantDb,
	getTenantDb,
	posDevices,
	posOrders,
	provisionTenantDb,
} from '@repo/tenant-db'
import { ORG_A, stubStaffEnv } from '../../tests/staff-harness.ts'
import { hashPosSecret } from '../lib/pos-auth.ts'
import {
	READY_TEXT_DAILY_LIMIT,
	sendReadyTextIfDue,
} from '../services/pos-ready-text-service.ts'
import { posKdsRoutes } from './pos-kds.ts'

const sms = vi.hoisted(() => ({ send: vi.fn(async () => undefined) }))
vi.mock('@repo/sms', () => ({ sendSms: sms.send }))

const context = vi.hoisted(() => ({ readyText: true, reachable: true }))
vi.mock('../services/order-service.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../services/order-service.ts')>()
	return {
		...actual,
		fetchOrderContext: async (orgId: string) =>
			context.reachable
				? {
						ok: true,
						data: {
							orgId,
							dataRegion: 'us',
							menu: {
								organization: {
									id: orgId,
									name: 'Cafe Luna',
									slug: 'luna',
									currency: 'USD',
								},
								locations: [
									{ id: 'loc-1', name: 'Main', readyText: context.readyText },
								],
								menus: [],
							},
						} as unknown as RestaurantOrderContext,
					}
				: { ok: false, status: 503, code: 'ordering_unavailable' },
	}
})

describe('ready texts for counter and phone orders (#250)', () => {
	let dir: string
	const app = new Hono().route('/pos/kds', posKdsRoutes)
	let secret: string
	let deviceId: string

	async function addOrder(
		values: Partial<typeof posOrders.$inferInsert> = {},
	): Promise<string> {
		const db = await getTenantDb(ORG_A)
		const id = crypto.randomUUID()
		await db.insert(posOrders).values({
			id,
			deviceId,
			number: 'T1-0042',
			businessDate: '2026-11-13',
			revision: 1,
			status: 'paid',
			orderType: 'takeaway',
			locationId: 'loc-1',
			readyTextPhone: '+15551234567',
			currency: 'USD',
			subtotalCents: 900,
			taxCents: 0,
			totalCents: 900,
			lines: [
				{
					id: crypto.randomUUID(),
					itemId: 'soup',
					name: 'Soup',
					quantity: 1,
					instructions: null,
					options: [],
				},
			],
			adjustments: [],
			rungUpAt: Date.now(),
			...values,
		})
		return id
	}

	async function command(body: Record<string, unknown>) {
		return app.request('/pos/kds/command', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${secret}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})
	}
	async function ticketOf(orderId: string) {
		const response = await app.request('/pos/kds', {
			headers: { Authorization: `Bearer ${secret}` },
		})
		const feed = (await response.json()) as KdsFeed
		return feed.tickets.find((ticket) => ticket.id === orderId)!
	}
	async function stage(orderId: string, value: 'preparing' | 'ready') {
		const ticket = await ticketOf(orderId)
		const response = await command({
			source: 'pos',
			orderId,
			expectedVersion: ticket.version,
			action: 'stage',
			stage: value,
		})
		expect(response.status).toBe(200)
	}
	async function row(orderId: string) {
		const db = await getTenantDb(ORG_A)
		const [found] = await db
			.select()
			.from(posOrders)
			.where(eq(posOrders.id, orderId))
		return found!
	}
	/** The text goes out after the kitchen's answer: wait for its outcome. */
	async function settled(orderId: string) {
		await vi.waitFor(async () =>
			expect((await row(orderId)).readyTextStatus).not.toBeNull(),
		)
		// A failed send updates the row once more; let it land.
		await new Promise((resolve) => setTimeout(resolve, 20))
		return row(orderId)
	}

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-text-'))
		stubStaffEnv(dir)
		vi.stubEnv('POS_ENABLED', '')
		sms.send.mockReset()
		sms.send.mockResolvedValue(undefined)
		context.readyText = true
		context.reachable = true
		await provisionTenantDb(ORG_A)
		const db = await getTenantDb(ORG_A)
		deviceId = crypto.randomUUID()
		secret = formatPosDeviceSecret(ORG_A, deviceId, 'x'.repeat(43))
		await db.insert(posDevices).values({
			id: deviceId,
			label: 'Kitchen',
			terminalCode: 'K1',
			locationId: 'loc-1',
			secretHash: hashPosSecret(secret),
			pairedBy: 'operator',
		})
	})
	afterEach(async () => {
		await destroyTenantDb(ORG_A)
		fs.rmSync(dir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('texts once when the whole ticket becomes Ready, with the order number and restaurant only', async () => {
		const id = await addOrder()
		await stage(id, 'preparing')
		expect(sms.send).not.toHaveBeenCalled()
		await stage(id, 'ready')
		const after = await settled(id)
		expect(sms.send).toHaveBeenCalledTimes(1)
		expect(sms.send).toHaveBeenCalledWith({
			to: '+15551234567',
			message: 'Your order #T1-0042 at Cafe Luna is ready for pickup.',
		})
		expect(after.readyTextStatus).toBe('sent')
		expect(after.readyTextAt).toEqual(expect.any(Number))
		// The kitchen feed never carries the number.
		const feed = await (
			await app.request('/pos/kds', {
				headers: { Authorization: `Bearer ${secret}` },
			})
		).text()
		expect(feed).not.toContain('5551234567')
	})

	it('reopening and re-readying the ticket sends nothing more', async () => {
		const id = await addOrder()
		await stage(id, 'ready')
		await settled(id)
		await stage(id, 'preparing')
		await stage(id, 'ready')
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(sms.send).toHaveBeenCalledTimes(1)
		// Two kitchens racing for the same order send one text.
		const other = await addOrder({ number: 'T1-0043' })
		const db = await getTenantDb(ORG_A)
		await Promise.all([
			sendReadyTextIfDue(db, { orgId: ORG_A, orderId: other }),
			sendReadyTextIfDue(db, { orgId: ORG_A, orderId: other }),
		])
		expect(sms.send).toHaveBeenCalledTimes(2)
	})

	it('sends nothing without a number, for a cancelled order, or with the switch off', async () => {
		const noNumber = await addOrder({ readyTextPhone: null })
		const cancelled = await addOrder({ number: 'T1-0050', status: 'void' })
		await stage(noNumber, 'ready')
		// A voided order leaves the kitchen screen; asked directly, it sends nothing.
		const db = await getTenantDb(ORG_A)
		expect(
			await sendReadyTextIfDue(db, { orgId: ORG_A, orderId: cancelled }),
		).toBe('skipped')
		context.readyText = false
		const switchedOff = await addOrder({ number: 'T1-0051' })
		await stage(switchedOff, 'ready')
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(sms.send).not.toHaveBeenCalled()
		for (const id of [noNumber, cancelled, switchedOff])
			expect((await row(id)).readyTextStatus).toBeNull()
	})

	it('leaves the text untried while the App cannot be reached, and sends it at the next Ready', async () => {
		context.reachable = false
		const id = await addOrder()
		const db = await getTenantDb(ORG_A)
		expect(await sendReadyTextIfDue(db, { orgId: ORG_A, orderId: id })).toBe(
			'skipped',
		)
		context.reachable = true
		expect(await sendReadyTextIfDue(db, { orgId: ORG_A, orderId: id })).toBe(
			'sent',
		)
	})

	it('texts a phone order on its callback number', async () => {
		const id = await addOrder({
			orderSource: 'phone',
			readyTextPhone: null,
			customerPhone: '(555) 987-6543',
			guestName: 'Sam',
		})
		await stage(id, 'ready')
		await settled(id)
		expect(sms.send).toHaveBeenCalledWith(
			expect.objectContaining({ to: '+15559876543' }),
		)
	})

	it('over the daily organization cap: no text, the ticket still moves on, and the order records the limit', async () => {
		const db = await getTenantDb(ORG_A)
		const now = Date.now()
		for (let i = 0; i < READY_TEXT_DAILY_LIMIT; i += 1)
			await db.insert(posOrders).values({
				id: crypto.randomUUID(),
				deviceId,
				number: `T9-${i}`,
				businessDate: '2026-11-13',
				revision: 1,
				status: 'paid',
				orderType: 'takeaway',
				locationId: 'loc-1',
				currency: 'USD',
				subtotalCents: 1,
				taxCents: 0,
				totalCents: 1,
				lines: [],
				adjustments: [],
				rungUpAt: now,
				readyTextStatus: 'sent',
				readyTextAt: now - 60_000,
			})
		const id = await addOrder()
		await stage(id, 'ready')
		expect((await settled(id)).readyTextStatus).toBe('limit')
		expect(sms.send).not.toHaveBeenCalled()
		expect(
			(await ticketOf(id)).lines.every((line) => line.stage === 'ready'),
		).toBe(true)
	})

	it('records a failed send once, and never retries it', async () => {
		sms.send.mockRejectedValueOnce(new Error('provider down'))
		const id = await addOrder()
		await stage(id, 'ready')
		await vi.waitFor(async () =>
			expect((await row(id)).readyTextStatus).toBe('failed'),
		)
		const db = await getTenantDb(ORG_A)
		expect(await sendReadyTextIfDue(db, { orgId: ORG_A, orderId: id })).toBe(
			'skipped',
		)
		expect(sms.send).toHaveBeenCalledTimes(1)
	})

	it('a node without an SMS route (KSA) sends nothing and records it as unavailable', async () => {
		vi.stubEnv('DATA_REGION', 'ksa')
		const id = await addOrder()
		const db = await getTenantDb(ORG_A)
		expect(await sendReadyTextIfDue(db, { orgId: ORG_A, orderId: id })).toBe(
			'unavailable',
		)
		expect(sms.send).not.toHaveBeenCalled()
		expect((await row(id)).readyTextStatus).toBe('unavailable')
	})
})
