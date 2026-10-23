import 'fake-indexeddb/auto'
import { posOrderRequestSchema } from '@repo/common/pos-orders'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useClock } from './clock.ts'
import { type PosSettings } from './config.ts'
import { db } from './db.ts'
import {
	addPayment,
	createOrder,
	requeueRejected,
	updateTab,
	voidTab,
	type OrderDraft,
} from './orders.ts'
import {
	backoffFor,
	checkDevice,
	classifyRefusal,
	flushOutbox,
	toWireOrder,
} from './outbox.ts'
import { type CartLine } from './pricing.ts'
import {
	closeShift,
	rejectedShifts,
	requeueRejectedShifts,
	startShift,
} from './shifts.ts'

const MISTAKE = { reason: 'mistake' as const, by: null, approvedBy: null }

const settings: PosSettings = {
	appUrl: 'https://app.test',
	slug: 'demo',
	tenantApiUrl: 'https://api.test',
	terminalCode: 'T1',
	locationId: 'loc-1',
	locationLocked: false,
	scopeId: 'main',
	signInRequired: false,
	dayStartMinutes: 0,
	shiftsRequired: false,
	idleLockSeconds: 120,
	deviceToken: 'device-secret',
	deviceLabel: 'Front counter',
	demo: false,
	locale: null,
	apps: { timeclock: false, reservations: false },
	activeApp: 'pos',
}

const line: CartLine = {
	id: 'l1',
	itemId: 'burger',
	name: 'Burger',
	variantId: null,
	variantLabel: null,
	quantity: 2,
	baseCents: 1000,
	instructions: 'no onion',
	options: [
		{
			groupId: 'g',
			groupName: 'Extras',
			optionId: 'cheese',
			optionName: 'Cheese',
			quantity: 1,
			unitCents: 150,
			taxable: true,
		},
	],
}

const input: OrderDraft = {
	terminalCode: 'T1',
	locationId: 'loc-1',
	currency: 'USD',
	taxRatePercent: 10,
	orderType: 'dine_in',
	customerName: '',
	tableLabel: '12',
	lines: [line],
	adjustments: [],
	tipCents: 0,
}
const pay = {
	method: 'cash',
	amountCents: 2530,
	tenderedCents: 3000,
	changeCents: 470,
} as const
const place = () => createOrder(input, pay)

const respond = (status: number, body: unknown = {}) =>
	vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))

beforeEach(async () => {
	await db.orders.clear()
	await db.meta.clear()
	await db.shifts.clear()
	useClock.setState({ skewMs: null })
	vi.restoreAllMocks()
})

describe('createOrder', () => {
	it('numbers orders sequentially and stores them pending', async () => {
		const a = await place()
		const b = await place()
		expect([a.number, b.number]).toEqual(['T1-0001', 'T1-0002'])
		expect(a.sync).toBe('pending')
		expect(a.status).toBe('paid')
		expect(a.totals.totalCents).toBe(2530)
	})

	it('never allocates the same number to concurrent orders', async () => {
		const orders = await Promise.all([place(), place(), place(), place()])
		expect(new Set(orders.map((o) => o.number)).size).toBe(4)
	})

	it('rejects an empty order', async () => {
		await expect(createOrder({ ...input, lines: [] })).rejects.toThrow(
			'empty order',
		)
	})
})

