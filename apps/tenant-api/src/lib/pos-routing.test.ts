import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	formatPosDeviceSecret,
	formatPosPairingCode,
	randomPosToken,
} from '@repo/common/pos-orders'
import { formatKioskDeviceSecret, randomKioskToken } from '@repo/staffing'
import {
	assertKioskOrgOnUsNode,
	clearPosOrganizationCache,
	POS_LOOKUPS_PER_IP_PER_MINUTE,
	resolveOrgId,
} from '../../workers/org-router.ts'
import type { TenantApiWorkerEnv } from '../../workers/bindings.ts'
import { createTenantApiApp } from '../app.ts'
import { lookupActiveOrganization } from './origin.ts'
import { isPosEnabled } from './pos-auth.ts'

const orgs = vi.hoisted(
	() =>
		new Map<
			string,
			{ id: string; dataRegion: string; hasProvisionedDb: boolean }
		>(),
)
const controlPlane = vi.hoisted(() => ({ down: false }))

vi.mock('./origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		if (controlPlane.down) return { status: 'unavailable' }
		const found = orgs.get(id)
		return found
			? { status: 'found', organization: found }
			: { status: 'missing' }
	}),
	// Anything that is not the POS origin is an unrelated, unbound browser origin.
	isAllowedAnalyticsOrigin: vi.fn(async () => false),
}))

const ORG = 'clw9x0a12000008l00posa'
const OTHER = 'clw9x0a12000008l00posb'
const env = {
	JWT_SECRET: 'x'.repeat(40),
	TENANT_OPERATOR_TOKEN: 'y'.repeat(40),
} as unknown as TenantApiWorkerEnv

beforeEach(() => {
	clearPosOrganizationCache()
	controlPlane.down = false
	orgs.clear()
	orgs.set(ORG, { id: ORG, dataRegion: 'us', hasProvisionedDb: true })
	orgs.set(OTHER, { id: OTHER, dataRegion: 'ksa', hasProvisionedDb: true })
	vi.stubEnv('POS_ENABLED', '')
})
afterEach(() => vi.unstubAllEnvs())

const secret = (orgId: string) =>
	formatPosDeviceSecret(orgId, 'device-id-12345', randomPosToken())

const req = (path: string, init: RequestInit = {}) =>
	new Request(`https://api.test${path}`, { method: 'POST', ...init })

