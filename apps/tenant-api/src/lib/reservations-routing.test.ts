import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
} from '@repo/reservations'
import { SignJWT } from 'jose'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TenantApiWorkerEnv } from '../../workers/bindings.ts'
import { resolveOrgId } from '../../workers/org-router.ts'

const resolveOrigin = vi.hoisted(() => vi.fn())

vi.mock('./origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./origin.ts')>()),
	resolveOrganizationForBrowserAuth: resolveOrigin,
}))

const JWT_SECRET = 'c'.repeat(40)
const OPERATOR_SECRET = 'o'.repeat(40)

const env = {
	JWT_SECRET,
	TENANT_OPERATOR_TOKEN: OPERATOR_SECRET,
} as unknown as TenantApiWorkerEnv

const ORG_A = 'clw9x0a12000008l00rsvorga'
const ORG_B = 'clw9x0a12000008l00rsvorgb'

async function signOperatorJwt(orgId: string) {
	const now = Math.floor(Date.now() / 1000)
	return new SignJWT({
		role: 'operator',
		region: 'us',
		orgId,
		scope: 'book',
		grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION],
		locationIds: null,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			payments: true,
			experiences: true,
			voice: false,
		},
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuer(brand.shortName)
		.setSubject('user_1')
		.setIssuedAt(now)
		.setExpirationTime(now + 900)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

async function signCustomerJwt(orgId: string) {
	const now = Math.floor(Date.now() / 1000)
	return new SignJWT({
		type: 'access',
		orgId,
	})
		.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
		.setAudience('tenant-api')
		.setIssuer(brand.slug)
		.setSubject('cust_1')
		.setIssuedAt(now)
		.setExpirationTime(now + 900)
		.sign(new TextEncoder().encode(JWT_SECRET))
}

describe('reservations routing on the Workers edge (VAL-FND-017)', () => {
	beforeEach(() => {
		resolveOrigin.mockReset()
		resolveOrigin.mockImplementation(
			async (
				origin: string | undefined,
				identity?: { slug?: string; host?: string },
			) => {
				if (
					origin === 'https://acme.menuza.test' ||
					identity?.slug === 'acme'
				) {
					return { id: ORG_A }
				}
				return null
			},
		)
	})

	it('routes /operator/reservations/* from the operator JWT and ignores query/body orgId', async () => {
		const token = await signOperatorJwt(ORG_A)
		const req = new Request(
			`https://api.test/operator/reservations/book?orgId=${ORG_B}`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ orgId: ORG_B }),
			},
		)
		expect(await resolveOrgId(req, env)).toBe(ORG_A)

		const unauthReq = new Request(
			`https://api.test/operator/reservations/book?orgId=${ORG_B}`,
		)
		expect(await resolveOrgId(unauthReq, env)).toBeNull()
	})

	it('routes /reservations/* from customer JWT or Origin + slug/host, never from client orgId', async () => {
		// Origin + slug
		const publicGet = new Request(
			`https://api.test/reservations/config?slug=acme&orgId=${ORG_B}`,
			{
				headers: { Origin: 'https://acme.menuza.test' },
			},
		)
		expect(await resolveOrgId(publicGet, env)).toBe(ORG_A)

		// Customer JWT
		const custToken = await signCustomerJwt(ORG_A)
		const custReq = new Request(
			`https://api.test/reservations/me?orgId=${ORG_B}`,
			{
				headers: { Authorization: `Bearer ${custToken}` },
			},
		)
		expect(await resolveOrgId(custReq, env)).toBe(ORG_A)

		// Unknown origin and no customer JWT -> null even if body/query claims ORG_B
		const forgedPost = new Request(
			`https://api.test/reservations/holds?orgId=${ORG_B}`,
			{
				method: 'POST',
				headers: {
					Origin: 'https://evil.example.com',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ orgId: ORG_B }),
			},
		)
		expect(await resolveOrgId(forgedPost, env)).toBeNull()
	})

	it('routes /internal/reservations/*, /api/reservations/*, and /api/voice/actions/* by JSON body orgId', async () => {
		for (const path of [
			'/internal/reservations/context-changed',
			'/api/reservations/tick',
			'/api/voice/actions/reservation-create',
		]) {
			const withOrg = new Request(`https://api.test${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ orgId: ORG_A }),
			})
			expect(await resolveOrgId(withOrg, env)).toBe(ORG_A)

			const malformed = new Request(`https://api.test${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ orgId: '../bad' }),
			})
			expect(await resolveOrgId(malformed, env)).toBeNull()
		}

		// Tick without orgId returns null so the edge worker fans out across all DOs
		const fanoutTick = new Request('https://api.test/api/reservations/tick', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		})
		expect(await resolveOrgId(fanoutTick, env)).toBeNull()
	})
})
