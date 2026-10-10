import { brand } from '@repo/config/brand'
import { customers, getTenantDb } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import jwt from 'jsonwebtoken'

type TenantCustomerAccessPayload = {
	customerId: string
	orgId: string
	type?: string
}

export function assertTenantCustomerJwtSecret() {
	const secret = process.env.TENANT_CUSTOMER_JWT_SECRET?.trim()
	if (!secret || secret.length < 16) {
		throw new Error(
			'TENANT_CUSTOMER_JWT_SECRET is missing or too short. Set it to match the US tenant-api JWT_SECRET.',
		)
	}
	return secret
}

function getTenantCustomerJwtSecret() {
	return assertTenantCustomerJwtSecret()
}

function getBearerToken(request: Request) {
	const header = request.headers.get('Authorization')
	if (!header) return null
	const first = header.split(',')[0]?.trim()
	if (!first?.startsWith('Bearer ')) return null
	return first.slice('Bearer '.length).trim() || null
}

function verifyTenantCustomerAccessToken(token: string) {
	try {
		const payload = jwt.verify(token, getTenantCustomerJwtSecret(), {
			issuer: brand.slug,
			audience: 'tenant-api',
			algorithms: ['HS256'],
		}) as TenantCustomerAccessPayload

		if (payload.type !== 'access') return null
		if (!payload.customerId || !payload.orgId) return null
		return payload
	} catch {
		return null
	}
}

export type VerifiedShopCustomer = {
	customerId: string
	customerEmail: string | null
}

/**
 * Derives shop checkout customer context from a verified tenant access token.
 * Guest checkout omits Authorization; body-supplied customerId is rejected.
 */
export async function resolveVerifiedShopCustomer(
	request: Request,
	organizationId: string,
	bodyCustomerId?: string | null,
): Promise<VerifiedShopCustomer | null> {
	if (bodyCustomerId) {
		throw new Response(
			'Customer identity must not be supplied in the request body',
			{
				status: 400,
			},
		)
	}

	const token = getBearerToken(request)
	if (!token) return null

	const payload = verifyTenantCustomerAccessToken(token)
	if (!payload) {
		throw new Response('Invalid or expired customer session', { status: 401 })
	}

	if (payload.orgId !== organizationId) {
		throw new Response('Customer session does not match this organization', {
			status: 403,
		})
	}

	const tenantDb = await getTenantDb(organizationId)
	const [customer] = await tenantDb
		.select({ email: customers.email })
		.from(customers)
		.where(eq(customers.id, payload.customerId))
		.limit(1)

	if (!customer) {
		throw new Response('Customer not found', { status: 404 })
	}

	return {
		customerId: payload.customerId,
		customerEmail: customer.email ?? null,
	}
}