describe('POS routing in the org router', () => {
	it('routes a device secret to the organization it names', async () => {
		const request = req('/pos/orders', {
			headers: { authorization: `Bearer ${secret(ORG)}` },
		})
		expect(await resolveOrgId(request, env)).toBe(ORG)
	})

	it('routes a pairing code to the organization it names, from the body only', async () => {
		const code = formatPosPairingCode(ORG, randomPosToken())
		const request = req('/pos/pair', {
			body: JSON.stringify({ code }),
			headers: { 'content-type': 'application/json' },
		})
		expect(await resolveOrgId(request, env)).toBe(ORG)
		// A query-string or body orgId can never choose the organization.
		const sneaky = req(`/pos/pair?orgId=${OTHER}`, {
			body: JSON.stringify({ code, orgId: OTHER }),
		})
		expect(await resolveOrgId(sneaky, env)).toBe(ORG)
		const orgless = req(`/pos/orders?orgId=${OTHER}`, {})
		expect(await resolveOrgId(orgless, env)).toBeNull()
	})

	it('routes nowhere for missing, malformed or wrong-kind credentials', async () => {
		const bad = [
			req('/pos/orders'),
			req('/pos/orders', { headers: { authorization: 'Bearer nope' } }),
			req('/pos/orders', {
				headers: {
					authorization: `Bearer ${formatKioskDeviceSecret(ORG, 'device-id-12345', randomKioskToken())}`,
				},
			}),
			req('/pos/pair', { body: '{}' }),
			req('/pos/pair', { body: 'not json' }),
			req('/pos/pair', {
				body: JSON.stringify({ code: `kpc1.${ORG}.${randomPosToken()}` }),
			}),
		]
		for (const request of bad)
			expect(await resolveOrgId(request, env)).toBeNull()
	})

	it('does not route a kiosk secret to the POS surface or the reverse', async () => {
		const posOnKiosk = req('/kiosk/punch', {
			headers: { authorization: `Bearer ${secret(ORG)}` },
		})
		expect(await resolveOrgId(posOnKiosk, env)).toBeNull()
	})

	it('refuses terminals of unknown, wrong-region or unprovisioned organizations alike', async () => {
		orgs.set('clw9x0a12000008l00posc', {
			id: 'clw9x0a12000008l00posc',
			dataRegion: 'us',
			hasProvisionedDb: false,
		})
		for (const id of [
			OTHER,
			'clw9x0a12000008l00posc',
			'clw9x0a12000008l00nope',
		]) {
			const pair = await assertKioskOrgOnUsNode(id, '/pos/pair')
			expect(pair!.status).toBe(401)
			expect(await pair!.json()).toEqual({ error: 'invalid_pairing_code' })
			const device = await assertKioskOrgOnUsNode(id, '/pos/orders')
			expect(await device!.json()).toEqual({ error: 'invalid_device' })
		}
		expect(await assertKioskOrgOnUsNode(ORG, '/pos/orders')).toBeNull()
	})

	it('a control-plane outage is a 503 the terminal retries, never the 401 that signs it out', async () => {
		controlPlane.down = true
		const device = await assertKioskOrgOnUsNode(ORG, '/pos/orders')
		expect(device!.status).toBe(503)
		expect(await device!.json()).toEqual({ error: 'service_unavailable' })
		// Pairing too: a manager's code is not burnt by an outage, and the answer is retryable.
		expect((await assertKioskOrgOnUsNode(ORG, '/pos/pair'))!.status).toBe(503)
		// Back up: the same terminal is simply accepted again.
		controlPlane.down = false
		expect(await assertKioskOrgOnUsNode(ORG, '/pos/orders')).toBeNull()
	})

	it('a genuinely unknown organization is still the plain 401', async () => {
		expect(
			(await assertKioskOrgOnUsNode('clw9x0a12000008l00nope', '/pos/orders'))!
				.status,
		).toBe(401)
	})

	it('kiosks keep their existing behaviour (this change is POS only)', async () => {
		controlPlane.down = true
		// The kiosk path does not use the new lookup.
		expect(await assertKioskOrgOnUsNode(ORG, '/kiosk/punch')).toBeNull()
	})

	it('remembers an unknown organization briefly, so made-up ids do not each ask App', async () => {
		const lookup = vi.mocked(lookupActiveOrganization)
		lookup.mockClear()
		const nope = 'clw9x0a12000008l00nope'
		expect((await assertKioskOrgOnUsNode(nope, '/pos/orders'))!.status).toBe(
			401,
		)
		expect((await assertKioskOrgOnUsNode(nope, '/pos/orders'))!.status).toBe(
			401,
		)
		expect(lookup).toHaveBeenCalledTimes(1)
		// An outage is never remembered.
		controlPlane.down = true
		expect((await assertKioskOrgOnUsNode(ORG, '/pos/orders'))!.status).toBe(503)
		controlPlane.down = false
		expect(await assertKioskOrgOnUsNode(ORG, '/pos/orders')).toBeNull()
	})

	it('limits control-plane lookups per client address, never cached hits', async () => {
		const ip = '203.0.113.9'
		expect(await assertKioskOrgOnUsNode(ORG, '/pos/orders', ip)).toBeNull()
		for (let i = 0; i < 40; i++)
			expect(await assertKioskOrgOnUsNode(ORG, '/pos/orders', ip)).toBeNull()
		const fresh = (i: number) =>
			`clw9x0a12000008l00x${String(i).padStart(3, '0')}`
		let limited: Response | null = null
		for (let i = 0; i < POS_LOOKUPS_PER_IP_PER_MINUTE + 1; i++)
			limited = await assertKioskOrgOnUsNode(fresh(i), '/pos/orders', ip)
		expect(limited!.status).toBe(429)
		expect(await limited!.json()).toEqual({ error: 'rate_limited' })
		// Another address is unaffected.
		expect(
			(await assertKioskOrgOnUsNode(fresh(999), '/pos/orders', '198.51.100.1'))!
				.status,
		).toBe(401)
	})

	it('refuses an oversized pairing body before reading all of it', async () => {
		const code = formatPosPairingCode(ORG, randomPosToken())
		const padded = req('/pos/pair', {
			body: JSON.stringify({ code, pad: 'x'.repeat(5_000) }),
		})
		expect(await resolveOrgId(padded, env)).toBeNull()
		const declared = req('/pos/pair', {
			body: JSON.stringify({ code }),
			headers: { 'content-length': '999999' },
		})
		expect(await resolveOrgId(declared, env)).toBeNull()
		const streamed = req('/pos/pair', {
			body: new ReadableStream({
				start(controller) {
					for (let i = 0; i < 10; i++)
						controller.enqueue(new TextEncoder().encode('x'.repeat(1_000)))
					controller.close()
				},
			}),
			// @ts-expect-error Node needs this for a streamed request body
			duplex: 'half',
		})
		expect(await resolveOrgId(streamed, env)).toBeNull()
	})

	it('reads the kill switch live', () => {
		expect(isPosEnabled()).toBe(true)
		for (const off of ['false', '0', 'off', 'NO', 'disabled']) {
			vi.stubEnv('POS_ENABLED', off)
			expect(isPosEnabled()).toBe(false)
		}
		vi.stubEnv('POS_ENABLED', 'true')
		expect(isPosEnabled()).toBe(true)
	})
})