describe('flushOutbox', () => {
	it('uploads with an idempotency key and marks the order synced', async () => {
		const order = await place()
		const fetchMock = respond(201, { order: { number: 'T1-0001' } })
		vi.stubGlobal('fetch', fetchMock)
		expect(await flushOutbox(settings)).toBe(1)
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe('https://api.test/pos/orders')
		expect(init.headers['Idempotency-Key']).toBe(order.id)
		expect(init.headers.Authorization).toBe('Bearer device-secret')
		expect((await db.orders.get(order.id))!).toMatchObject({
			sync: 'synced',
			serverNumber: null,
		})
	})

	it('keeps the order and backs off when the server is down', async () => {
		const order = await place()
		vi.stubGlobal('fetch', respond(503))
		expect(await flushOutbox(settings)).toBe(0)
		const row = (await db.orders.get(order.id))!
		expect(row.sync).toBe('pending')
		expect(row.attempts).toBe(1)
		expect(row.nextAttemptAt).toBeGreaterThan(Date.now())
		// Not due yet, so a second flush does not call the network.
		const again = respond(201)
		vi.stubGlobal('fetch', again)
		await flushOutbox(settings)
		expect(again).not.toHaveBeenCalled()
	})

	it('"send now" (force) tries an order that is still inside its backoff; a normal flush does not', async () => {
		const order = await place()
		vi.stubGlobal('fetch', respond(503))
		await flushOutbox(settings)
		expect((await db.orders.get(order.id))!.nextAttemptAt).toBeGreaterThan(
			Date.now(),
		)
		const quiet = respond(201)
		vi.stubGlobal('fetch', quiet)
		expect(await flushOutbox(settings)).toBe(0)
		expect(quiet).not.toHaveBeenCalled()
		expect(await flushOutbox(settings, { force: true })).toBe(1)
		expect((await db.orders.get(order.id))!.sync).toBe('synced')
	})

	it('stops at the first network failure instead of hammering the queue', async () => {
		await place()
		await place()
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new TypeError('Failed to fetch'))
		vi.stubGlobal('fetch', fetchMock)
		await flushOutbox(settings)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('marks a validation rejection as refused and does not retry it', async () => {
		const order = await place()
		vi.stubGlobal(
			'fetch',
			respond(422, {
				error: 'invalid_request',
				message: 'Item is no longer on the menu',
			}),
		)
		await flushOutbox(settings)
		expect(await db.orders.get(order.id)).toMatchObject({
			sync: 'rejected',
			lastError: 'Item is no longer on the menu',
		})
		const again = respond(201)
		vi.stubGlobal('fetch', again)
		await flushOutbox(settings)
		expect(again).not.toHaveBeenCalled()
	})

	it('retries auth and throttle failures rather than discarding the order', async () => {
		for (const status of [401, 403, 429]) {
			await db.orders.clear()
			const order = await place()
			vi.stubGlobal('fetch', respond(status))
			await flushOutbox(settings)
			expect((await db.orders.get(order.id))!.sync).toBe('pending')
		}
	})

	it('waits quietly when the terminal is not paired', async () => {
		const order = await place()
		const fetchMock = respond(201)
		vi.stubGlobal('fetch', fetchMock)
		await flushOutbox({ ...settings, deviceToken: null })
		expect(fetchMock).not.toHaveBeenCalled()
		// Waiting to be paired is not a failure: no attempt counted, no backoff.
		expect(await db.orders.get(order.id)).toMatchObject({
			lastError: 'Terminal is not paired yet',
			attempts: 0,
			nextAttemptAt: 0,
			sync: 'pending',
		})
		// So the very next flush after pairing sends it, without "force".
		vi.stubGlobal('fetch', respond(201, { order: {} }))
		expect(await flushOutbox(settings)).toBe(1)
	})

	it('recovers an order left syncing by a crashed tab', async () => {
		const order = await place()
		await db.orders.update(order.id, {
			sync: 'syncing',
			nextAttemptAt: Date.now() - 5 * 60_000,
		})
		vi.stubGlobal('fetch', respond(201))
		expect(await flushOutbox(settings)).toBe(1)
		expect((await db.orders.get(order.id))!.sync).toBe('synced')
	})

	it('leaves a recent in-flight upload alone but reclaims one older than any live request could be', async () => {
		const fresh = await place()
		const abandoned = await place()
		await db.orders.update(fresh.id, {
			sync: 'syncing',
			nextAttemptAt: Date.now() - 5_000,
		})
		await db.orders.update(abandoned.id, {
			sync: 'syncing',
			nextAttemptAt: Date.now() - 25_000,
		})
		vi.stubGlobal('fetch', respond(201))
		expect(await flushOutbox(settings)).toBe(1)
		expect((await db.orders.get(abandoned.id))!.sync).toBe('synced')
		expect((await db.orders.get(fresh.id))!.sync).toBe('syncing')
	})

	it('records a server-assigned number that differs from the local one', async () => {
		const order = await place()
		vi.stubGlobal('fetch', respond(201, { order: { number: 'D-90017' } }))
		await flushOutbox(settings)
		expect((await db.orders.get(order.id))!.serverNumber).toBe('D-90017')
	})
})

describe('revisions', () => {
	it('does not mark a newer revision synced when an older one finishes uploading', async () => {
		const tab = await createOrder(input)
		let release!: () => void
		const gate = new Promise<void>((r) => (release = r))
		const revisions: number[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (_u: string, init: { body: string }) => {
				revisions.push(JSON.parse(init.body).revision)
				if (revisions.length === 1) {
					await gate
					return new Response('{}', { status: 201 })
				}
				// Revision 2 cannot get through, so its row must still be waiting.
				return new Response('{}', { status: 503 })
			}),
		)
		const flushing = flushOutbox(settings)
		await vi.waitFor(async () =>
			expect((await db.orders.get(tab.id))!.sync).toBe('syncing'),
		)
		// The guest adds a dish while revision 1 is still on the wire.
		await updateTab(tab.id, { ...input, lines: [{ ...line, quantity: 3 }] })
		release()
		await flushing
		expect(revisions).toEqual([1, 2])
		const row = (await db.orders.get(tab.id))!
		expect(row.revision).toBe(2)
		expect(row.sync).toBe('pending')
	})

	it('sends each revision, with status and payments, after it changes', async () => {
		const tab = await createOrder(input)
		const bodies: Array<{
			revision: number
			status: string
			payments: unknown[]
		}> = []
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async (_u: string, init: { body: string }) => {
				bodies.push(JSON.parse(init.body))
				return new Response('{}', { status: 201 })
			}),
		)
		await flushOutbox(settings)
		await addPayment(tab.id, pay)
		await flushOutbox(settings)
		expect(
			bodies.map((b) => [b.revision, b.status, b.payments.length]),
		).toEqual([
			[1, 'open', 0],
			[2, 'paid', 1],
		])
	})
})

