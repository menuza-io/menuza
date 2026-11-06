import { jwtVerify } from 'jose'
import { z } from 'zod'
import {
	parseKioskDeviceSecret,
	parseKioskPairingCode,
	STAFFING_TOKEN_AUDIENCE,
} from '@repo/staffing'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { brand } from '@repo/config/brand'
import {
	resolveOrganizationForBrowserAuth,
	findActiveOrganizationById,
} from '../src/lib/origin.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	timingSafeEqualString,
} from '../src/lib/secrets.ts'
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
			algorithms: ['HS256'],
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
		// Staffing tokens carry their own audience so they cannot be replayed on
		// the generic operator routes (and vice versa); both must route to the
		// org's Durable Object. The route handlers re-verify audience and scope.
		const { payload } = await jwtVerify(token, secret, {
			audience: ['tenant-api-operator', STAFFING_TOKEN_AUDIENCE],
			issuer: brand.shortName,
			algorithms: ['HS256'],
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
 * Kiosk requests carry their organization inside an opaque credential: the
 * pairing code in the body for `/kiosk/pair`, otherwise the bearer device
 * secret. Nothing else may choose the organization (no query or body orgId),
 * and a malformed credential routes nowhere. The route handler verifies the
 * credential itself; this only picks the Durable Object.
 */
async function orgIdFromKioskRequest(
	request: Request,
	pathname: string,
): Promise<string | null> {
	if (pathname === '/kiosk/pair') {
		const body = await request
			.clone()
			.json()
			.catch(() => null)
		const code =
			body && typeof body === 'object'
				? (body as { code?: unknown }).code
				: undefined
		return parseKioskPairingCode(code)?.orgId ?? null
	}
	const secret = getBearerToken(request.headers.get('Authorization'))
	return parseKioskDeviceSecret(secret)?.orgId ?? null
}

/**
 * Unsubscribe and confirm links carry only `?token=`; the signed consent token
 * names its organization in claim `o`. One-click unsubscribe (RFC 8058) may
 * send the token in a form body instead. Like the kiosk credential, the token
 * is only parsed here to pick the Durable Object; the route verifies its
 * signature before doing anything.
 */
async function orgIdFromConsentToken(
	request: Request,
	url: URL,
): Promise<string | null> {
	let token = url.searchParams.get('token')
	if (!token && request.method === 'POST') {
		const form = await request
			.clone()
			.formData()
			.catch(() => null)
		const value = form?.get('token')
		token = typeof value === 'string' ? value : null
	}
	if (!token || token.length > 1024) return null
	const [body] = token.split('.')
	try {
		const payload = JSON.parse(
			new TextDecoder().decode(
				Uint8Array.from(
					atob(body!.replace(/-/g, '+').replace(/_/g, '/')),
					(char) => char.charCodeAt(0),
				),
			),
		) as { o?: unknown }
		return typeof payload.o === 'string' &&
			TENANT_ORG_ID_PATTERN.test(payload.o)
			? payload.o
			: null
	} catch {
		return null
	}
}

/**
 * Public website forms: the organization is the one the browser's Origin
 * names (with the slug or host the page passes), never a client-supplied
 * orgId. The submission POST carries slug and host in its JSON body.
 */
async function orgIdFromPublicForm(
	request: Request,
	url: URL,
): Promise<string | null> {
	let identity = {
		slug: url.searchParams.get('slug') ?? undefined,
		host: url.searchParams.get('host') ?? undefined,
	}
	if (request.method === 'POST') {
		const body = await request
			.clone()
			.json()
			.catch(() => null)
		if (body && typeof body === 'object') {
			const { slug, host } = body as { slug?: unknown; host?: unknown }
			identity = {
				slug: typeof slug === 'string' ? slug : undefined,
				host: typeof host === 'string' ? host : undefined,
			}
		}
	}
	const organization = await resolveOrganizationForBrowserAuth(
		request.headers.get('Origin') ?? undefined,
		identity,
	)
	return organization?.id ?? null
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

	// Hourly staff tick: a body orgId runs that organization in its Durable
	// Object; no orgId means the edge fans out to every organization.
	if (pathname === '/api/staff/tick') {
		return orgIdFromJsonBody(request)
	}

	// App -> regional staff commands (link, unlink, erase, summary, export): body
	// orgId, authenticated by INTERNAL_COMMAND_TOKEN inside the route handler.
	if (pathname.startsWith('/internal/staff/')) {
		return orgIdFromJsonBody(request)
	}

	if (pathname.startsWith('/kiosk/')) {
		return orgIdFromKioskRequest(request, pathname)
	}

	// The public application form: the organization is the one the browser's
	// Origin names, never a client-supplied orgId (the generic body and query
	// routing below must not apply to it).
	if (pathname.startsWith('/careers/')) {
		const organization = await resolveOrganizationForBrowserAuth(
			request.headers.get('Origin') ?? undefined,
			{
				slug: url.searchParams.get('slug') ?? undefined,
				host: url.searchParams.get('host') ?? undefined,
			},
		)
		return organization?.id ?? null
	}

	// Credential-bearing routes name their organization themselves. A query
	// orgId must not run the request inside another organization's Durable
	// Object (that arms the wrong staff alarm, and a missing in-isolate handle
	// would fall back to a filesystem database).
	if (pathname.startsWith('/operator')) {
		return orgIdFromOperatorJwt(request, env)
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

	if (
		pathname === '/subscriptions/unsubscribe' ||
		pathname === '/subscriptions/confirm'
	) {
		return orgIdFromConsentToken(request, url)
	}

	// Customer subscription toggles: the signed-in customer's own organization.
	if (pathname === '/subscriptions' || pathname.startsWith('/subscriptions/')) {
		return orgIdFromCustomerJwt(request, env)
	}

	if (pathname.startsWith('/forms/')) {
		return orgIdFromPublicForm(request, url)
	}

	if (pathname.startsWith('/voice/')) {
		const organization = await resolveOrganizationForBrowserAuth(
			request.headers.get('Origin') ?? undefined,
			{
				slug: url.searchParams.get('slug') ?? undefined,
				host: url.searchParams.get('host') ?? undefined,
			},
		)
		return organization?.id ?? null
	}

	if (pathname.startsWith('/api/journeys')) {
		const fromBody = await orgIdFromJsonBody(request)
		if (fromBody) return fromBody
	}

	if (request.method === 'POST' || request.method === 'PATCH') {
		const fromBody = await orgIdFromJsonBody(request)
		if (fromBody) return fromBody
	}

	// Server GETs that cannot put orgId in a body (journey definitions). Public
	// and session routes above never consult this.
	if (pathname.startsWith('/api/')) {
		const queryOrgId = url.searchParams.get('orgId')
		if (queryOrgId && TENANT_ORG_ID_PATTERN.test(queryOrgId)) {
			return queryOrgId
		}
	}

	return null
}

/**
 * Server-to-server calls may name an organization the control plane does not
 * list yet (provision arrives first). That is only safe once the caller has
 * proved it holds the internal token: the handler checks the token, but only
 * after the Durable Object exists and has run its migrations, so an anonymous
 * request must never get that far for an unknown organization.
 */
function isAuthenticatedServerCall(request: Request) {
	const { pathname } = new URL(request.url)
	if (!pathname.startsWith('/internal/') && !pathname.startsWith('/api/')) {
		return false
	}
	const expected = getInternalCommandToken()
	const presented = getBearerToken(request.headers.get('Authorization'))
	return (
		expected.length >= 16 &&
		presented.length > 0 &&
		timingSafeEqualString(presented, expected)
	)
}

export async function assertOrgOnUsNode(
	orgId: string,
	env: TenantApiWorkerEnv,
	request?: Request,
): Promise<Response | null> {
	const organization = await findActiveOrganizationById(orgId)
	if (!organization) {
		// An unauthenticated caller must not be able to mint a Durable Object (and
		// a fresh in-memory rate-limit budget) by naming an unknown organization.
		if (
			env.TENANT_API_RUNTIME === 'workers' &&
			request &&
			isAuthenticatedServerCall(request)
		) {
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

/**
 * Kiosk requests are unauthenticated until the handler checks the credential,
 * so a made-up organization id must not be allowed to create a Durable Object.
 * Unlike the other routes, an organization the control plane does not know is
 * refused here (a lookup that fails closes the door too). Unknown, wrong-region
 * and unprovisioned organizations all answer the same.
 */
export async function assertKioskOrgOnUsNode(
	orgId: string,
	pathname: string,
): Promise<Response | null> {
	const error =
		pathname === '/kiosk/pair' ? 'invalid_pairing_code' : 'invalid_device'
	const organization = await findActiveOrganizationById(orgId)
	if (
		!organization ||
		organization.dataRegion !== 'us' ||
		!organization.hasProvisionedDb
	) {
		return Response.json({ error }, { status: 401 })
	}
	return null
}
