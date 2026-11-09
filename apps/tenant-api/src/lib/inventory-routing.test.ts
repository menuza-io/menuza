import { brand } from '@repo/config/brand'
import {
	INVENTORY_PERMISSIONS,
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_TYP,
} from '@repo/inventory'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import type { TenantApiWorkerEnv } from '../../workers/bindings.ts'
import { resolveOrgId } from '../../workers/org-router.ts'

/**
 * On Workers, `/operator/inventory/*` must reach the organization's Durable
 * Object named by the signed `inv+jwt`, never by a query or body orgId.
 */

const OPERATOR_SECRET = 'o'.repeat(40)
const env = {
	JWT_SECRET: 'c'.repeat(40),
	TENANT_OPERATOR_TOKEN: OPERATOR_SECRET,
} as unknown as TenantApiWorkerEnv

const ORG_A = 'clw9x0a12000008l00invorga'
const ORG_B = 'clw9x0a12000008l00invorgb'

async function signInventoryJwt(orgId: string, secret = OPERATOR_SECRET) {
	const now = Math.floor(Date.now() / 1000)
	return new SignJWT({
		role: 'operator',
		region: 'us',
		orgId,
		scope: 'read',
		grants: [INVENTORY_PERMISSIONS.READ_INVENTORY],
		locationIds: null,
		features: {
			enabled: true,
			purchasing: false,
			recipes: false,
			prep: false,
			transfers: false,
		},
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: INVENTORY_TOKEN_TYP })
		.setAudience(INVENTORY_TOKEN_AUDIENCE)
		.setIssuer(brand.shortName)
		.setSubject('user_1')
		.setIssuedAt(now)
		.setExpirationTime(now + 900)
		.sign(new TextEncoder().encode(secret))
}

describe('Workers routing for operator inventory', () => {
	it('routes by the inventory token and ignores a query orgId', async () => {
		const token = await signInventoryJwt(ORG_A)
		const req = new Request(
			`https://api.test/operator/inventory/settings?orgId=${ORG_B}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(await resolveOrgId(req, env)).toBe(ORG_A)
	})

	it('routes nowhere without a token or with a forged one', async () => {
		expect(
			await resolveOrgId(
				new Request(
					`https://api.test/operator/inventory/settings?orgId=${ORG_B}`,
				),
				env,
			),
		).toBeNull()
		const forged = await signInventoryJwt(ORG_A, 'x'.repeat(40))
		expect(
			await resolveOrgId(
				new Request('https://api.test/operator/inventory/settings', {
					headers: { Authorization: `Bearer ${forged}` },
				}),
				env,
			),
		).toBeNull()
	})
})