describe('wire format', () => {
	it('is a snapshot of what was rung up: names, cents and choices', async () => {
		const wire = toWireOrder(await place())
		expect(wire.lines[0]).toEqual({
			itemId: 'burger',
			name: 'Burger',
			variantId: null,
			variantLabel: null,
			quantity: 2,
			baseCents: 1000,
			instructions: 'no onion',
			options: [
				{
					groupId: 'g',
					groupName: 'Extras',
					optionId: 'cheese',
					optionName: 'Cheese',
					quantity: 1,
					unitCents: 150,
					taxable: true,
				},
			],
		})
		expect(wire).toMatchObject({
			revision: 1,
			status: 'paid',
			number: 'T1-0001',
			tableLabel: '12',
			customerName: null,
		})
		expect(wire.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		// No sign-in at this terminal: the contract says so with explicit nulls.
		expect(wire).toMatchObject({ staff: null, signIn: null, voidedBy: null })
		expect(wire.payments[0]!.staff).toBeNull()
		expect(wire.totals).toEqual({
			subtotalCents: 2300,
			adjustmentCents: 0,
			taxCents: 230,
			tipCents: 0,
			totalCents: 2530,
		})
		expect(wire.payments).toHaveLength(1)
	})

	it('passes the server contract for every shape of order the till can produce', async () => {
		const shapes = [
			createOrder(input), // open tab
			createOrder(input, pay), // paid in full, with change
			createOrder(
				{
					...input,
					orderType: 'takeaway',
					customerName: 'Sam',
					tableLabel: '',
					tipCents: 300,
				},
				{
					method: 'card',
					amountCents: 2830,
					tenderedCents: 2830,
					changeCents: 0,
				},
			),
			(async () => {
				const tab = await createOrder(input)
				await addPayment(tab.id, {
					method: 'cash',
					amountCents: 1000,
					tenderedCents: 2000,
					changeCents: 1000,
				})
				return addPayment(tab.id, {
					method: 'other',
					amountCents: 1530,
					tenderedCents: 1530,
					changeCents: 0,
				})
			})(),
			(async () => {
				const tab = await createOrder(input)
				return addPayment(tab.id, {
					method: 'card',
					amountCents: 1000,
					tenderedCents: 1000,
					changeCents: 0,
				})
			})(),
			createOrder({
				...input,
				adjustments: [
					{ id: 'd1', kind: 'discount', label: '10% off', amountCents: 230 },
				],
			}),
		]
		for (const order of await Promise.all(shapes)) {
			const result = posOrderRequestSchema.safeParse(toWireOrder(order))
			expect(result.success ? 'valid' : result.error.issues).toBe('valid')
		}
	})

	it('still passes the contract after a tab is edited and then cancelled', async () => {
		const tab = await createOrder(input)
		const edited = await updateTab(tab.id, {
			...input,
			lines: [
				{ ...line, quantity: 3 },
				{
					...line,
					id: 'l2',
					itemId: 'fries',
					name: 'Fries',
					quantity: 1,
					baseCents: 450,
					options: [],
				},
			],
		})
		expect(posOrderRequestSchema.safeParse(toWireOrder(edited)).success).toBe(
			true,
		)
		await voidTab(tab.id, MISTAKE)
		const voided = (await db.orders.get(tab.id))!
		expect(voided.status).toBe('void')
		expect(posOrderRequestSchema.safeParse(toWireOrder(voided)).success).toBe(
			true,
		)
	})
})

describe('removed terminals', () => {
	it('stops, keeps every order, and reports once when the server says the terminal was removed', async () => {
		const a = await place()
		const b = await place()
		vi.stubGlobal('fetch', respond(401, { error: 'device_revoked' }))
		const onUnpaired = vi.fn()
		expect(await flushOutbox(settings, { onUnpaired })).toBe(0)
		expect(onUnpaired).toHaveBeenCalledTimes(1)
		for (const id of [a.id, b.id]) {
			expect(await db.orders.get(id)).toMatchObject({
				sync: 'pending',
				attempts: 0,
			})
		}
		// Whichever was claimed first carries the explanation.
		const errors = [
			(await db.orders.get(a.id))!.lastError,
			(await db.orders.get(b.id))!.lastError,
		]
		expect(errors.some((e) => /removed/.test(e ?? ''))).toBe(true)
	})

	it('an unrecognised secret is not a removal: nothing is wiped, orders wait, and the till is told separately', async () => {
		const order = await place()
		vi.stubGlobal('fetch', respond(401, { error: 'invalid_device' }))
		const onUnpaired = vi.fn()
		const onUnrecognised = vi.fn()
		await flushOutbox(settings, { onUnpaired, onUnrecognised })
		expect(onUnpaired).not.toHaveBeenCalled()
		expect(onUnrecognised).toHaveBeenCalledTimes(1)
		expect(await db.orders.get(order.id)).toMatchObject({
			sync: 'pending',
			attempts: 0,
		})
	})

	it('sends the waiting orders once the terminal is paired again', async () => {
		const order = await place()
		vi.stubGlobal('fetch', respond(401, { error: 'device_revoked' }))
		await flushOutbox(settings)
		vi.stubGlobal('fetch', respond(201, { order: {} }))
		expect(await flushOutbox({ ...settings, deviceToken: 'new-secret' })).toBe(
			1,
		)
		expect((await db.orders.get(order.id))!.sync).toBe('synced')
	})

	it('does not mistake other 401s (a proxy, a bad gateway) for a removed terminal', async () => {
		const order = await place()
		vi.stubGlobal('fetch', respond(401, { error: 'something_else' }))
		const onUnpaired = vi.fn()
		await flushOutbox(settings, { onUnpaired })
		expect(onUnpaired).not.toHaveBeenCalled()
		expect((await db.orders.get(order.id))!.attempts).toBe(1)
	})
})

describe('order number collisions', () => {
	const conflict = (nextNumber?: string) =>
		new Response(
			JSON.stringify({
				error: 'number_conflict',
				message: 'taken',
				...(nextNumber ? { nextNumber } : {}),
			}),
			{ status: 409 },
		)

	it('takes the number the server offers, remembers the old one, and sends again in the same pass', async () => {
		const order = await place() // T1-0001
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(conflict('T1-0007'))
			.mockResolvedValueOnce(new Response('{}', { status: 201 }))
		vi.stubGlobal('fetch', fetchMock)
		expect(await flushOutbox(settings)).toBe(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(JSON.parse(fetchMock.mock.calls[1]![1].body).number).toBe('T1-0007')
		expect(await db.orders.get(order.id)).toMatchObject({
			number: 'T1-0007',
			renumberedFrom: 'T1-0001',
			sync: 'synced',
		})
	})

	it("moves the day's counter past the new number so the next order does not collide again", async () => {
		await place()
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(conflict('T1-0007'))
				.mockResolvedValue(new Response('{}', { status: 201 })),
		)
		await flushOutbox(settings)
		expect((await place()).number).toBe('T1-0008')
	})

	it('keeps the very first number if renumbered more than once', async () => {
		const order = await place()
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValueOnce(conflict('T1-0002'))
				.mockResolvedValueOnce(conflict('T1-0003'))
				.mockResolvedValue(new Response('{}', { status: 201 })),
		)
		await flushOutbox(settings)
		expect(await db.orders.get(order.id)).toMatchObject({
			number: 'T1-0003',
			renumberedFrom: 'T1-0001',
		})
	})

	it('gives up (refused, visible) if the server keeps saying the number is taken', async () => {
		const order = await place()
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async () => conflict('T1-0099')),
		)
		await flushOutbox(settings)
		expect((await db.orders.get(order.id))!.sync).toBe('rejected')
	})

	it('does not invent a number when the server offers none', async () => {
		const order = await place()
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(conflict()))
		await flushOutbox(settings)
		expect(await db.orders.get(order.id)).toMatchObject({
			sync: 'rejected',
			number: 'T1-0001',
		})
	})
})

