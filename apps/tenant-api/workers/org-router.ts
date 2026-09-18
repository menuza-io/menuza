import { jwtVerify } from 'jose'
import { z } from 'zod'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { brand } from '@repo/config/brand'
import {
	resolveOrganizationForBrowserAuth,
	findActiveOrganizationById,
	resolvePublishedOrganization,
} from '../src/lib/origin.ts'
import { getBearerToken } from '../src/lib/secrets.ts'
import type { TenantApiWorkerEnv } from './bindings.ts'

const orgIdBodySchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN).optional(),
	slug: z.string().optional(),
	host: z.string().optional(),
	refreshToken: z.string().optional(),
})

async function orgIdFromCustomerJwt(
	request: Request,
	env: TenantApiWorkerEnv,
): Promise<string | null> {
	const token = getBearerToken(request.headers.get('Authorization'))
	if (!token) return null

	try {
		const secret = new TextEncoder().encode(env.JWT_SECRET)
		const { payload } = await jwtVerify(token, secret, {
			issuer: brand.slug,
			audience: 'tenant-api',
		})
		if (payload.type !== 'access') return null
		return typeof payload.orgId === 'string' ? payload.orgId : null
	} catch {
		return null
	}
}

async function orgIdFromOperatorJwt(
	request: Request,
	env: TenantApiWorkerEnv,
): Promise<string | null> {
	const token = getBearerToken(request.headers.get('Authorization'))
	if (!token) return null

	try {
		const secret = new TextEncoder().encode(env.TENANT_OPERATOR_TOKEN)
		const { payload } = await jwtVerify(token, secret, {
			audience: 'tenant-api-operator',
			issuer: brand.shortName,
		})
		if (payload.role !== 'operator') return null
		return typeof payload.orgId === 'string' ? payload.orgId : null
	} catch {
		return null
	}
}

async function orgIdFromAuthBody(request: Request): Promise<string | null> {
	const body = await request
		.clone()
		.json()
		.catch(() => ({}))
	const parsed = orgIdBodySchema.safeParse(body)
	if (!parsed.success) return null

	if (parsed.data.orgId) return parsed.data.orgId

	const organization = await resolveOrganizationForBrowserAuth(
		request.headers.get('Origin') ?? undefined,
		parsed.data,
	)
	return organization?.id ?? null
}

async function orgIdFromJsonBody(request: Request): Promise<string | null> {
	const body = await request
		.clone()
		.json()
		.catch(() => ({}))
	if (typeof body !== 'object' || body === null) return null
	const orgId = (body as { orgId?: unknown }).orgId
	return typeof orgId === 'string' && TENANT_ORG_ID_PATTERN.test(orgId)
		? orgId
		: null
}

/**
 * Resolve which tenant org should handle this request on Cloudflare Workers.
 * Returns null when the route is not org-scoped (health, sync-all, etc.).
 */
export async function resolveOrgId(
	request: Request,
	env: TenantApiWorkerEnv,
): Promise<string | null> {
	const url = new URL(request.url)
	const { pathname } = url

	if (pathname === '/health' || pathname === '/api/health') return null

	if (pathname === '/api/provision' || pathname === '/api/deprovision') {
		return orgIdFromJsonBody(request)
	}

	if (pathname === '/api/marketing/sync-engagement') {
		return orgIdFromJsonBody(request)
	}

	const queryOrgId = url.searchParams.get('orgId')
	if (queryOrgId && TENANT_ORG_ID_PATTERN.test(queryOrgId)) {
		return queryOrgId
	}

	if (pathname.startsWith('/operator')) {
		return orgIdFromOperatorJwt(request, env)
	}

	if (pathname.startsWith('/menu')) {
		const slug = url.searchParams.get('slug') ?? undefined
		const host = url.searchParams.get('host') ?? undefined
		const organization = await resolvePublishedOrganization({ slug, host })
		return organization?.id ?? null
	}

	if (
		pathname.startsWith('/shop') ||
		pathname.startsWith('/analytics') ||
		pathname === '/auth/me'
	) {
		return orgIdFromCustomerJwt(request, env)
	}

	if (pathname.startsWith('/auth/')) {
		const fromJwt = await orgIdFromCustomerJwt(request, env)
		if (fromJwt) return fromJwt
		return orgIdFromAuthBody(request)
	}

	if (pathname.startsWith('/api/journeys')) {
		const fromBody = await orgIdFromJsonBody(request)
		if (fromBody) return fromBody
	}

	if (request.method === 'POST' || request.method === 'PATCH') {
		const fromBody = await orgIdFromJsonBody(request)
		if (fromBody) return fromBody
	}

	return null
}

export async function assertOrgOnUsNode(
	orgId: string,
	env: TenantApiWorkerEnv,
): Promise<Response | null> {
	const organization = await findActiveOrganizationById(orgId)
	if (!organization) {
		if (env.TENANT_API_RUNTIME === 'workers') {
			return null
		}
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}
	if (organization.dataRegion !== 'us') {
		return Response.json(
			{
				error: 'region_mismatch',
				message: `Organization dataRegion "${organization.dataRegion}" does not match this node ("us")`,
				orgRegion: organization.dataRegion,
				nodeRegion: 'us',
			},
			{ status: 409 },
		)
	}
	return null
}
