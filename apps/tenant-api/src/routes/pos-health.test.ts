import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import { minuteBucket } from '@repo/common/device-health'
import {
	destroyTenantDb,
	getTenantDb,
	posDeviceHealthDaily,
	posDeviceHeartbeats,
	posDevices,
	posShifts,
	provisionTenantDb,
} from '@repo/tenant-db'
import {
	clearDeviceHealthFlagCache,
	seedDeviceHealthFlagForTest,
} from '../lib/pos-device-health.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import {
	recordHeartbeat,
	rollupDeviceHealth,
} from '../services/pos-health-service.ts'
import { operatorPosRoutes } from './operator-pos.ts'
import { posRoutes } from './pos.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

const ORG_A = 'org_health_a'
const ORG_B = 'org_health_b'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'
const M = 60_000
const DAY = 24 * 60 * M

const org = (id: string) => ({
	id,
	slug: id,
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
})

describe('Station connection history (#356)', () => {
	let directory: string
	let app: Hono

	const mint = (
		claims: {
			orgId?: string
			scope?: 'orders:read' | 'orders:write'
			locationIds?: string[] | null
		} = {},
	) =>
		new SignJWT({
			orgId: claims.orgId ?? ORG_A,
			role: 'operator',
			scope: claims.scope ?? 'orders:read',
			...(claims.locationIds !== undefined
				? { locationIds: claims.locationIds }
				: {}),
		})
			.setSubject('user_manager_1')
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode(operatorToken))

	const operator = async (
		pathname: string,
		claims?: Parameters<typeof mint>[0],
		token?: string | null,
	) =>
		app.request(`/operator/pos${pathname}`, {
			headers: {
				...(token === null
					? {}
					: { authorization: `Bearer ${token ?? (await mint(claims))}` }),
			},
		})

	async function pair(
		terminalCode: string,
		locationId: string | null = 'loc-1',
	) {
		const writer = await mint({ scope: 'orders:write' })
		const created = await app.request('/operator/pos/pairing-codes', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${writer}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ label: terminalCode, terminalCode, locationId }),
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

	const heartbeat = (secret: string, body: unknown) =>
		app.request('/pos/heartbeat', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${secret}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify(body),
		})

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-health-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'test-internal-token-very-long-12345')
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('POS_ENABLED', '')
		vi.stubEnv('POS_DEVICE_HEALTH_ENABLED', '')
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('down', { status: 503 })),
		)
		clearDeviceHealthFlagCache()
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === ORG_A || id === ORG_B ? (org(id) as never) : null,
		)
		await provisionTenantDb(ORG_A)
		await provisionTenantDb(ORG_B)
		app = new Hono()
		app.route('/pos', posRoutes)
		app.route('/operator/pos', operatorPosRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(ORG_A)
			await destroyTenantDb(ORG_B)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		clearDeviceHealthFlagCache()
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('stores nothing and says so while the organization flag is off, or App cannot be asked', async () => {
		const { deviceSecret, device } = await pair('H1')
		const res = await heartbeat(deviceSecret, { appVersion: '1.0.0' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ enabled: false })
		const db = await getTenantDb(ORG_A)
		expect(
			await db
				.select()
				.from(posDeviceHeartbeats)
				.where(eq(posDeviceHeartbeats.deviceId, device.id)),
		).toHaveLength(0)
		// The Health panel reads as off too.
		expect(await (await operator('/health')).json()).toMatchObject({
			enabled: false,
			devices: [],
		})
	})

	it('records one heartbeat a minute with technical facts only', async () => {
		seedDeviceHealthFlagForTest(ORG_A, true)
		const { deviceSecret, device } = await pair('H2')
		const body = {
			appVersion: '1.4.2',
			browser: 'Chrome 130',
			batteryPct: 64,
			charging: false,
			storageUsedMb: 120,
			storageQuotaMb: 4000,
			pendingUploads: 3,
			lastUploadAt: Date.now() - 5 * M,
		}
		expect(await (await heartbeat(deviceSecret, body)).json()).toEqual({
			enabled: true,
		})
		// A second one in the same minute overwrites the first.
		await heartbeat(deviceSecret, { ...body, pendingUploads: 1 })
		const db = await getTenantDb(ORG_A)
		const rows = await db
			.select()
			.from(posDeviceHeartbeats)
			.where(eq(posDeviceHeartbeats.deviceId, device.id))
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			appVersion: '1.4.2',
			batteryPct: 64,
			pendingUploads: 1,
			printerState: null,
			drawerOpenedAt: null,
		})
		// Nothing that could name a person or an order is a column, or accepted.
		expect(Object.keys(rows[0]!).sort()).toEqual(
			[
				'appVersion',
				'batteryPct',
				'browser',
				'charging',
				'deviceId',
				'drawerOpenedAt',
				'drawerShiftId',
				'lastUploadAt',
				'minuteBucket',
				'pendingUploads',
				'printerState',
				'storageQuotaMb',
				'storageUsedMb',
			].sort(),
		)
		for (const bad of [
			{ staffName: 'Sam' },
			{ orders: [{ id: 'o1' }] },
			{ customerPhone: '+1555' },
			{ batteryPct: 500 },
		])
			expect((await heartbeat(deviceSecret, bad)).status).toBe(400)
	})

	it('refuses a heartbeat from a stranger or a removed terminal', async () => {
		seedDeviceHealthFlagForTest(ORG_A, true)
		const { deviceSecret, device } = await pair('H3')
		expect((await heartbeat('forged.secret', {})).status).toBe(401)
		const noAuth = await app.request('/pos/heartbeat', {
			method: 'POST',
			body: '{}',
		})
		expect(noAuth.status).toBe(401)
		const writer = await mint({ scope: 'orders:write' })
		await app.request(`/operator/pos/terminals/${device.id}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${writer}` },
		})
		expect((await heartbeat(deviceSecret, {})).status).toBe(401)
	})

	it('answers the week as check-in intervals, the last report, and drops printer and drawer rows nobody reported', async () => {
		seedDeviceHealthFlagForTest(ORG_A, true)
		const { device } = await pair('H4')
		const db = await getTenantDb(ORG_A)
		const now = minuteBucket(Date.now())
		for (let i = 60; i > 40; i--)
			await recordHeartbeat(db, device, { appVersion: '1.0.0' }, now - i * M)
		// A 17-minute silence, then back with a report that includes a drawer.
		for (let i = 23; i >= 0; i--)
			await recordHeartbeat(
				db,
				device,
				{
					appVersion: '1.0.1',
					batteryPct: 50,
					pendingUploads: 2,
					...(i === 0
						? {
								drawerOpenedAt: now - 5 * M,
								drawerShiftId: 'shift-9',
								printerState: 'out_of_paper' as const,
							}
						: {}),
				},
				now - i * M,
			)
		await db.insert(posShifts).values({
			id: 'shift-1',
			deviceId: device.id,
			status: 'open',
			businessDate: '2026-11-18',
			openedAt: now - 3 * 60 * M,
			openingFloatCents: 0,
			revision: 1,
			createdAt: now,
			updatedAt: now,
		} as never)
		const body = (await (await operator(`/health/${device.id}`)).json()) as any
		expect(body.enabled).toBe(true)
		expect(body.presence).toEqual([
			{ startMs: now - 60 * M, endMs: now - 40 * M },
			{ startMs: now - 23 * M, endMs: now + M },
		])
		expect(body.firstSeenAt).toBe(now - 60 * M)
		expect(body.latest).toMatchObject({
			appVersion: '1.0.1',
			batteryPct: 50,
			pendingUploads: 2,
			printerState: 'out_of_paper',
			drawerShiftId: 'shift-9',
		})
		expect(body.lastShiftOpened).toEqual({
			id: 'shift-1',
			openedAt: now - 3 * 60 * M,
		})
		// A terminal that reports no printer or drawer shows none.
		const quiet = await pair('H5')
		await recordHeartbeat(db, quiet.device, { appVersion: '1.0.0' }, now)
		const quietBody = (await (
			await operator(`/health/${quiet.device.id}`)
		).json()) as any
		expect(quietBody.latest.printerState).toBeNull()
		expect(quietBody.latest.drawerOpenedAt).toBeNull()
		// The list carries both terminals' intervals.
		const list = (await (await operator('/health')).json()) as any
		expect(list.devices.map((d: any) => d.terminalCode).sort()).toEqual([
			'H4',
			'H5',
		])
	})

	it('shows a member only terminals at their own locations, and nothing across organizations', async () => {
		seedDeviceHealthFlagForTest(ORG_A, true)
		seedDeviceHealthFlagForTest(ORG_B, true)
		const near = await pair('N1', 'loc-1')
		const far = await pair('F1', 'loc-2')
		const db = await getTenantDb(ORG_A)
		await recordHeartbeat(db, near.device, {})
		await recordHeartbeat(db, far.device, {})
		const scoped = { locationIds: ['loc-1'] }
		const list = (await (await operator('/health', scoped)).json()) as any
		expect(list.devices.map((d: any) => d.terminalCode)).toEqual(['N1'])
		expect((await operator(`/health/${far.device.id}`, scoped)).status).toBe(
			404,
		)
		expect((await operator(`/health/${near.device.id}`, scoped)).status).toBe(
			200,
		)
		const foreign = await operator(`/health/${near.device.id}`, {
			orgId: ORG_B,
		})
		expect(foreign.status).toBe(404)
		expect((await operator('/health', undefined, null)).status).toBe(401)
		expect((await operator('/health', undefined, 'forged')).status).toBe(401)
	})

	it('the node kill switch stops collecting and reading', async () => {
		seedDeviceHealthFlagForTest(ORG_A, true)
		vi.stubEnv('POS_DEVICE_HEALTH_ENABLED', 'false')
		const { deviceSecret } = await pair('K1')
		expect(await (await heartbeat(deviceSecret, {})).json()).toEqual({
			enabled: false,
		})
		expect(await (await operator('/health')).json()).toMatchObject({
			enabled: false,
		})
	})

	it('keeps 30 days of minutes, summarizes older days, and forgets a terminal removed over 30 days ago', async () => {
		const { device } = await pair('R1')
		const gone = await pair('R2')
		const db = await getTenantDb(ORG_A)
		const now = minuteBucket(Date.now())
		const old = now - 40 * DAY
		for (let i = 0; i < 30; i++)
			await recordHeartbeat(
				db,
				device,
				{ appVersion: '0.9.0', batteryPct: 90 - i, pendingUploads: i },
				old + i * M,
			)
		await recordHeartbeat(db, device, { appVersion: '1.0.0' }, now - DAY)
		await recordHeartbeat(db, gone.device, {}, now - DAY)
		await db
			.update(posDevices)
			.set({ revokedAt: now - 31 * DAY })
			.where(eq(posDevices.id, gone.device.id))
		expect(await rollupDeviceHealth(db, now)).toEqual({ summarized: 30 })
		const rows = await db
			.select()
			.from(posDeviceHeartbeats)
			.where(eq(posDeviceHeartbeats.deviceId, device.id))
		expect(rows).toHaveLength(1)
		const daily = await db
			.select()
			.from(posDeviceHealthDaily)
			.where(eq(posDeviceHealthDaily.deviceId, device.id))
		expect(daily).toHaveLength(1)
		expect(daily[0]).toMatchObject({
			heartbeats: 30,
			firstAt: old,
			lastAt: old + 29 * M,
			appVersion: '0.9.0',
			minBatteryPct: 61,
			maxPendingUploads: 29,
		})
		// The removed terminal's history is gone.
		expect(
			await db
				.select()
				.from(posDeviceHeartbeats)
				.where(eq(posDeviceHeartbeats.deviceId, gone.device.id)),
		).toHaveLength(0)
		// A second run adds nothing and keeps the summary.
		expect(await rollupDeviceHealth(db, now)).toEqual({ summarized: 0 })
	})

	it('a terminal removed under 30 days ago keeps its history, read-only', async () => {
		seedDeviceHealthFlagForTest(ORG_A, true)
		const { device } = await pair('V1')
		const db = await getTenantDb(ORG_A)
		await recordHeartbeat(db, device, {})
		const writer = await mint({ scope: 'orders:write' })
		await app.request(`/operator/pos/terminals/${device.id}`, {
			method: 'DELETE',
			headers: { authorization: `Bearer ${writer}` },
		})
		const body = (await (await operator(`/health/${device.id}`)).json()) as any
		expect(body.device.revokedAt).not.toBeNull()
		expect(body.presence).toHaveLength(1)
		await db
			.update(posDevices)
			.set({ revokedAt: Date.now() - 31 * DAY })
			.where(eq(posDevices.id, device.id))
		expect((await operator(`/health/${device.id}`)).status).toBe(404)
	})
})