describe('server conflicts', () => {
	it.each([
		['order_closed', 409],
		['payments_changed', 409],
		['number_conflict', 409],
		['wrong_location', 403],
		['invalid_request', 400],
	])(
		'marks %s (%i) refused instead of retrying forever',
		async (error, status) => {
			const order = await place()
			vi.stubGlobal(
				'fetch',
				respond(status, { error, message: `server said ${error}` }),
			)
			await flushOutbox(settings)
			expect(await db.orders.get(order.id)).toMatchObject({
				sync: 'rejected',
				lastError: `server said ${error}`,
			})
		},
	)

	it('retries a bare 403 or 404 with no API body (a firewall or proxy), rather than refusing the order', async () => {
		for (const status of [403, 404, 400]) {
			await db.orders.clear()
			const order = await place()
			vi.stubGlobal(
				'fetch',
				vi
					.fn()
					.mockResolvedValue(new Response('<html>blocked</html>', { status })),
			)
			await flushOutbox(settings)
			expect((await db.orders.get(order.id))!.sync).toBe('pending')
		}
	})

	it('puts a refused order back in the queue on request, and nothing else', async () => {
		const refused = await place()
		const fine = await place()
		await db.orders.update(refused.id, {
			sync: 'rejected',
			lastError: 'x',
			attempts: 3,
		})
		await requeueRejected(refused.id)
		await requeueRejected(fine.id)
		expect(await db.orders.get(refused.id)).toMatchObject({
			sync: 'pending',
			attempts: 0,
			lastError: null,
		})
		expect((await db.orders.get(fine.id))!.sync).toBe('pending')
		await db.orders.update(fine.id, { sync: 'synced' })
		await requeueRejected(fine.id)
		expect((await db.orders.get(fine.id))!.sync).toBe('synced')
	})

	it('retries when the server cannot verify the menu yet (503)', async () => {
		const order = await place()
		vi.stubGlobal('fetch', respond(503, { error: 'verification_unavailable' }))
		await flushOutbox(settings)
		expect(await db.orders.get(order.id)).toMatchObject({
			sync: 'pending',
			attempts: 1,
		})
	})
})

