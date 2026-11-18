import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import {
	DEFAULT_TERMINAL_SETTINGS,
	type TerminalSettings,
} from '@repo/common/terminal-profiles'
import {
	destroyTenantDb,
	getTenantDb,
	posDevices,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { operatorPosRoutes } from './operator-pos.ts'
import { posRoutes } from './pos.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

const ORG_A = 'org_profiles_a'
const ORG_B = 'org_profiles_b'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'

const org = (id: string) => ({
	id,
	slug: id,
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
})

type Claims = {
	scope?: 'orders:read' | 'orders:write'
	orgId?: string
	stationApps?: Record<string, unknown>
	locationIds?: string[] | null
}

describe('Terminal profiles (#373)', () => {
	let directory: string
	let app: Hono

	const mint = (claims: Claims = {}) =>
		new SignJWT({
			orgId: claims.orgId ?? ORG_A,
			role: 'operator',
			scope: claims.scope ?? 'orders:write',
			...(claims.stationApps ? { stationApps: claims.stationApps } : {}),
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
		method: string,
		pathname: string,
		options: { body?: unknown; claims?: Claims; token?: string | null } = {},
	) => {
		const token =
			options.token === undefined ? await mint(options.claims) : options.token
		return app.request(`/operator/pos${pathname}`, {
			method,
			headers: {
				...(token ? { authorization: `Bearer ${token}` } : {}),
				'content-type': 'application/json',
			},
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
		})
	}

	const settings = (
		patch: Partial<TerminalSettings> = {},
	): TerminalSettings => ({
		...DEFAULT_TERMINAL_SETTINGS,
		...patch,
	})

	async function createProfile(
		name: string,
		patch: Partial<TerminalSettings> = {},
		claims?: Claims,
	) {
		const res = await operator('POST', '/profiles', {
			body: { name, settings: settings(patch) },
			claims,
		})
		expect(res.status).toBe(201)
		return ((await res.json()) as { profile: { id: string; version: number } })
			.profile
	}

	async function pair(options: {
		terminalCode: string
		profileId?: string
		locationId?: string | null
		signInRequired?: boolean
	}) {
		const created = await operator('POST', '/pairing-codes', {
			body: {
				label: `Till ${options.terminalCode}`,
				terminalCode: options.terminalCode,
				locationId:
					options.locationId === undefined ? 'loc-1' : options.locationId,
				signInRequired: options.signInRequired,
				profileId: options.profileId,
			},
		})
		expect(created.status).toBe(201)
		const { code } = (await created.json()) as { code: string }
		const paired = await app.request('/pos/pair', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code }),
		})
		expect(paired.status).toBe(201)
		return (await paired.json()) as {
			deviceSecret: string
			device: { id: string }
		}
	}

	const terminals = async () =>
		(
			(await (await operator('GET', '/terminals')).json()) as {
				devices: Array<
					TerminalSettings & {
						id: string
						profileId: string | null
						overrides: string[]
						terminalCode: string
					}
				>
			}
		).devices

	const me = async (secret: string) =>
		(await (
			await app.request('/pos/me', {
				headers: { authorization: `Bearer ${secret}` },
			})
		).json()) as {
			device: Record<string, unknown>
			profile: { id: string; name: string } | null
		}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-profiles-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'test-internal-token-very-long-12345')
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('POS_ENABLED', '')
		// App is not reachable in these tests: locations are taken as given.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('down', { status: 503 })),
		)
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
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	it('a terminal paired with a profile starts on its settings and says so on check-in', async () => {
		const profile = await createProfile('Counter', {
			signInRequired: true,
			shiftsRequired: true,
			idleLockSeconds: 300,
			menuColumns: 3,
			kdsStationId: 'bar',
		})
		const { deviceSecret, device } = await pair({
			terminalCode: 'C1',
			profileId: profile.id,
		})
		const [row] = (await terminals()).filter((d) => d.id === device.id)
		expect(row).toMatchObject({
			profileId: profile.id,
			overrides: [],
			signInRequired: true,
			shiftsRequired: true,
			idleLockSeconds: 300,
			menuColumns: 3,
			kdsStationId: 'bar',
		})
		const checkIn = await me(deviceSecret)
		expect(checkIn.profile).toEqual({ id: profile.id, name: 'Counter' })
		expect(checkIn.device).toMatchObject({
			idleLockSeconds: 300,
			menuColumns: 3,
			kdsStationId: 'bar',
			shiftsRequired: true,
		})
	})

	it('a terminal with no profile and no stored settings tells the till nothing to override', async () => {
		const { deviceSecret } = await pair({ terminalCode: 'N1' })
		const checkIn = await me(deviceSecret)
		expect(checkIn.profile).toBeNull()
		for (const key of [
			'idleLockSeconds',
			'kdsStationId',
			'menuColumns',
			'menuDensity',
			'guestDisplayEnabled',
			'guestDisplayImageUrl',
		])
			expect(checkIn.device).not.toHaveProperty(key)
	})

	it('changing a profile changes every inheriting terminal', async () => {
		const profile = await createProfile('Bar', { idleLockSeconds: 120 })
		const first = await pair({ terminalCode: 'B1', profileId: profile.id })
		const second = await pair({ terminalCode: 'B2', profileId: profile.id })
		const other = await pair({ terminalCode: 'X1' })
		const res = await operator('PUT', `/profiles/${profile.id}`, {
			body: {
				name: 'Bar',
				expectedVersion: profile.version,
				settings: settings({
					idleLockSeconds: 30,
					shiftsRequired: true,
					menuDensity: 'compact',
					kdsStationId: 'bar',
				}),
			},
		})
		expect(res.status).toBe(200)
		expect(
			((await res.json()) as { updatedTerminals: number }).updatedTerminals,
		).toBe(2)
		const rows = await terminals()
		for (const id of [first.device.id, second.device.id])
			expect(rows.find((d) => d.id === id)).toMatchObject({
				idleLockSeconds: 30,
				shiftsRequired: true,
				menuDensity: 'compact',
				kdsStationId: 'bar',
				overrides: [],
			})
		// A terminal on no profile is untouched.
		expect(rows.find((d) => d.id === other.device.id)).toMatchObject({
			shiftsRequired: false,
			profileId: null,
		})
		expect((await me(first.deviceSecret)).device).toMatchObject({
			idleLockSeconds: 30,
			shiftsRequired: true,
		})
	})

	it('an overridden setting stays unchanged and is listed as overridden', async () => {
		const profile = await createProfile('Counter', {
			idleLockSeconds: 120,
			kdsStationId: 'kitchen',
		})
		const { device } = await pair({ terminalCode: 'O1', profileId: profile.id })
		const patched = await operator('PATCH', `/terminals/${device.id}`, {
			body: { idleLockSeconds: 600, shiftsRequired: false },
		})
		expect(patched.status).toBe(200)
		// Only the value that differs from the profile counts as an override.
		expect((await terminals()).find((d) => d.id === device.id)).toMatchObject({
			idleLockSeconds: 600,
			overrides: ['idleLockSeconds'],
		})
		const res = await operator('PUT', `/profiles/${profile.id}`, {
			body: {
				name: 'Counter',
				expectedVersion: profile.version,
				settings: settings({
					idleLockSeconds: 30,
					kdsStationId: 'bar',
					shiftsRequired: true,
				}),
			},
		})
		expect(res.status).toBe(200)
		expect((await terminals()).find((d) => d.id === device.id)).toMatchObject({
			// Overridden: kept as the manager set it, still marked.
			idleLockSeconds: 600,
			overrides: ['idleLockSeconds'],
			// Inherited: follows the profile.
			kdsStationId: 'bar',
			shiftsRequired: true,
		})
	})

	it('setting an override back to the profile value, or resetting it, ends the override', async () => {
		const profile = await createProfile('Counter', { idleLockSeconds: 120 })
		const { device } = await pair({ terminalCode: 'R1', profileId: profile.id })
		await operator('PATCH', `/terminals/${device.id}`, {
			body: { idleLockSeconds: 600, menuDensity: 'compact' },
		})
		expect(
			(await terminals()).find((d) => d.id === device.id)?.overrides,
		).toEqual(['idleLockSeconds', 'menuDensity'])
		await operator('PATCH', `/terminals/${device.id}`, {
			body: { idleLockSeconds: 120 },
		})
		expect(
			(await terminals()).find((d) => d.id === device.id)?.overrides,
		).toEqual(['menuDensity'])
		const reset = await operator('PATCH', `/terminals/${device.id}`, {
			body: { resetOverrides: 'all' },
		})
		expect(reset.status).toBe(200)
		expect((await terminals()).find((d) => d.id === device.id)).toMatchObject({
			menuDensity: 'comfortable',
			overrides: [],
		})
	})

	it('an override that a profile change makes equal to the profile is no longer shown as one', async () => {
		const profile = await createProfile('Counter', { menuColumns: 'auto' })
		const { device } = await pair({ terminalCode: 'E1', profileId: profile.id })
		await operator('PATCH', `/terminals/${device.id}`, {
			body: { menuColumns: 4 },
		})
		await operator('PUT', `/profiles/${profile.id}`, {
			body: {
				name: 'Counter',
				expectedVersion: profile.version,
				settings: settings({ menuColumns: 4 }),
			},
		})
		expect((await terminals()).find((d) => d.id === device.id)).toMatchObject({
			menuColumns: 4,
			overrides: [],
		})
	})

	it('refuses to delete a profile in use, and deletes it once nothing uses it', async () => {
		const profile = await createProfile('Counter')
		const { device } = await pair({ terminalCode: 'D1', profileId: profile.id })
		const refused = await operator('DELETE', `/profiles/${profile.id}`)
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({
			error: 'profile_in_use',
			terminals: 1,
		})
		// Detaching the terminal frees the profile.
		await operator('PATCH', `/terminals/${device.id}`, {
			body: { profileId: null },
		})
		expect((await terminals()).find((d) => d.id === device.id)).toMatchObject({
			profileId: null,
			overrides: [],
		})
		const deleted = await operator('DELETE', `/profiles/${profile.id}`)
		expect(deleted.status).toBe(200)
		expect(
			(
				(await (await operator('GET', '/profiles')).json()) as {
					profiles: unknown[]
				}
			).profiles,
		).toHaveLength(0)
	})

	it('a pairing code waiting to start a terminal also keeps its profile from being deleted', async () => {
		const profile = await createProfile('Counter')
		await operator('POST', '/pairing-codes', {
			body: { label: 'Soon', terminalCode: 'S1', profileId: profile.id },
		})
		const refused = await operator('DELETE', `/profiles/${profile.id}`)
		expect(refused.status).toBe(409)
		expect(await refused.json()).toMatchObject({ pendingCodes: 1 })
	})

	it('a removed terminal does not hold a profile, and is detached', async () => {
		const profile = await createProfile('Counter')
		const { device } = await pair({ terminalCode: 'V1', profileId: profile.id })
		await operator('DELETE', `/terminals/${device.id}`)
		expect((await operator('DELETE', `/profiles/${profile.id}`)).status).toBe(
			200,
		)
		const db = await getTenantDb(ORG_A)
		const [row] = await db
			.select({ profileId: posDevices.profileId })
			.from(posDevices)
			.where(eq(posDevices.id, device.id))
		expect(row?.profileId).toBeNull()
	})

	it('changes nothing when one terminal cannot take the change, and names it', async () => {
		const profile = await createProfile('Counter')
		const located = await pair({ terminalCode: 'L1', profileId: profile.id })
		const unlocated = await pair({
			terminalCode: 'U1',
			profileId: profile.id,
			locationId: null,
		})
		const res = await operator('PUT', `/profiles/${profile.id}`, {
			body: {
				name: 'Counter',
				expectedVersion: profile.version,
				// The Orders app needs sign-in and a location.
				settings: settings({ ordersEnabled: true, signInRequired: true }),
			},
		})
		expect(res.status).toBe(422)
		expect(await res.json()).toMatchObject({
			error: 'profile_conflict',
			terminals: [{ terminalCode: 'U1' }],
		})
		const rows = await terminals()
		expect(rows.find((d) => d.id === located.device.id)?.ordersEnabled).toBe(
			false,
		)
		expect(rows.find((d) => d.id === unlocated.device.id)?.ordersEnabled).toBe(
			false,
		)
		// The profile itself did not change either.
		const [again] = (
			(await (await operator('GET', '/profiles')).json()) as {
				profiles: Array<{ version: number; settings: TerminalSettings }>
			}
		).profiles
		expect(again).toMatchObject({ version: profile.version })
		expect(again?.settings.ordersEnabled).toBe(false)
	})

	it('answers a stale edit with 409 and a duplicate name with 409', async () => {
		const profile = await createProfile('Counter')
		await createProfile('Bar')
		const stale = await operator('PUT', `/profiles/${profile.id}`, {
			body: {
				name: 'Counter',
				expectedVersion: profile.version + 1,
				settings: settings(),
			},
		})
		expect(stale.status).toBe(409)
		expect(await stale.json()).toMatchObject({ error: 'stale_version' })
		const taken = await operator('PUT', `/profiles/${profile.id}`, {
			body: {
				name: 'Bar',
				expectedVersion: profile.version,
				settings: settings(),
			},
		})
		expect(taken.status).toBe(409)
		expect(await taken.json()).toMatchObject({ error: 'name_taken' })
	})

	it('refuses forged, signed-out, read-only and foreign-organization callers', async () => {
		const profile = await createProfile('Counter')
		const body = { name: 'X', settings: settings() }
		expect((await operator('GET', '/profiles', { token: null })).status).toBe(
			401,
		)
		expect(
			(await operator('GET', '/profiles', { token: 'forged.token.value' }))
				.status,
		).toBe(401)
		const read: Claims = { scope: 'orders:read' }
		expect((await operator('GET', '/profiles', { claims: read })).status).toBe(
			200,
		)
		expect(
			(await operator('POST', '/profiles', { body, claims: read })).status,
		).toBe(403)
		expect(
			(
				await operator('PUT', `/profiles/${profile.id}`, {
					body: { ...body, expectedVersion: 1 },
					claims: read,
				})
			).status,
		).toBe(403)
		expect(
			(await operator('DELETE', `/profiles/${profile.id}`, { claims: read }))
				.status,
		).toBe(403)
		// Another organization's token reads its own (empty) list, never this one.
		const foreign = await operator('GET', '/profiles', {
			claims: { orgId: ORG_B, scope: 'orders:read' },
		})
		expect(
			((await foreign.json()) as { profiles: unknown[] }).profiles,
		).toEqual([])
		const crossDelete = await operator('DELETE', `/profiles/${profile.id}`, {
			claims: { orgId: ORG_B },
		})
		expect(crossDelete.status).toBe(404)
		// Unknown keys and values outside the registry are refused.
		for (const bad of [
			{ name: 'X', settings: { ...settings(), extra: true } },
			{ name: 'X', settings: settings({ idleLockSeconds: 7 }) },
			{
				name: 'X',
				settings: settings({ guestDisplayImageUrl: 'http://x.test/a.png' }),
			},
			{ name: '', settings: settings() },
		])
			expect((await operator('POST', '/profiles', { body: bad })).status).toBe(
				400,
			)
	})

	it('switching a Station app on through a profile needs the same permission as on a terminal', async () => {
		const noPermission = await operator('POST', '/profiles', {
			body: {
				name: 'Stock',
				settings: settings({ inventoryEnabled: true, signInRequired: true }),
			},
		})
		// Creating a profile only stores it; the permission is checked for each
		// terminal that takes it.
		expect(noPermission.status).toBe(201)
		const profile = (
			(await noPermission.json()) as {
				profile: { id: string; version: number }
			}
		).profile
		const { device } = await pair({
			terminalCode: 'P1',
			signInRequired: true,
		})
		const denied = await operator('PATCH', `/terminals/${device.id}`, {
			body: { profileId: profile.id },
		})
		expect(denied.status).toBe(403)
		expect(await denied.json()).toMatchObject({
			error: 'inventory_permission_required',
		})
		const allowed = await operator('PATCH', `/terminals/${device.id}`, {
			body: { profileId: profile.id },
			claims: {
				stationApps: {
					inventory: true,
					inventoryLocationIds: null,
				},
			},
		})
		expect(allowed.status).toBe(200)
		expect((await terminals()).find((d) => d.id === device.id)).toMatchObject({
			inventoryEnabled: true,
			profileId: profile.id,
		})
	})
})
