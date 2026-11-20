import { brand } from '@repo/config/brand'
import { SignJWT } from 'jose'
import { ENV } from 'varlock/env'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type ArmReader } from './experiments.server.ts'

/**
 * Reads a test's visits and orders per arm from the organization's region with
 * a short, server-signed `funnel` token (counts only; the token never reaches
 * a browser). Null when the region cannot answer now.
 */
export const readArmCounts: ArmReader = async (organization, id, from) => {
	const secret = ENV.TENANT_OPERATOR_TOKEN
	if (!secret || secret.length < 16) return null
	try {
		const jwt = await new SignJWT({
			orgId: organization.id,
			role: 'operator',
			scope: 'funnel',
		})
			.setSubject('experiments')
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('5m')
			.sign(new TextEncoder().encode(secret))
		const { tenantApiUrl } = resolveRegionalTenantApiUrls(
			organization.dataRegion ?? 'us',
		)
		const response = await fetch(
			`${tenantApiUrl}/operator/funnel/experiments/${encodeURIComponent(id)}?from=${from}`,
			{
				headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
				cache: 'no-store',
				signal: AbortSignal.timeout(5000),
			},
		)
		if (!response.ok) return null
		const body = (await response.json()) as {
			a?: { visits?: number; orders?: number }
			b?: { visits?: number; orders?: number }
		}
		const arm = (value?: { visits?: number; orders?: number }) => ({
			visits: Math.max(0, Number(value?.visits) || 0),
			orders: Math.max(0, Number(value?.orders) || 0),
		})
		return { a: arm(body.a), b: arm(body.b) }
	} catch {
		return null
	}
}