describe('backoffFor', () => {
	it('grows and then caps', () => {
		expect(backoffFor(1)).toBeLessThan(backoffFor(3))
		expect(backoffFor(50)).toBe(backoffFor(6))
	})
})

describe('checkDevice', () => {
	it('is ok when the server knows the terminal', async () => {
		vi.stubGlobal('fetch', respond(200, { device: {} }))
		expect(await checkDevice(settings)).toBe('ok')
	})

	it('reports removed only for the explicit revocation, and unrecognised for an unknown secret', async () => {
		vi.stubGlobal('fetch', respond(401, { error: 'device_revoked' }))
		expect(await checkDevice(settings)).toBe('removed')
		vi.stubGlobal('fetch', respond(401, { error: 'invalid_device' }))
		expect(await checkDevice(settings)).toBe('unrecognised')
	})

	it('never locks a till out on a guess: other 401s, server errors, network failures and no pairing are all "unknown"', async () => {
		vi.stubGlobal('fetch', respond(401, { error: 'something_else' }))
		expect(await checkDevice(settings)).toBe('unknown')
		vi.stubGlobal('fetch', respond(503, { error: 'pos_disabled' }))
		expect(await checkDevice(settings)).toBe('unknown')
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
		)
		expect(await checkDevice(settings)).toBe('unknown')
		const never = vi.fn()
		vi.stubGlobal('fetch', never)
		expect(await checkDevice({ ...settings, deviceToken: null })).toBe(
			'unknown',
		)
		expect(never).not.toHaveBeenCalled()
	})
})

