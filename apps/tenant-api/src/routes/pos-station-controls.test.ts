import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	formatPosDeviceSecret,
	POS_STAFF_SESSION_HEADER,
} from '@repo/common/pos-orders'
import {
	STATION_CONTROLS_PATH,
	type StationControlsRequest,
} from '@repo/common/pos-station-controls'
import { INVENTORY_AVAILABILITY_PATH } from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invItems,
	invAuditLog,
	invSoldOut,
	posDevices,
	posManagers,
	provisionTenantDb,
	staffMembers,
	staffScopeAssignments,
} from '@repo/tenant-db'
import { ORG_A, ORG_B, stubStaffEnv } from '../../tests/staff-harness.ts'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import { hashPosSecret } from '../lib/pos-auth.ts'
import { mintPosStaffSession } from '../lib/pos-staff-session.ts'
import { posOnlineOrdersRoutes } from './pos-online-orders.ts'

const LOCATION = 'loc-1'
const PAUSED_AT = 1_800_000_000_000
const INVENTORY_ON = {
	enabled: true,
	purchasing: false,
	recipes: true,
	prep: false,
	transfers: false,
}

/** The App, as the region sees it: what it was asked, and its answers. */
function fakeApp() {
	const asked: Array<{ path: string; body: any; auth: string | null }> = []
	let paused: { pausedAt: number; until: number | null } | null = null
	let status = 200
	/** Fail only the App's record of a person's availability change. */
	let failAvailability: number | null = null
	let errorBody = '{}'
	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input))
			const body = JSON.parse(String(init?.body ?? 'null'))
			asked.push({
				path: url.pathname,
				body,
				auth: new Headers(init?.headers).get('authorization'),
			})
			if (status !== 200) return new Response(errorBody, { status })
			if (
				failAvailability !== null &&
				url.pathname === STATION_CONTROLS_PATH &&
				body.kind === 'availability'
			)
				return new Response('{}', { status: failAvailability })
			if (url.pathname === INVENTORY_AVAILABILITY_PATH)
				return Response.json({
					applied: body.changes.map((change: any) => change.entityId),
				})
			const request = body as StationControlsRequest
			if (request.kind === 'pause')
				paused = { pausedAt: PAUSED_AT, until: PAUSED_AT + 15 * 60_000 }
			if (request.kind === 'resume') paused = null
			return Response.json({
				pause: paused,
				...(request.kind === 'availability' ? { changed: true } : {}),
			})
		},
	)
	return {
		fetchMock,
		asked,
		fail: (next: number, body = '{}') => {
			status = next
			errorBody = body
		},
		failAvailability: (next: number | null) => {
			failAvailability = next
		},
	}
}

