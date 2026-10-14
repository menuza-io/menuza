import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	formatKioskDeviceSecret,
	formatKioskPairingCode,
	randomKioskToken,
} from '@repo/staffing'
import {
	assertKioskOrgOnUsNode,
	resolveOrgId,
} from '../../workers/org-router.ts'
import {
	makeOrg,
	mintStaffToken,
	ORG_A,
	ORG_B,
	OPERATOR_SECRET,
	stubStaffEnv,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import { isKioskEnabled } from './kiosk-auth.ts'

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('./origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))
vi.mock('@repo/sms', () => ({ sendSms: vi.fn() }))

const env = {
	TENANT_OPERATOR_TOKEN: OPERATOR_SECRET,
	JWT_SECRET: 'test-jwt-secret-123456789',
} as never

beforeEach(() => {
	orgs.clear()
	orgs.set(ORG_A, makeOrg(ORG_A))
	orgs.set(ORG_B, makeOrg(ORG_B, { dataRegion: 'ksa' }))
	stubStaffEnv('/tmp/kiosk-auth-unused')
	vi.stubEnv('STAFFING_KIOSK_ENABLED', '')
})
afterEach(() => {
	vi.unstubAllEnvs()
})

const deviceSecret = (orgId: string) =>
	formatKioskDeviceSecret(orgId, 'device-id-12345', randomKioskToken())

describe('kiosk routing in the org router', () => {
	it('routes a device secret to the organization it names', async () => {
		const orgId = await resolveOrgId(
			new Request('https://api.test/kiosk/punch', {
				method: 'POST',
				headers: { Authorization: `Bearer ${deviceSecret(ORG_B)}` },
				body: '{}',
			}),
			env,
		)
		expect(orgId).toBe(ORG_B)
	})

	it('routes pairing by the code in the body', async () => {
		const code = formatKioskPairingCode(ORG_A, randomKioskToken())
		const orgId = await resolveOrgId(
			new Request('https://api.test/kiosk/pair', {
				method: 'POST',
				body: JSON.stringify({ code }),
			}),
			env,
		)
		expect(orgId).toBe(ORG_A)
	})

	it('never lets a query string or body org id choose the organization', async () => {
		const secret = deviceSecret(ORG_A)
		const viaQuery = await resolveOrgId(
			new Request(`https://api.test/kiosk/punch?orgId=${ORG_B}`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${secret}` },
				body: JSON.stringify({ orgId: ORG_B }),
			}),
			env,
		)
		expect(viaQuery).toBe(ORG_A)
		// With no credential at all, a query or body org id routes nowhere.
		for (const request of [
			new Request(`https://api.test/kiosk/punch?orgId=${ORG_B}`, {
				method: 'POST',
				body: JSON.stringify({ orgId: ORG_B }),
			}),
			new Request('https://api.test/kiosk/pair', {
				method: 'POST',
				body: JSON.stringify({ orgId: ORG_B }),
			}),
			new Request('https://api.test/kiosk/config', {
				headers: { Authorization: 'Bearer nope' },
			}),
		]) {
			expect(await resolveOrgId(request, env)).toBeNull()
		}
	})

	it('does not route an operator token on a kiosk path', async () => {
		const token = await mintStaffToken({ orgId: ORG_B, scope: 'timeclock' })
		const orgId = await resolveOrgId(
			new Request('https://api.test/kiosk/config', {
				headers: { Authorization: `Bearer ${token}` },
			}),
			env,
		)
		expect(orgId).toBeNull()
	})

	it('routes timeclock operator tokens like the other staffing scopes', async () => {
		const token = await mintStaffToken({ orgId: ORG_B, scope: 'timeclock' })
		const orgId = await resolveOrgId(
			new Request('https://api.test/operator/timeclock/policies', {
				headers: { Authorization: `Bearer ${token}` },
			}),
			env,
		)
		expect(orgId).toBe(ORG_B)
	})

	it('refuses to wake a Durable Object for an unknown or foreign-region organization', async () => {
		expect(await assertKioskOrgOnUsNode(ORG_A, '/kiosk/punch')).toBeNull()
		for (const [orgId, path, error] of [
			['nobody', '/kiosk/punch', 'invalid_device'],
			[ORG_B, '/kiosk/punch', 'invalid_device'],
			['nobody', '/kiosk/pair', 'invalid_pairing_code'],
		] as const) {
			const denied = await assertKioskOrgOnUsNode(orgId, path)
			expect(denied?.status).toBe(401)
			expect(await denied?.json()).toEqual({ error })
		}
		orgs.set(ORG_A, makeOrg(ORG_A, { hasProvisionedDb: false }))
		expect((await assertKioskOrgOnUsNode(ORG_A, '/kiosk/config'))?.status).toBe(
			401,
		)
	})
})

describe('STAFFING_KIOSK_ENABLED', () => {
	it.each([
		['', true],
		['true', true],
		['1', true],
		['yes', true],
		['anything else', true],
		['false', false],
		[' FALSE ', false],
		['0', false],
		['off', false],
		['No', false],
		['disabled', false],
	])('%j enables=%s', (value, expected) => {
		vi.stubEnv('STAFFING_KIOSK_ENABLED', value)
		expect(isKioskEnabled()).toBe(expected)
	})
})