describe('what is final and what is retried', () => {
	it.each([
		['not_found', 404],
		['service_unavailable', 503],
		['internal_error', 500],
		['pos_disabled', 503],
		['bad_gateway', 502],
	])('%s (%i) is retried, never parked as refused', async (error, status) => {
		const order = await place()
		vi.stubGlobal('fetch', respond(status, { error }))
		await flushOutbox(settings)
		expect(await db.orders.get(order.id)).toMatchObject({
			sync: 'pending',
			attempts: 1,
		})
	})

	it.each([
		'invalid_request',
		'wrong_location',
		'order_id_conflict',
		'payments_changed',
		'paid_order_changed',
		'order_closed',
		'order_identity_changed',
		'payment_id_conflict',
		'payload_too_large',
	])('%s is final', async (error) => {
		const order = await place()
		vi.stubGlobal(
			'fetch',
			respond(error === 'payload_too_large' ? 413 : 409, {
				error,
				message: error,
			}),
		)
		await flushOutbox(settings)
		expect((await db.orders.get(order.id))!.sync).toBe('rejected')
	})

	it('one order that throws is backed off, and the orders behind it still go out', async () => {
		const first = await place()
		const second = await place()
		// Distinct times, so which is "oldest" is defined, not a coin toss.
		await db.orders.update(first.id, { createdAt: Date.now() - 10_000 })
		await db.orders.update(second.id, { createdAt: Date.now() - 5_000 })
		let call = 0
		vi.stubGlobal(
			'fetch',
			vi.fn().mockImplementation(async () => {
				call++
				if (call === 1) throw new TypeError('boom')
				return new Response('{}', { status: 201 })
			}),
		)
		await flushOutbox(settings)
		expect(await db.orders.get(first.id)).toMatchObject({
			sync: 'pending',
			attempts: 1,
		})
		expect((await db.orders.get(first.id))!.nextAttemptAt).toBeGreaterThan(
			Date.now(),
		)
		// The next pass skips the one in its backoff and sends the other.
		expect(await flushOutbox(settings)).toBe(1)
		expect((await db.orders.get(second.id))!.sync).toBe('synced')
		expect((await db.orders.get(first.id))!.sync).toBe('pending')
	})
})

