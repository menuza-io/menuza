import { jwtVerify } from 'jose'
import {
	parsePosDeviceSecret,
	parsePosPairingCode,
} from '@repo/common/pos-orders'
import { z } from 'zod'
import { RESERVATIONS_TOKEN_AUDIENCE } from '@repo/reservations'
import {
	parseKioskDeviceSecret,
	parseKioskPairingCode,
	STAFFING_TOKEN_AUDIENCE,
} from '@repo/staffing'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { brand } from '@repo/config/brand'
import {
	resolveOrganizationForBrowserAuth,
	resolveOrganizationForPublicOrigin,
	findActiveOrganizationById,
	lookupActiveOrganization,
	type OrganizationLookup,
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
		// Staffing and reservations tokens carry their own audiences so they
		// cannot be replayed on the generic operator routes (and vice versa);
		// all three must route to the org's Durable Object. The route handlers
		// re-verify audience, typ, and scope.
		const { payload } = await jwtVerify(token, secret, {
			audience: [
				'tenant-api-operator',
				STAFFING_TOKEN_AUDIENCE,
				RESERVATIONS_TOKEN_AUDIENCE,
			],
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

const orderIdentitySchema = z.object({
	slug: z.string().optional(),
	host: z.string().optional(),
})

/**
 * Browser order endpoints are origin-bound: the client never chooses an
 * orgId. Identity comes from the Origin header plus slug/host carried in the
 * query string (GET) or JSON body (POST), matching the route handler's own
 * resolution. Fail-closed: unresolvable identity routes nowhere.
 */
async function orgIdFromOrderIdentity(
	request: Request,
	url: URL,
): Promise<string | null> {
	let identity: { slug?: string; host?: string }
	if (request.method === 'GET' || request.method === 'HEAD') {
		identity = {
			slug: url.searchParams.get('slug') ?? undefined,
			host: url.searchParams.get('host') ?? undefined,
		}
	} else {
		const body = await request
			.clone()
			.json()
			.catch(() => ({}))
		const parsed = orderIdentitySchema.safeParse(body)
		if (!parsed.success) return null
		identity = parsed.data
	}
	const organization = await resolveOrganizationForBrowserAuth(
		request.headers.get('Origin') ?? undefined,
		identity,
	)
	return organization?.id ?? null
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
 * POS terminal requests carry their organization inside an opaque credential,
 * exactly like kiosks: the pairing code in the body for `/pos/pair`, otherwise
 * the bearer device secret.
 */
async function orgIdFromPosRequest(
	request: Request,
	pathname: string,
): Promise<string | null> {
	if (pathname === '/pos/pair') {
		const body = await request
			.clone()
			.json()
			.catch(() => null)
		const code =
			body && typeof body === 'object'
				? (body as { code?: unknown }).code
				: undefined
		return parsePosPairingCode(code)?.orgId ?? null
	}
	const secret = getBearerToken(request.headers.get('Authorization'))
	return parsePosDeviceSecret(secret)?.orgId ?? null
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

	// Reservations tick, internal commands, and voice actions: body orgId,
	// authenticated by INTERNAL_COMMAND_TOKEN or VOICE_AGENT_TOKEN inside the
	// route handler. A tick with no body orgId fans out at the edge.
	if (
		pathname === '/api/reservations/tick' ||
		pathname.startsWith('/internal/reservations/') ||
		pathname.startsWith('/api/reservations/') ||
		pathname.startsWith('/api/voice/actions/')
	) {
		return orgIdFromJsonBody(request)
	}

	// Operator reservations routes: route strictly by the signed operator JWT,
	// never by a client-supplied query or body orgId.
	if (pathname.startsWith('/operator/reservations')) {
		return orgIdFromOperatorJwt(request, env)
	}

	// Public/guest reservations routes: the organization is the one the
	// browser's Origin names (plus slug/host hints outside production), never a
	// customer JWT, query or body orgId.
	if (isPublicReservationsPath(pathname)) {
		const organization = await resolveOrganizationForPublicOrigin(
			request.headers.get('Origin') ?? undefined,
			{
				slug: url.searchParams.get('slug') ?? undefined,
				host: url.searchParams.get('host') ?? undefined,
			},
		)
		return organization?.id ?? null
	}

	if (pathname.startsWith('/kiosk/')) {
		return orgIdFromKioskRequest(request, pathname)
	}

	if (pathname.startsWith('/pos/')) {
		return orgIdFromPosRequest(request, pathname)
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

	const queryOrgId = url.searchParams.get('orgId')
	if (queryOrgId && TENANT_ORG_ID_PATTERN.test(queryOrgId)) {
		return queryOrgId
	}

	if (pathname.startsWith('/operator')) {
		return orgIdFromOperatorJwt(request, env)
	}

	if (pathname === '/orders' || pathname.startsWith('/orders/')) {
		// Browser order placement: never route on a client-supplied orgId. A
		// customer access token is a valid signal (the handler re-checks it
		// against the origin-bound org); otherwise resolve origin + slug/host.
		const fromJwt = await orgIdFromCustomerJwt(request, env)
		if (fromJwt) return fromJwt
		return orgIdFromOrderIdentity(request, url)
	}

	if (pathname.startsWith('/api/orders')) {
		// App → regional internal order broker: body orgId, authenticated by
		// INTERNAL_COMMAND_TOKEN inside the route handler.
		return orgIdFromJsonBody(request)
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

export function isPublicReservationsPath(pathname: string): boolean {
	return pathname === '/reservations' || pathname.startsWith('/reservations/')
}

/**
 * The same body, status and headers the Node runtime answers on
 * `/reservations/*` when the Origin names no organization on this node
 * (`notFoundResponse` in `src/lib/reservations-public-auth.ts`), so a caller
 * learns nothing about which organizations exist.
 */
export function reservationsPublicNotFound(): Response {
	return Response.json(
		{ error: 'not_found' },
		{ status: 404, headers: { 'Cache-Control': 'private, no-store' } },
	)
}

/**
 * Public reservations routes: an organization that is unknown, lives in
 * another region or has no provisioned database answers the uniform 404, never
 * a `region_mismatch` that would reveal where the organization lives.
 */
export async function assertReservationsOrgOnUsNode(
	orgId: string,
): Promise<Response | null> {
	const organization = await findActiveOrganizationById(orgId)
	if (
		!organization ||
		organization.dataRegion !== 'us' ||
		!organization.hasProvisionedDb
	) {
		return reservationsPublicNotFound()
	}
	return null
}

/**
 * A till uploading a backlog makes many requests in a row, each of which would
 * ask App about the same organization. A positive answer is remembered for a
 * minute, so the drain neither crawls nor stops during a short App outage; a
 * deactivated organization is refused within that minute. Negative and
 * unavailable answers are never remembered.
 */
const POS_ORG_CACHE_MS = 60_000
const posOrgCache = new Map<
	string,
	{ at: number; lookup: OrganizationLookup }
>()
/** Tests start from a cold cache. */
export const clearPosOrganizationCache = () => posOrgCache.clear()
export async function lookupPosOrganization(
	orgId: string,
): Promise<OrganizationLookup> {
	const hit = posOrgCache.get(orgId)
	if (hit && Date.now() - hit.at < POS_ORG_CACHE_MS) return hit.lookup
	const lookup = await lookupActiveOrganization(orgId)
	if (lookup.status === 'found') {
		if (posOrgCache.size > 500) posOrgCache.clear()
		posOrgCache.set(orgId, { at: Date.now(), lookup })
	} else {
		posOrgCache.delete(orgId)
	}
	return lookup
}

/**
 * Kiosk and POS terminal requests are unauthenticated until the handler checks the credential,
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
		pathname === '/kiosk/pair' || pathname === '/pos/pair'
			? 'invalid_pairing_code'
			: 'invalid_device'
	let organization
	if (pathname.startsWith('/pos/')) {
		// A terminal signs itself out when told it was removed, so a control-plane
		// hiccup must never look like a removal: answer 503, which it retries.
		const lookup = await lookupPosOrganization(orgId)
		if (lookup.status === 'unavailable') {
			return Response.json({ error: 'service_unavailable' }, { status: 503 })
		}
		organization = lookup.status === 'found' ? lookup.organization : null
	} else {
		organization = await findActiveOrganizationById(orgId)
	}
	if (
		!organization ||
		organization.dataRegion !== 'us' ||
		!organization.hasProvisionedDb
	) {
		return Response.json({ error }, { status: 401 })
	}
	return null
}
