import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	deliveryDriverNotices,
	deliveryRunPositions,
	deliveryRuns,
	deliveryRunStops,
	destroyTenantDb,
	posShifts,
	getTenantDb,
	orderMessages,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { ORG_A, ORG_B, stubStaffEnv } from '../../tests/staff-harness.ts'
import {
	DELIVERY_LOCATION,
	insertDeliveryOrder,
	seedDeliveryWorld,
	stationCall,
	type DeliveryWorld,
} from '../../tests/delivery-fixture.ts'
import {
	clearInHouseDeliveryFlagCache,
	seedInHouseDeliveryFlagForTest,
} from '../lib/delivery-switches.ts'
import {
	setMaskedCallBridgeForTesting,
	type MaskedCallBridge,
} from '../lib/masked-call.ts'
import { loadOrderSteps } from '../services/order-steps.ts'
import { shiftReport } from '../services/pos-shift-service.ts'

/**
 * Station's Deliveries app (#287): a manager assigns ready orders to a driver as
 * a run, the driver sees only their own run, delivering completes the order and
 * tells the guest, and nothing of a finished or another driver's run is reachable.
 */

describe('Station Deliveries app (/pos/deliveries)', () => {
	let dir: string
	let world: DeliveryWorld

	const call = (
		who: keyof DeliveryWorld['sessions'] | null,
		method: string,
		suffix: string,
		body?: unknown,
		options?: { token?: string; session?: string },
	) => stationCall(world, who, method, suffix, body, options)

	async function assign(driver: 'ana' | 'ben', orderIds: string[]) {
		const response = await call('mona', 'POST', '/runs', {
			driverStaffId: world.staff[driver],
			orderIds,
		})
		return response
	}
	const me = async (who: keyof DeliveryWorld['sessions']) => {
		const response = await call(who, 'GET', '/me')
		expect(response.status).toBe(200)
		return response.json()
	}
	const runOf = async (who: 'ana' | 'ben') => (await me(who)).run

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-deliveries-'))
		stubStaffEnv(dir)
		vi.stubEnv('POS_ENABLED', '')
		for (const org of [ORG_A, ORG_B]) await provisionTenantDb(org)
		world = await seedDeliveryWorld()
		seedInHouseDeliveryFlagForTest(ORG_A, true)
	})
	afterEach(async () => {
		clearInHouseDeliveryFlagCache()
		setMaskedCallBridgeForTesting(undefined)
		for (const org of [ORG_A, ORG_B]) await destroyTenantDb(org)
		fs.rmSync(dir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('is off until the organization turns delivery.in_house on', async () => {
		seedInHouseDeliveryFlagForTest(ORG_A, false)
		for (const who of ['mona', 'ana'] as const) {
			const response = await call(who, 'GET', '/me')
			expect(response.status).toBe(403)
			expect((await response.json()).error).toBe('deliveries_not_enabled')
		}
	})

	describe('assigning a run (#287)', () => {
		it('lets a manager assign two ready orders to a driver as one run; the driver sees only those stops', async () => {
			const first = await insertDeliveryOrder({ number: 'D-1', firstName: 'Layla' })
			const second = await insertDeliveryOrder({ number: 'D-2', firstName: 'Omar', address: '1 Other Street' })
			const third = await insertDeliveryOrder({ number: 'D-3' })
			const board = await (await call('mona', 'GET', '/board')).json()
			expect(board.unassigned.map((order: { number: string }) => order.number).sort()).toEqual([
				'D-1',
				'D-2',
				'D-3',
			])
			expect(board.drivers.map((d: { name: string }) => d.name)).toEqual(['Ana D.', 'Ben D.'])

			const created = await assign('ana', [first, second])
			expect(created.status).toBe(200)

			const run = await runOf('ana')
			expect(run.stops.map((s: { number: string }) => s.number)).toEqual(['D-1', 'D-2'])
			expect(run.stops[0]).toMatchObject({
				firstName: 'Layla',
				address: '233 South Wacker Drive, Chicago',
				unit: 'Suite 4',
				notes: 'Front desk',
				status: 'pending',
				canCall: true,
			})
			expect(run.stops[0].mapUrl).toContain('google.com/maps')
			// The other order is still waiting, and the other driver has no run.
			expect(await runOf('ben')).toBeNull()
			const after = await (await call('mona', 'GET', '/board')).json()
			expect(after.unassigned.map((o: { number: string }) => o.number)).toEqual(['D-3'])
			void third
			// The driver is told about the run once.
			const notices = (await me('ana')).notices
			expect(notices).toEqual([]) // read by the first /me above
		})

		it('tells the driver a manager gave them a run, exactly once', async () => {
			const id = await insertDeliveryOrder({ number: 'D-9' })
			await assign('ana', [id])
			const first = await me('ana')
			expect(first.notices).toEqual([
				expect.objectContaining({ kind: 'assigned', orderNumbers: ['D-9'] }),
			])
			expect((await me('ana')).notices).toEqual([])
		})

		it('never exposes the guest phone or surname to the driver or the board', async () => {
			const id = await insertDeliveryOrder({ number: 'D-4' })
			await assign('ana', [id])
			const driverView = JSON.stringify(await me('ana'))
			const boardView = JSON.stringify(await (await call('mona', 'GET', '/board')).json())
			for (const text of [driverView, boardView]) {
				expect(text).not.toMatch(/15551234567|layla@example|Guest/)
			}
		})

		it('does not assign one order to two drivers, even at the same moment', async () => {
			const id = await insertDeliveryOrder()
			const [a, b] = await Promise.all([assign('ana', [id]), assign('ben', [id])])
			expect([a.status, b.status].sort()).toEqual([200, 409])
			const taken = await Promise.all([a, b].map(async (r) => (r.status === 409 ? (await r.json()).error : null)))
			expect(taken.filter(Boolean)).toEqual(['order_already_assigned'])
			const db = await getTenantDb(ORG_A)
			expect(await db.select().from(deliveryRunStops)).toHaveLength(1)
			// And later, sequentially: refused too.
			const again = await assign('ben', [id])
			expect(again.status).toBe(409)
		})

		it('refuses orders that are not ready, not delivery, or not at this location', async () => {
			const preparing = await insertDeliveryOrder({ status: 'accepted' })
			const elsewhere = await insertDeliveryOrder({ locationId: 'elsewhere' })
			for (const id of [preparing, elsewhere]) {
				expect((await assign('ana', [id])).status).toBeGreaterThanOrEqual(404)
			}
			const db = await getTenantDb(ORG_A)
			const pickup = await insertDeliveryOrder()
			await db.update(restaurantOrders).set({ fulfillment: 'pickup' }).where(eq(restaurantOrders.id, pickup))
			expect((await assign('ana', [pickup])).status).toBe(404)
		})

		it('keeps a driver who is unavailable out of new runs; their current run can finish', async () => {
			const now = await insertDeliveryOrder({ number: 'D-5' })
			const later = await insertDeliveryOrder({ number: 'D-6' })
			expect((await assign('ana', [now])).status).toBe(200)
			const away = await call('mona', 'POST', `/drivers/${world.staff.ana}/availability`, { unavailable: true })
			expect(away.status).toBe(200)
			const refused = await assign('ana', [later])
			expect(refused.status).toBe(409)
			expect((await refused.json()).error).toBe('driver_unavailable')
			const board = await (await call('mona', 'GET', '/board')).json()
			expect(board.drivers.find((d: { name: string }) => d.name === 'Ana D.')).toMatchObject({
				unavailable: true,
				openRuns: 1,
			})
			// The current run still reaches the driver, who cannot claim more.
			const self = await me('ana')
			expect(self.run.stops).toHaveLength(1)
			expect(self.unavailable).toBe(true)
			expect(self.claimable).toEqual([])
			// A driver can set themselves back.
			expect((await call('ana', 'POST', '/me/availability', { unavailable: false })).status).toBe(200)
			expect((await assign('ana', [later])).status).toBe(200)
		})

		it('lets a driver claim ready orders for themselves', async () => {
			const id = await insertDeliveryOrder({ number: 'D-7' })
			const self = await me('ana')
			expect(self.claimable.map((o: { number: string }) => o.number)).toEqual(['D-7'])
			expect((await call('ana', 'POST', '/claim', { orderIds: [id] })).status).toBe(200)
			expect((await runOf('ana')).stops[0].number).toBe('D-7')
			// A claim is the driver's own: no "assigned" notice, and Ben cannot take it too.
			expect((await me('ana')).notices).toEqual([])
			expect((await call('ben', 'POST', '/claim', { orderIds: [id] })).status).toBe(409)
		})
	})

	describe('picking up and delivering (#287)', () => {
		it('marks everything picked up at once: the out_for_delivery step and the guest message', async () => {
			const one = await insertDeliveryOrder({ number: 'D-1' })
			const two = await insertDeliveryOrder({ number: 'D-2' })
			await assign('ana', [one, two])
			const run = await runOf('ana')
			const response = await call('ana', 'POST', `/runs/${run.id}/pickup`)
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({ pickedUp: 2 })
			const after = await runOf('ana')
			expect(after.status).toBe('on_the_road')
			expect(after.stops.map((s: { status: string }) => s.status)).toEqual(['picked_up', 'picked_up'])
			const db = await getTenantDb(ORG_A)
			for (const id of [one, two]) {
				const steps = await loadOrderSteps(db, id)
				const out = steps.filter((s) => s.step === 'out_for_delivery')
				expect(out.at(-1)).toMatchObject({ actorKind: 'station', actorId: `staff:${world.staff.ana}` })
			}
			const messages = await db.select().from(orderMessages)
			expect(messages.filter((m) => m.kind === 'out_for_delivery' && m.channel === 'email')).toHaveLength(2)
			// A second tap changes nothing.
			expect(await (await call('ana', 'POST', `/runs/${run.id}/pickup`)).json()).toMatchObject({ pickedUp: 0 })
		})

		it('completes the order and tells the guest when a stop is delivered', async () => {
			const id = await insertDeliveryOrder({ number: 'D-1' })
			await assign('ana', [id])
			const run = await runOf('ana')
			await call('ana', 'POST', `/runs/${run.id}/pickup`)
			const stop = (await runOf('ana')).stops[0]
			const response = await call('ana', 'POST', `/stops/${stop.id}/delivered`, {})
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({ orderId: id, runDone: true })
			const db = await getTenantDb(ORG_A)
			const [order] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, id))
			expect(order!.status).toBe('completed')
			const steps = await loadOrderSteps(db, id)
			expect(steps.some((s) => s.step === 'delivered')).toBe(true)
			const messages = await db.select().from(orderMessages)
			expect(messages.some((m) => m.kind === 'delivered' && m.channel === 'email')).toBe(true)
			const [row] = await db.select().from(deliveryRunStops).where(eq(deliveryRunStops.id, stop.id))
			expect(row).toMatchObject({ status: 'delivered', deliveredByKind: 'driver' })
		})

		it('makes a driver pick up before delivering, but lets a manager deliver on their behalf', async () => {
			const id = await insertDeliveryOrder({ number: 'D-1' })
			await assign('ana', [id])
			const stop = (await runOf('ana')).stops[0]
			const early = await call('ana', 'POST', `/stops/${stop.id}/delivered`, {})
			expect(early.status).toBe(409)
			expect((await early.json()).error).toBe('not_picked_up')
			const behalf = await call('mona', 'POST', `/stops/${stop.id}/delivered`, {})
			expect(behalf.status).toBe(200)
			const db = await getTenantDb(ORG_A)
			const [row] = await db.select().from(deliveryRunStops).where(eq(deliveryRunStops.id, stop.id))
			expect(row).toMatchObject({ status: 'delivered', deliveredByKind: 'manager' })
			expect(await runOf('ana')).toBeNull()
		})

		it('records the cash a driver collected and marks a pay-at-handoff order paid', async () => {
			const id = await insertDeliveryOrder({ number: 'D-1', cash: true, totalCents: 3150, tipCents: 300 })
			await assign('ana', [id])
			const run = await runOf('ana')
			expect(run.stops[0]).toMatchObject({ cashDueCents: 3150, tipCents: 300 })
			await call('ana', 'POST', `/runs/${run.id}/pickup`)
			const stop = (await runOf('ana')).stops[0]
			const response = await call('ana', 'POST', `/stops/${stop.id}/delivered`, { cashCollectedCents: 3150 })
			expect(response.status).toBe(200)
			const db = await getTenantDb(ORG_A)
			const [order] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, id))
			expect(order).toMatchObject({ status: 'completed', paymentStatus: 'paid' })
			const [row] = await db.select().from(deliveryRunStops).where(eq(deliveryRunStops.id, stop.id))
			expect(row).toMatchObject({ cashDueCents: 3150, cashCollectedCents: 3150 })
		})

		it('keeps an order unpaid when the driver collected less than was due, and refuses cash on a paid order', async () => {
			const cashy = await insertDeliveryOrder({ number: 'D-1', cash: true, totalCents: 2000 })
			const paid = await insertDeliveryOrder({ number: 'D-2' })
			await assign('ana', [cashy, paid])
			const run = await runOf('ana')
			await call('ana', 'POST', `/runs/${run.id}/pickup`)
			const [a, b] = (await runOf('ana')).stops
			expect((await call('ana', 'POST', `/stops/${b.id}/delivered`, { cashCollectedCents: 500 })).status).toBe(422)
			expect((await call('ana', 'POST', `/stops/${a.id}/delivered`, { cashCollectedCents: 1500 })).status).toBe(200)
			const db = await getTenantDb(ORG_A)
			const [order] = await db.select().from(restaurantOrders).where(eq(restaurantOrders.id, cashy))
			expect(order).toMatchObject({ status: 'completed', paymentStatus: 'unpaid' })
		})

		it('reports a problem: the stop waits for a manager and the run closes on the driver\'s screen', async () => {
			const id = await insertDeliveryOrder({ number: 'D-1' })
			await assign('ana', [id])
			const run = await runOf('ana')
			await call('ana', 'POST', `/runs/${run.id}/pickup`)
			const stop = (await runOf('ana')).stops[0]
			const response = await call('ana', 'POST', `/stops/${stop.id}/problem`, { kind: 'not_home' })
			expect(response.status).toBe(200)
			expect(await runOf('ana')).toBeNull()
			// The order is still held (not free to assign) until a manager settles it.
			const board = await (await call('mona', 'GET', '/board')).json()
			expect(board.unassigned).toEqual([])
			expect(board.runs[0].stops[0]).toMatchObject({ status: 'problem', problemKind: 'not_home' })
			expect((await assign('ben', [id])).status).toBe(409)
			// The manager takes it back and the order can go out again.
			expect((await call('mona', 'POST', `/stops/${stop.id}/release`)).status).toBe(200)
			expect((await assign('ben', [id])).status).toBe(200)
		})

		it('drops a cancelled order from the run at pickup', async () => {
			const keep = await insertDeliveryOrder({ number: 'D-1' })
			const gone = await insertDeliveryOrder({ number: 'D-2' })
			await assign('ana', [keep, gone])
			const db = await getTenantDb(ORG_A)
			await db.update(restaurantOrders).set({ status: 'cancelled' }).where(eq(restaurantOrders.id, gone))
			const run = await runOf('ana')
			expect(await (await call('ana', 'POST', `/runs/${run.id}/pickup`)).json()).toMatchObject({ pickedUp: 1 })
			const statuses = (await db.select().from(deliveryRunStops)).map((s) => s.status).sort()
			expect(statuses).toEqual(['picked_up', 'released'])
		})
	})

	describe('who can open what (#287 security)', () => {
		it('does not let a driver open another driver\'s run or stop', async () => {
			const id = await insertDeliveryOrder({ number: 'D-1' })
			await assign('ana', [id])
			const run = await runOf('ana')
			const stop = run.stops[0]
			for (const [suffix, body] of [
				[`/runs/${run.id}/pickup`, undefined],
				[`/stops/${stop.id}/delivered`, {}],
				[`/stops/${stop.id}/problem`, { kind: 'other' }],
				[`/stops/${stop.id}/call`, undefined],
			] as const) {
				const response = await call('ben', 'POST', suffix, body)
				expect(response.status, suffix).toBe(404)
			}
			// Ben's own view never lists Ana's stop.
			expect(JSON.stringify(await me('ben'))).not.toContain('233 South Wacker')
			// Nothing changed for Ana.
			expect((await runOf('ana')).stops[0].status).toBe('pending')
		})

		it('does not let a driver open an old, finished run', async () => {
			const id = await insertDeliveryOrder({ number: 'D-1' })
			await assign('ana', [id])
			const run = await runOf('ana')
			await call('ana', 'POST', `/runs/${run.id}/pickup`)
			const stop = (await runOf('ana')).stops[0]
			await call('ana', 'POST', `/stops/${stop.id}/delivered`, {})
			// The run is finished: the driver's screen holds no addresses any more.
			const self = await me('ana')
			expect(self.run).toBeNull()
			expect(JSON.stringify(self)).not.toContain('233 South Wacker')
			// And its stop and run are closed to the driver, by id.
			for (const [suffix, body] of [
				[`/runs/${run.id}/pickup`, undefined],
				[`/stops/${stop.id}/delivered`, {}],
				[`/stops/${stop.id}/problem`, { kind: 'other' }],
				[`/stops/${stop.id}/call`, undefined],
			] as const) {
				expect((await call('ana', 'POST', suffix, body)).status, suffix).toBe(404)
			}
		})

		it('keeps the board, assigning and taking back to managers', async () => {
			const id = await insertDeliveryOrder()
			expect((await call('ana', 'GET', '/board')).status).toBe(403)
			expect((await call('sam', 'GET', '/board')).status).toBe(403)
			const asDriver = await call('ana', 'POST', '/runs', { driverStaffId: world.staff.ana, orderIds: [id] })
			expect(asDriver.status).toBe(403)
			expect((await call('sam', 'POST', '/runs', { driverStaffId: world.staff.ana, orderIds: [id] })).status).toBe(403)
			await assign('ana', [id])
			const stop = (await runOf('ana')).stops[0]
			expect((await call('ana', 'POST', `/stops/${stop.id}/release`)).status).toBe(403)
			expect((await call('ana', 'POST', `/drivers/${world.staff.ben}/availability`, { unavailable: true })).status).toBe(403)
		})

		it('gives a person who is not a driver nothing', async () => {
			const id = await insertDeliveryOrder()
			const self = await me('sam')
			expect(self).toMatchObject({ role: 'none', isDriver: false, claimable: [], run: null })
			expect((await call('sam', 'POST', '/claim', { orderIds: [id] })).status).toBe(403)
			expect((await call('sam', 'POST', '/run/location', { lat: 1, lng: 2 })).status).toBe(403)
		})

		it('refuses a missing, forged or other-terminal session, and a forged or other-organization device', async () => {
			expect((await call(null, 'GET', '/me')).status).toBe(401)
			expect((await call(null, 'GET', '/me', undefined, { session: 'forged.session.token' })).status).toBe(401)
			expect((await call('mona', 'GET', '/me', undefined, { token: `${world.secret}x` })).status).toBe(401)
			expect((await call('mona', 'GET', '/me', undefined, { token: 'not-a-device-secret' })).status).toBe(401)
			// A session minted for another terminal is not accepted here.
			const { mintPosStaffSession } = await import('../lib/pos-staff-session.ts')
			const other = (
				await mintPosStaffSession({ orgId: ORG_A, deviceId: 'another-device', staffId: world.staff.mona, role: 'manager' })
			).token
			expect((await call(null, 'GET', '/me', undefined, { session: other })).status).toBe(401)
			// Another organization's database holds none of this organization's orders or staff.
			const foreign = await mintPosStaffSession({ orgId: ORG_B, deviceId: world.deviceId, staffId: world.staff.mona, role: 'manager' })
			expect((await call(null, 'GET', '/me', undefined, { session: foreign.token })).status).toBe(401)
		})

		it('needs a terminal with a location and sign-in', async () => {
			const { posDevices } = await import('@repo/tenant-db')
			const db = await getTenantDb(ORG_A)
			await db.update(posDevices).set({ signInRequired: false }).where(eq(posDevices.id, world.deviceId))
			const response = await call('mona', 'GET', '/me')
			expect(response.status).toBe(403)
			expect((await response.json()).error).toBe('deliveries_needs_sign_in')
		})
	})

	describe('reassigning (#287)', () => {
		it('hands the open stops to another driver and tells both', async () => {
			const one = await insertDeliveryOrder({ number: 'D-1' })
			const two = await insertDeliveryOrder({ number: 'D-2' })
			await assign('ana', [one, two])
			await me('ana') // reads the "assigned" notice
			const run = await runOf('ana')
			const response = await call('mona', 'POST', `/runs/${run.id}/reassign`, { driverStaffId: world.staff.ben })
			expect(response.status).toBe(200)
			expect(await runOf('ana')).toBeNull()
			expect((await runOf('ben')).stops.map((s: { number: string }) => s.number)).toEqual(['D-1', 'D-2'])
			expect((await me('ana')).notices).toEqual([])
			// Both were told: Ana (taken away) and Ben (assigned). Ana's was read above or now.
			const db = await getTenantDb(ORG_A)
			const notices = await db.select().from(deliveryDriverNotices)
			const kinds = notices.map((n) => `${n.staffId === world.staff.ana ? 'ana' : 'ben'}:${n.kind}`).sort()
			expect(kinds).toEqual(['ana:assigned', 'ana:taken_away', 'ben:assigned'])
			// The old driver can no longer act on it.
			const stop = (await runOf('ben')).stops[0]
			expect((await call('ana', 'POST', `/stops/${stop.id}/delivered`, {})).status).toBe(404)
		})

		it('refuses a driver who is not on the roster', async () => {
			const id = await insertDeliveryOrder()
			await assign('ana', [id])
			const run = await runOf('ana')
			const response = await call('mona', 'POST', `/runs/${run.id}/reassign`, { driverStaffId: world.staff.sam })
			expect(response.status).toBe(404)
		})

		it('tells the driver when a manager takes one stop back', async () => {
			const one = await insertDeliveryOrder({ number: 'D-1' })
			const two = await insertDeliveryOrder({ number: 'D-2' })
			await assign('ana', [one, two])
			await me('ana')
			const stops = (await runOf('ana')).stops
			expect((await call('mona', 'POST', `/stops/${stops[0].id}/release`)).status).toBe(200)
			const self = await me('ana')
			expect(self.notices).toEqual([expect.objectContaining({ kind: 'stop_released', orderNumbers: ['D-1'] })])
			expect(self.run.stops.filter((s: { status: string }) => s.status !== 'released').map((s: { number: string }) => s.number)).toEqual(['D-2'])
		})
	})

	describe('live position and masked call (#287)', () => {
		it('stores a shared position only while a run is open, and deletes it when the run ends', async () => {
			const id = await insertDeliveryOrder({ number: 'D-1' })
			await assign('ana', [id])
			const db = await getTenantDb(ORG_A)
			expect((await call('ana', 'POST', '/run/location', { lat: 41.88, lng: -87.63 })).status).toBe(200)
			expect(await db.select().from(deliveryRunPositions)).toHaveLength(1)
			// Managers see it on the board while the run is open.
			const board = await (await call('mona', 'GET', '/board')).json()
			expect(board.runs[0].position).toMatchObject({ lat: 41.88, lng: -87.63 })
			// The driver can stop sharing: the point is gone at once.
			expect((await call('ana', 'DELETE', '/run/location')).status).toBe(200)
			expect(await db.select().from(deliveryRunPositions)).toHaveLength(0)
			// Share again, then finish the run: no coordinate outlives it.
			await call('ana', 'POST', '/run/location', { lat: 41.9, lng: -87.6 })
			const run = await runOf('ana')
			await call('ana', 'POST', `/runs/${run.id}/pickup`)
			const stop = (await runOf('ana')).stops[0]
			await call('ana', 'POST', `/stops/${stop.id}/delivered`, {})
			expect(await db.select().from(deliveryRunPositions)).toHaveLength(0)
			const [finished] = await db.select().from(deliveryRuns)
			expect(finished!.status).toBe('completed')
			// With no open run there is nothing to share a position for.
			expect((await call('ana', 'POST', '/run/location', { lat: 1, lng: 2 })).status).toBe(404)
		})

		it('rejects an impossible position', async () => {
			await assign('ana', [await insertDeliveryOrder()])
			expect((await call('ana', 'POST', '/run/location', { lat: 200, lng: 2 })).status).toBe(400)
		})

		it('rings the driver and connects the guest without returning either number', async () => {
			const connect = vi.fn(async () => true)
			const bridge: MaskedCallBridge = { name: 'test', available: () => true, connect }
			setMaskedCallBridgeForTesting(bridge)
			const id = await insertDeliveryOrder({ number: 'D-1' })
			await assign('ana', [id])
			const stop = (await runOf('ana')).stops[0]
			const response = await call('ana', 'POST', `/stops/${stop.id}/call`)
			expect(response.status).toBe(200)
			const text = await response.text()
			expect(text).not.toMatch(/1555/)
			expect(connect).toHaveBeenCalledWith({ driverPhone: '+15550001111', guestPhone: '+15551234567' })
		})

		it('hides the call where it cannot be placed', async () => {
			setMaskedCallBridgeForTesting(null)
			await assign('ana', [await insertDeliveryOrder()])
			const run = await runOf('ana')
			expect(run.stops[0].canCall).toBe(false)
			expect((await call('ana', 'POST', `/stops/${run.stops[0].id}/call`)).status).toBe(409)
		})

		it('says the call failed, never with a number', async () => {
			setMaskedCallBridgeForTesting({
				name: 'broken',
				available: () => true,
				connect: async () => {
					throw new Error('boom +15551234567')
				},
			})
			await assign('ana', [await insertDeliveryOrder()])
			const stop = (await runOf('ana')).stops[0]
			const response = await call('ana', 'POST', `/stops/${stop.id}/call`)
			expect(response.status).toBe(503)
			expect(await response.text()).not.toMatch(/1555/)
		})
	})
})