describe('orders only go where they were taken', () => {
	it('never sends an order taken in demo mode, nor anything while demo mode is on', async () => {
		const demo = await createOrder({ ...input, origin: '@demo' }, pay)
		const real = await createOrder({ ...input, origin: '@demo' }, pay)
		const fetchMock = respond(201)
		vi.stubGlobal('fetch', fetchMock)
		expect(await flushOutbox(settings)).toBe(0)
		expect(await flushOutbox({ ...settings, demo: true })).toBe(0)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(
			[await db.orders.get(demo.id), await db.orders.get(real.id)].map(
				(o) => o!.sync,
			),
		).toEqual(['pending', 'pending'])
	})

	it('holds an order taken for another restaurant instead of sending its guests to this one', async () => {
		const other = await createOrder({ ...input, origin: 'other-diner' }, pay)
		const mine = await createOrder({ ...input, origin: 'demo-slug' }, pay)
		const fetchMock = respond(201)
		vi.stubGlobal('fetch', fetchMock)
		expect(await flushOutbox({ ...settings, slug: 'demo-slug' })).toBe(1)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect((await db.orders.get(mine.id))!.sync).toBe('synced')
		expect((await db.orders.get(other.id))!.sync).toBe('pending')
	})

	it('orders from before this field existed, or taken before setup, still send', async () => {
		const legacy = await place() // no origin
		vi.stubGlobal('fetch', respond(201))
		expect(await flushOutbox(settings)).toBe(1)
		expect((await db.orders.get(legacy.id))!.sync).toBe('synced')
	})

	it('sends the currency that was actually charged', async () => {
		const sar = await createOrder({ ...input, currency: 'SAR' }, pay)
		expect(toWireOrder((await db.orders.get(sar.id))!).currency).toBe('SAR')
	})
})

describe('who took the order, on the wire', () => {
	const ana = { id: 'staff-ana', name: 'Ana K.' }
	const omar = { id: 'staff-omar', name: 'Omar R.' }

	it('sends who rang it up, who took each payment and how they signed in, and passes the contract', async () => {
		const tab = await createOrder({ ...input, staff: ana, signIn: 'online' })
		const paid = await addPayment(tab.id, {
			method: 'cash',
			amountCents: 1000,
			tenderedCents: 1000,
			changeCents: 0,
			staff: omar,
		})
		const wire = toWireOrder(paid)
		expect(wire).toMatchObject({ staff: ana, signIn: 'online', voidedBy: null })
		expect(wire.payments[0]!.staff).toEqual(omar)
		expect(posOrderRequestSchema.safeParse(wire).success).toBe(true)
	})

	it('records who cancelled a tab, apart from who opened it, and passes the contract', async () => {
		const tab = await createOrder({ ...input, staff: ana, signIn: 'offline' })
		await voidTab(tab.id, { reason: 'mistake', by: omar, approvedBy: null })
		const wire = toWireOrder((await db.orders.get(tab.id))!)
		expect(wire).toMatchObject({
			status: 'void',
			staff: ana,
			signIn: 'offline',
			voidedBy: omar,
		})
		expect(posOrderRequestSchema.safeParse(wire).success).toBe(true)
	})

	it('editing a tab keeps who opened it', async () => {
		const tab = await createOrder({ ...input, staff: ana, signIn: 'online' })
		const edited = await updateTab(tab.id, {
			...input,
			staff: omar,
			lines: [{ ...line, quantity: 3 }],
		})
		expect(edited.staff).toEqual(ana)
	})
})