describe('Station manager controls (/pos/online-orders/controls)', () => {
	let dir: string
	const app = new Hono().route('/pos/online-orders', posOnlineOrdersRoutes)
	let secret: string
	let deviceId: string
	let cashier: string
	let manager: string
	let managerId: string
	let fake: ReturnType<typeof fakeApp>

	async function addDevice(
		values: Partial<typeof posDevices.$inferInsert> = {},
	) {
		const db = await getTenantDb(ORG_A)
		const id = crypto.randomUUID()
		const token = formatPosDeviceSecret(ORG_A, id, 'x'.repeat(43))
		await db.insert(posDevices).values({
			id,
			label: 'Counter',
			terminalCode: `C${id.slice(0, 4)}`,
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

	function call(
		method: string,
		suffix: string,
		options: { body?: unknown; staff?: string | null; token?: string } = {},
	) {
		const staff = options.staff === undefined ? manager : options.staff
		return app.request(`/pos/online-orders/controls${suffix}`, {
			method,
			headers: {
				Authorization: `Bearer ${options.token ?? secret}`,
				'Content-Type': 'application/json',
				...(staff ? { [POS_STAFF_SESSION_HEADER]: staff } : {}),
			},
			...(options.body === undefined
				? {}
				: { body: JSON.stringify(options.body) }),
		})
	}

	async function holdByStock(entityId: string) {
		const db = await getTenantDb(ORG_A)
		await db
			.insert(invItems)
			.values({ id: 'it_tomato', name: 'Tomatoes', baseUnit: 'g' })
			.onConflictDoNothing()
		const id = crypto.randomUUID()
		await db.insert(invSoldOut).values({
			id,
			locationId: LOCATION,
			entityType: 'item',
			entityId,
			causeItemId: 'it_tomato',
		})
		return id
	}

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-controls-'))
		stubStaffEnv(dir)
		vi.stubEnv('POS_ENABLED', '')
		vi.stubEnv('INVENTORY_ENABLED', '')
		seedInventoryContextForTest(ORG_A, INVENTORY_ON)
		fake = fakeApp()
		vi.stubGlobal('fetch', fake.fetchMock)
		for (const org of [ORG_A, ORG_B]) await provisionTenantDb(org)
		;({ id: deviceId, token: secret } = await addDevice())
		const cashierId = await addStaff('Sam', 'cashier')
		managerId = await addStaff('Mona', 'manager')
		cashier = await session(cashierId)
		manager = await session(managerId)
	})
	afterEach(async () => {
		for (const org of [ORG_A, ORG_B]) await destroyTenantDb(org)
		fs.rmSync(dir, { recursive: true, force: true })
		vi.unstubAllGlobals()
		vi.unstubAllEnvs()
		invalidateInventoryContext()
	})

	it('pauses online ordering at this terminal’s location only, with an App preset, and resumes it', async () => {
		const paused = await call('POST', '/pause', {
			body: { action: 'pause', duration: '15m' },
		})
		expect(paused.status).toBe(200)
		expect(paused.headers.get('cache-control')).toContain('no-store')
		expect(await paused.json()).toMatchObject({
			locationId: LOCATION,
			pause: { pausedAt: PAUSED_AT, until: PAUSED_AT + 15 * 60_000 },
		})
		expect(fake.asked[0]).toMatchObject({
			path: STATION_CONTROLS_PATH,
			auth: expect.stringMatching(/^Bearer /),
			body: {
				kind: 'pause',
				orgId: ORG_A,
				locationId: LOCATION,
				duration: '15m',
				actor: { deviceId, staffId: managerId },
			},
		})
		// Ids and a duration only: no names cross to the App.
		expect(JSON.stringify(fake.asked)).not.toMatch(/Mona|Smith/)

		const resumed = await call('POST', '/pause', { body: { action: 'resume' } })
		expect(await resumed.json()).toMatchObject({ pause: null })
		expect(fake.asked[1]!.body).toMatchObject({
			kind: 'resume',
			locationId: LOCATION,
		})
	})

	it('refuses a location the body names: the terminal’s own location is the only one', async () => {
		const response = await call('POST', '/pause', {
			body: { action: 'pause', duration: '15m', locationId: 'loc-2' },
		})
		expect(response.status).toBe(400)
		expect(fake.asked).toHaveLength(0)
	})

	it('refuses a preset the App does not offer', async () => {
		const response = await call('POST', '/pause', {
			body: { action: 'pause', duration: '5m' },
		})
		expect(response.status).toBe(400)
		expect(fake.asked).toHaveLength(0)
	})

	it('marks a dish sold out and brings it back by hand', async () => {
		const off = await call('POST', '/availability', {
			body: { entityType: 'item', entityId: 'burger', available: false },
		})
		expect(off.status).toBe(200)
		expect(await off.json()).toMatchObject({ changed: true })
		expect(fake.asked[0]!.body).toEqual({
			kind: 'availability',
			orgId: ORG_A,
			locationId: LOCATION,
			entityType: 'item',
			entityId: 'burger',
			available: false,
			actor: { deviceId, staffId: managerId },
		})
		const on = await call('POST', '/availability', {
			body: { entityType: 'item', entityId: 'burger', available: true },
		})
		expect(on.status).toBe(200)
	})

	it('says when stock holds a dish off, and brings it back only through inventory’s undo', async () => {
		const id = await holdByStock('burger')
		const state = await call('GET', '')
		expect(await state.json()).toMatchObject({
			heldByStock: [
				{
					id,
					entityType: 'item',
					entityId: 'burger',
					causeItemName: 'Tomatoes',
				},
			],
		})
		const before = fake.asked.length
		const refused = await call('POST', '/availability', {
			body: { entityType: 'item', entityId: 'burger', available: true },
		})
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({ error: 'held_by_stock' })
		// Refused before anything reached the App or inventory.
		expect(fake.asked.slice(before)).toEqual([])

		const override = await call('POST', '/availability', {
			body: {
				entityType: 'item',
				entityId: 'burger',
				available: true,
				overrideStock: true,
			},
		})
		expect(override.status).toBe(200)
		expect(await override.json()).toMatchObject({
			heldByStock: [],
			changed: true,
		})
		expect(fake.asked.map((a) => a.path)).toContain(INVENTORY_AVAILABILITY_PATH)
		const db = await getTenantDb(ORG_A)
		const row = await db
			.select()
			.from(invSoldOut)
			.where(eq(invSoldOut.id, id))
			.get()
		// Undone (and then forgotten by the stock sync once the ingredient is
		// not at zero), never "out" again: the next sync leaves the dish on.
		expect(row?.state).not.toBe('out')
		const audit = await db
			.select()
			.from(invAuditLog)
			.where(eq(invAuditLog.action, 'sold_out.undo'))
		expect(audit[0]).toMatchObject({ actorKind: 'staff', actorId: managerId })
	})

	it('refuses the stock override while inventory is stopped on this node or its recipes are off', async () => {
		const id = await holdByStock('burger')
		const body = {
			entityType: 'item',
			entityId: 'burger',
			available: true,
			overrideStock: true,
		}
		vi.stubEnv('INVENTORY_ENABLED', 'false')
		const stopped = await call('POST', '/availability', { body })
		expect(stopped.status).toBe(503)
		expect(await stopped.json()).toMatchObject({
			error: 'inventory_unavailable',
		})
		vi.stubEnv('INVENTORY_ENABLED', '')
		seedInventoryContextForTest(ORG_A, {
			...INVENTORY_ON,
			recipes: false,
		})
		expect((await call('POST', '/availability', { body })).status).toBe(503)
		const db = await getTenantDb(ORG_A)
		expect(
			(await db.select().from(invSoldOut).where(eq(invSoldOut.id, id)).get())
				?.state,
		).toBe('out')
		expect(fake.asked).toHaveLength(0)
	})

	it('reports success when the undo put the dish back and only the App’s record of it failed', async () => {
		await holdByStock('burger')
		fake.failAvailability(502)
		const response = await call('POST', '/availability', {
			body: {
				entityType: 'item',
				entityId: 'burger',
				available: true,
				overrideStock: true,
			},
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			changed: true,
			heldByStock: [],
		})
	})

	it('a sold-out tap on a dish stock already holds makes the hold the person’s', async () => {
		const id = await holdByStock('burger')
		const response = await call('POST', '/availability', {
			body: { entityType: 'item', entityId: 'burger', available: false },
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ heldByStock: [] })
		const db = await getTenantDb(ORG_A)
		// The hold is the person's now: stock coming back forgets the entry
		// without ever putting the dish back on sale.
		expect(
			(await db.select().from(invSoldOut).where(eq(invSoldOut.id, id)).get())
				?.state,
		).not.toBe('out')
		expect(
			fake.asked.filter(
				(a) =>
					a.path === INVENTORY_AVAILABILITY_PATH &&
					a.body.changes.some((change: any) => change.available),
			),
		).toEqual([])
		const audit = await db
			.select()
			.from(invAuditLog)
			.where(eq(invAuditLog.action, 'sold_out.by_hand'))
		expect(audit[0]).toMatchObject({ actorKind: 'staff', actorId: managerId })
	})

	it('tells a refused request apart from an outage', async () => {
		fake.fail(401)
		expect(
			await (
				await call('POST', '/pause', { body: { action: 'resume' } })
			).json(),
		).toMatchObject({ error: 'controls_misconfigured' })
		fake.fail(404, JSON.stringify({ error: 'org_not_found' }))
		expect(
			await (
				await call('POST', '/pause', { body: { action: 'resume' } })
			).json(),
		).toMatchObject({ error: 'controls_misconfigured' })
		fake.fail(404, JSON.stringify({ error: 'location_not_found' }))
		const missing = await call('POST', '/pause', { body: { action: 'resume' } })
		expect(missing.status).toBe(404)
		expect(await missing.json()).toMatchObject({ error: 'location_not_found' })
	})

	it('answers 503 and changes nothing here when the App cannot be reached (never queued)', async () => {
		fake.fail(502)
		const response = await call('POST', '/pause', {
			body: { action: 'pause', duration: '30m' },
		})
		expect(response.status).toBe(503)
		expect(await response.json()).toMatchObject({
			error: 'controls_unavailable',
		})
	})

	describe('security', () => {
		it('needs a signed-in manager: a cashier or no sign-in is refused before the App is asked', async () => {
			for (const [method, suffix, body] of [
				['GET', '', undefined],
				['POST', '/pause', { action: 'resume' }],
				[
					'POST',
					'/availability',
					{ entityType: 'item', entityId: 'burger', available: false },
				],
			] as const) {
				const asCashier = await call(method, suffix, { body, staff: cashier })
				expect(asCashier.status, `${method} ${suffix}`).toBe(403)
				expect(await asCashier.json()).toMatchObject({
					error: 'permission_required',
				})
				const anonymous = await call(method, suffix, { body, staff: null })
				expect(anonymous.status, `${method} ${suffix}`).toBe(401)
			}
			expect(fake.asked).toHaveLength(0)
		})

		it('refuses a forged device, a revoked terminal, the app switched off and the kill switch', async () => {
			const forged = formatPosDeviceSecret(ORG_A, deviceId, 'y'.repeat(43))
			expect((await call('GET', '', { token: forged })).status).toBe(401)
			const db = await getTenantDb(ORG_A)
			await db
				.update(posDevices)
				.set({ ordersEnabled: false })
				.where(eq(posDevices.id, deviceId))
			expect((await call('GET', '')).status).toBe(403)
			await db
				.update(posDevices)
				.set({ ordersEnabled: true, revokedAt: Date.now() })
				.where(eq(posDevices.id, deviceId))
			expect((await call('GET', '')).status).toBe(401)
			const other = await addDevice()
			vi.stubEnv('POS_ENABLED', 'false')
			expect(
				(
					await call('GET', '', {
						token: other.token,
						staff: await session(managerId, other.id),
					})
				).status,
			).toBe(503)
			expect(fake.asked).toHaveLength(0)
		})
	})
})