describe('Cash on deliveries in the shift report (#287)', () => {
	let dir: string
	let world: DeliveryWorld
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-deliveries-cash-'))
		stubStaffEnv(dir)
		vi.stubEnv('POS_ENABLED', '')
		await provisionTenantDb(ORG_A)
		world = await seedDeliveryWorld()
		seedInHouseDeliveryFlagForTest(ORG_A, true)
	})
	afterEach(async () => {
		clearInHouseDeliveryFlagCache()
		await destroyTenantDb(ORG_A)
		fs.rmSync(dir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('shows what each driver collected beside the drawer, without moving the drawer\'s own figures', async () => {
		const db = await getTenantDb(ORG_A)
		const now = Date.now()
		await db.insert(posShifts).values({
			id: crypto.randomUUID(),
			deviceId: world.deviceId,
			businessDate: '2026-11-25',
			revision: 1,
			status: 'open',
			openedAt: now - 3_600_000,
			openingFloatCents: 10_000,
			receivedAt: now,
			updatedAt: now,
		})
		const [shift] = await db.select().from(posShifts)
		const before = await shiftReport(db, shift!.id)
		expect(before!.deliveryCash).toEqual({ drivers: [], totalDueCents: 0, totalCollectedCents: 0 })

		const cashA = await insertDeliveryOrder({ number: 'D-1', cash: true, totalCents: 2000 })
		const cashB = await insertDeliveryOrder({ number: 'D-2', cash: true, totalCents: 3500 })
		const prepaid = await insertDeliveryOrder({ number: 'D-3' })
		for (const [driver, ids] of [
			['ana', [cashA, prepaid]],
			['ben', [cashB]],
		] as const) {
			await stationCall(world, 'mona', 'POST', '/runs', { driverStaffId: world.staff[driver], orderIds: ids })
		}
		for (const driver of ['ana', 'ben'] as const) {
			const self = await (await stationCall(world, driver, 'GET', '/me')).json()
			await stationCall(world, driver, 'POST', `/runs/${self.run.id}/pickup`)
			for (const stop of (await (await stationCall(world, driver, 'GET', '/me')).json()).run.stops) {
				await stationCall(world, driver, 'POST', `/stops/${stop.id}/delivered`, {
					...(stop.cashDueCents > 0 ? { cashCollectedCents: stop.cashDueCents } : {}),
				})
			}
		}
		const after = await shiftReport(db, shift!.id)
		expect(after!.deliveryCash.drivers.map((d) => [d.driverName, d.deliveries, d.cashCollectedCents])).toEqual(
			expect.arrayContaining([
				['Ana D.', 1, 2000],
				['Ben D.', 1, 3500],
			]),
		)
		expect(after!.deliveryCash).toMatchObject({ totalDueCents: 5500, totalCollectedCents: 5500 })
		// The drawer's own expected cash is untouched: delivery cash is reported beside it.
		expect(after!.summary.cash.expectedCents).toBe(before!.summary.cash.expectedCents)
		// A shift at another time sees none of it.
		await db.update(posShifts).set({ openedAt: now + 60_000, closedAt: now + 120_000 }).where(eq(posShifts.id, shift!.id))
		expect((await shiftReport(db, shift!.id))!.deliveryCash.drivers).toEqual([])
	})
})

void DELIVERY_LOCATION
