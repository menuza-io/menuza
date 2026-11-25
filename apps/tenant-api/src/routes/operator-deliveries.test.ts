import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { ORG_A, ORG_B, stubStaffEnv } from '../../tests/staff-harness.ts'
import {
	DELIVERY_LOCATION,
	insertDeliveryOrder,
	operatorToken,
	seedDeliveryWorld,
	type DeliveryWorld,
} from '../../tests/delivery-fixture.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import { operatorDeliveryRoutes } from './operator-deliveries.ts'

/**
 * The App's Deliveries board on the orders token (#287): the `deliveries` claim,
 * the member's location limit and write scope, and the same run rules as Station.
 */

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const app = new Hono().route('/operator/deliveries', operatorDeliveryRoutes)

describe('/operator/deliveries', () => {
	let dir: string
	let world: DeliveryWorld

	async function call(
		method: string,
		suffix: string,
		options: { body?: unknown; claims?: Record<string, unknown>; token?: string | null; org?: string } = {},
	) {
		const token =
			options.token === undefined
				? await operatorToken(options.claims, options.org)
				: options.token
		return app.request(`/operator/deliveries${suffix}`, {
			method,
			headers: {
				'Content-Type': 'application/json',
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		})
	}
	const board = async (claims?: Record<string, unknown>) => {
		const response = await call('GET', `/board?locationId=${DELIVERY_LOCATION}`, { claims })
		expect(response.status).toBe(200)
		return response.json()
	}

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-deliveries-'))
		stubStaffEnv(dir)
		for (const id of [ORG_A, ORG_B]) {
			orgs.set(id, { id, slug: id, customDomain: null, hasProvisionedDb: true, dataRegion: 'us' } as PublishedOrganization)
			await provisionTenantDb(id)
		}
		world = await seedDeliveryWorld()
	})
	afterEach(async () => {
		for (const id of [ORG_A, ORG_B]) await destroyTenantDb(id)
		fs.rmSync(dir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it('lets a manager assign two ready orders to a driver from the App board', async () => {
		const one = await insertDeliveryOrder({ number: 'D-1' })
		const two = await insertDeliveryOrder({ number: 'D-2' })
		const before = await board()
		expect(before.unassigned).toHaveLength(2)
		expect(before.drivers.map((d: { staffId: string }) => d.staffId).sort()).toEqual(
			[world.staff.ana, world.staff.ben].sort(),
		)
		const response = await call('POST', '/runs', {
			body: { locationId: DELIVERY_LOCATION, driverStaffId: world.staff.ana, orderIds: [one, two] },
		})
		expect(response.status).toBe(200)
		const after = await board()
		expect(after.unassigned).toEqual([])
		expect(after.runs).toHaveLength(1)
		expect(after.runs[0].stops.map((s: { number: string }) => s.number)).toEqual(['D-1', 'D-2'])
		expect(after.runs[0].createdByKind).toBe('manager')
		// A second assignment of the same order is refused.
		const again = await call('POST', '/runs', {
			body: { locationId: DELIVERY_LOCATION, driverStaffId: world.staff.ben, orderIds: [one] },
		})
		expect(again.status).toBe(409)
	})

	it('reassigns, marks delivered on behalf, takes back and sets availability', async () => {
		const one = await insertDeliveryOrder({ number: 'D-1' })
		const two = await insertDeliveryOrder({ number: 'D-2' })
		await call('POST', '/runs', {
			body: { locationId: DELIVERY_LOCATION, driverStaffId: world.staff.ana, orderIds: [one, two] },
		})
		let state = await board()
		const run = state.runs[0]
		expect(
			(await call('POST', `/runs/${run.id}/reassign`, { body: { driverStaffId: world.staff.ben } })).status,
		).toBe(200)
		state = await board()
		expect(state.runs[0].driver.staffId).toBe(world.staff.ben)
		const [first, second] = state.runs[0].stops
		expect((await call('POST', `/stops/${first.id}/delivered`, { body: {} })).status).toBe(200)
		expect((await call('POST', `/stops/${second.id}/release`)).status).toBe(200)
		state = await board()
		expect(state.unassigned.map((o: { number: string }) => o.number)).toEqual(['D-2'])
		const away = await call('POST', `/drivers/${world.staff.ben}/availability`, {
			body: { locationId: DELIVERY_LOCATION, unavailable: true },
		})
		expect(away.status).toBe(200)
		expect((await board()).drivers.find((d: { staffId: string }) => d.staffId === world.staff.ben).unavailable).toBe(true)
	})

	it('needs the deliveries claim, a token, the orders audience and write scope for writes', async () => {
		await insertDeliveryOrder()
		expect((await call('GET', `/board?locationId=${DELIVERY_LOCATION}`, { token: null })).status).toBe(401)
		expect((await call('GET', `/board?locationId=${DELIVERY_LOCATION}`, { token: 'forged.token.value' })).status).toBe(401)
		const noClaim = await call('GET', `/board?locationId=${DELIVERY_LOCATION}`, { claims: { deliveries: false } })
		expect(noClaim.status).toBe(403)
		expect((await noClaim.json()).error).toBe('deliveries_not_enabled')
		// A token for something else is not an orders token.
		expect((await call('GET', `/board?locationId=${DELIVERY_LOCATION}`, { claims: { scope: 'people' } })).status).toBe(403)
		// Read scope reads but never writes.
		const readOnly = { scope: 'orders:read' }
		expect((await call('GET', `/board?locationId=${DELIVERY_LOCATION}`, { claims: readOnly })).status).toBe(200)
		const write = await call('POST', '/runs', {
			claims: readOnly,
			body: { locationId: DELIVERY_LOCATION, driverStaffId: world.staff.ana, orderIds: ['x'] },
		})
		expect(write.status).toBe(403)
	})

	it('keeps a member to their own locations, and an organization to its own data', async () => {
		const id = await insertDeliveryOrder()
		const limited = { locationIds: ['somewhere-else'] }
		expect((await call('GET', `/board?locationId=${DELIVERY_LOCATION}`, { claims: limited })).status).toBe(404)
		expect(
			(
				await call('POST', '/runs', {
					claims: limited,
					body: { locationId: DELIVERY_LOCATION, driverStaffId: world.staff.ana, orderIds: [id] },
				})
			).status,
		).toBe(404)
		// A run at the location cannot be reassigned or released by a member without it.
		await call('POST', '/runs', {
			body: { locationId: DELIVERY_LOCATION, driverStaffId: world.staff.ana, orderIds: [id] },
		})
		const run = (await board()).runs[0]
		expect(
			(await call('POST', `/runs/${run.id}/reassign`, { claims: limited, body: { driverStaffId: world.staff.ben } })).status,
		).toBe(404)
		expect((await call('POST', `/stops/${run.stops[0].id}/release`, { claims: limited })).status).toBe(404)
		// Another organization's token reads that organization's empty database.
		const other = await call('GET', `/board?locationId=${DELIVERY_LOCATION}`, { org: ORG_B })
		expect(other.status).toBe(200)
		const body = await other.json()
		expect(body.unassigned).toEqual([])
		expect(body.runs).toEqual([])
		expect(body.drivers).toEqual([])
	})

	it('rejects malformed requests without echoing them', async () => {
		expect((await call('GET', '/board')).status).toBe(400)
		const bad = await call('POST', '/runs', { body: { locationId: DELIVERY_LOCATION, orderIds: [], driverStaffId: 'x' } })
		expect(bad.status).toBe(400)
		const extra = await call('POST', '/runs', {
			body: { locationId: DELIVERY_LOCATION, orderIds: ['a'], driverStaffId: 'x', extra: 1 },
		})
		expect(extra.status).toBe(400)
	})
})