describe('POS CORS', () => {
	const POS = 'https://pos.example.com'
	const preflight = (path: string, origin: string) =>
		createTenantApiApp().request(path, {
			method: 'OPTIONS',
			headers: {
				origin,
				'access-control-request-method': 'POST',
				'access-control-request-headers':
					'content-type, authorization, idempotency-key',
			},
		})

	beforeEach(() => {
		vi.stubEnv('POS_ORIGINS', `${POS}, https://pos2.example.com`)
		vi.stubEnv('NODE_ENV', 'production')
	})

	it('allows a listed POS origin on /pos/* with the headers the till sends', async () => {
		for (const path of ['/pos/pair', '/pos/orders', '/pos/me']) {
			const r = await preflight(path, POS)
			expect(r.status).toBe(204)
			expect(r.headers.get('access-control-allow-origin')).toBe(POS)
			expect(r.headers.get('access-control-allow-headers')).toContain(
				'idempotency-key',
			)
		}
		expect(
			(await preflight('/pos/orders', 'https://pos2.example.com')).status,
		).toBe(204)
	})

	it('does not widen CORS beyond /pos/*', async () => {
		for (const path of [
			'/orders',
			'/operator/pos/terminals',
			'/auth/me',
			'/kiosk/pair',
			'/analytics/x',
		]) {
			expect((await preflight(path, POS)).status).toBe(403)
		}
	})

	it('refuses unlisted, look-alike and non-https origins', async () => {
		for (const origin of [
			'https://evil.example.com',
			'https://pos.example.com.evil.com',
			'http://pos.example.com',
			'https://pos.example.com:8443',
			'null',
		]) {
			expect((await preflight('/pos/orders', origin)).status).toBe(403)
		}
	})

	it('treats an unset NODE_ENV as production', async () => {
		vi.stubEnv('NODE_ENV', undefined)
		expect(
			(await preflight('/pos/orders', 'http://localhost:3010')).status,
		).toBe(403)
		expect((await preflight('/pos/orders', POS)).status).toBe(204)
	})

	it('forgets a POS origin as soon as it is removed from the environment', async () => {
		expect((await preflight('/pos/orders', POS)).status).toBe(204)
		vi.stubEnv('POS_ORIGINS', undefined)
		expect((await preflight('/pos/orders', POS)).status).toBe(403)
	})

	it('allows local development hosts only outside production', async () => {
		expect(
			(await preflight('/pos/orders', 'http://localhost:3010')).status,
		).toBe(403)
		vi.stubEnv('NODE_ENV', 'development')
		expect(
			(await preflight('/pos/orders', 'http://localhost:3010')).status,
		).toBe(204)
		expect((await preflight('/orders', 'http://localhost:3010')).status).toBe(
			403,
		)
	})

	it('sends CORS headers on real responses, including errors', async () => {
		const r = await createTenantApiApp().request('/pos/me', {
			headers: { origin: POS },
		})
		expect(r.status).toBe(401)
		expect(r.headers.get('access-control-allow-origin')).toBe(POS)
		expect(r.headers.get('cache-control')).toMatch(/no-store/)
	})
})