describe('cash drawer shifts', () => {
	/** Two shifts on this terminal: one closed, one open (oldest first). */
	async function twoShifts() {
		const first = await startShift({
			openingFloatCents: 10_000,
			by: null,
			origin: 'demo',
		})
		await closeShift(first.id, { countedCashCents: 10_000, by: null })
		// Opened a moment later, so it sorts after the first.
		await new Promise((resolve) => setTimeout(resolve, 2))
		const second = await startShift({
			openingFloatCents: 5_000,
			by: null,
			origin: 'demo',
		})
		return { first, second }
	}
	const shiftCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
		fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/pos/shifts'))

	it('a shift refused for good is marked rejected, and the next shift still goes', async () => {
		const { first, second } = await twoShifts()
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: 'payload_too_large' }), {
					status: 413,
				}),
			)
			.mockResolvedValueOnce(new Response('{}', { status: 201 }))
		vi.stubGlobal('fetch', fetchMock)
		await flushOutbox(settings)
		expect(shiftCalls(fetchMock)).toHaveLength(2)
		expect((await db.shifts.get(first.id))!).toMatchObject({
			sync: 'rejected',
			lastError: 'payload_too_large',
		})
		expect((await db.shifts.get(second.id))!.sync).toBe('synced')
		expect(await rejectedShifts()).toHaveLength(1)
		// Sent again on request.
		expect(await requeueRejectedShifts()).toBe(1)
		expect((await db.shifts.get(first.id))!.sync).toBe('pending')
	})

	it('a failure that may clear backs off and stops, without marking anything refused', async () => {
		const { first, second } = await twoShifts()
		const fetchMock = respond(503)
		vi.stubGlobal('fetch', fetchMock)
		await flushOutbox(settings)
		expect(shiftCalls(fetchMock)).toHaveLength(1)
		const row = (await db.shifts.get(first.id))!
		expect(row.sync).toBe('pending')
		expect(row.attempts).toBe(1)
		expect(row.nextAttemptAt).toBeGreaterThan(Date.now())
		expect((await db.shifts.get(second.id))!.attempts).toBe(0)
	})

	it('a removed terminal says so once, and its shifts wait for re-pairing', async () => {
		const { first } = await twoShifts()
		vi.stubGlobal('fetch', respond(401, { error: 'device_revoked' }))
		const onUnpaired = vi.fn()
		await flushOutbox(settings, { onUnpaired })
		expect(onUnpaired).toHaveBeenCalledTimes(1)
		expect((await db.shifts.get(first.id))!).toMatchObject({
			sync: 'pending',
			attempts: 0,
			nextAttemptAt: 0,
		})
	})

	it('a terminal the server does not recognise is reported, not removed', async () => {
		await twoShifts()
		vi.stubGlobal('fetch', respond(401, { error: 'invalid_device' }))
		const onUnrecognised = vi.fn()
		const onUnpaired = vi.fn()
		await flushOutbox(settings, { onUnrecognised, onUnpaired })
		expect(onUnrecognised).toHaveBeenCalledTimes(1)
		expect(onUnpaired).not.toHaveBeenCalled()
	})
})

describe('classifyRefusal', () => {
	it('is shared by orders and shifts', () => {
		expect(classifyRefusal(401, { error: 'device_revoked' }).kind).toBe(
			'unpaired',
		)
		expect(classifyRefusal(401, { error: 'invalid_device' }).kind).toBe(
			'unrecognised',
		)
		expect(classifyRefusal(413, { error: 'payload_too_large' }).kind).toBe(
			'rejected',
		)
		expect(classifyRefusal(429, { error: 'held_limit' }).kind).toBe('retry')
		expect(classifyRefusal(502, {}).kind).toBe('retry')
	})
})

describe('the server clock', () => {
	it('every order upload measures how far off the tablet clock is', async () => {
		await place()
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				new Response('{}', {
					status: 201,
					headers: { Date: new Date(Date.now() - 5 * 60_000).toUTCString() },
				}),
			),
		)
		await flushOutbox(settings)
		const skew = useClock.getState().skewMs!
		expect(skew).toBeLessThan(-4 * 60_000)
		expect(skew).toBeGreaterThan(-6 * 60_000)
	})
})
