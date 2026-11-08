import { jwtVerify } from 'jose'
import {
	parsePosDeviceSecret,
	parsePosPairingCode,
} from '@repo/common/pos-orders'
import { z } from 'zod'
import { LOYALTY_TOKEN_AUDIENCE } from '@repo/loyalty'
import { RESERVATIONS_TOKEN_AUDIENCE } from '@repo/reservations'
import {
	parseKioskDeviceSecret,
	parseKioskPairingCode,
	parseScheduleLinkToken,
	STAFFING_TOKEN_AUDIENCE,
} from '@repo/staffing'
import { verifyOperatorAnalyticsToken } from '@repo/reports/token'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { brand } from '@repo/config/brand'
import {
	resolveOrganizationForBrowserAuth,
	resolveOrganizationForPublicOrigin,
	findActiveOrganizationById,
	lookupActiveOrganization,
	type OrganizationLookup,
} from '../src/lib/origin.ts'
import {
	getBearerToken,
	getInternalCommandToken,
	getOperatorAnalyticsToken,
	timingSafeEqualString,
} from '../src/lib/secrets.ts'
import {
	type ConsentTokenKind,
	verifyConsentToken,
} from '../src/lib/email-consent.ts'
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
				LOYALTY_TOKEN_AUDIENCE,
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

/**
 * Operator analytics tokens (reports) use their own signing key, issuer and
 * audience, so the customer JWT check cannot read them. Verified with the same
 * function and secret as the route; the route re-verifies.
 */
async function orgIdFromAnalyticsToken(
	request: Request,
): Promise<string | null> {
	const token = getBearerToken(request.headers.get('Authorization'))
	if (!token) return null
	const signingSecret = getOperatorAnalyticsToken()
	if (!signingSecret) return null
	const claims = await verifyOperatorAnalyticsToken({ signingSecret, token })
	return claims && TENANT_ORG_ID_PATTERN.test(claims.orgId)
		? claims.orgId
		: null
}

/**
 * "My schedule" requests carry the organization as a plain prefix of the
 * bearer link token. Nothing else (body, query) may choose it. The route
 * verifies the link itself.
 */
function orgIdFromScheduleLink(request: Request): string | null {
	const token = getBearerToken(request.headers.get('Authorization'))
	const orgId = parseScheduleLinkToken(token)?.orgId
	return orgId && TENANT_ORG_ID_PATTERN.test(orgId) ? orgId : null
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

/** Far more than a pairing body (`{"code":"…"}`) ever needs. */
export const POS_PAIR_BODY_MAX_BYTES = 2_048

/**
 * The body of a clone of the request as text, or null when it is (or declares
 * itself) larger than `maxBytes`. Stops reading as soon as it is.
 */
async function readCappedText(
	request: Request,
	maxBytes: number,
): Promise<string | null> {
	const declared = request.headers.get('content-length')
	if (declared !== null && !(Number(declared) <= maxBytes)) return null
	const stream = request.clone().body
	if (!stream) return ''
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.byteLength
			if (size > maxBytes) {
				// Not awaited: a cloned (teed) body settles its cancel only once
				// the other branch is cancelled too, and the request is refused.
				reader.cancel().catch(() => {})
				return null
			}
			chunks.push(value)
		}
	} catch {
		return null
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(bytes)
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
		// A pairing body is one short code: refuse anything larger before reading
		// (or buffering) it, whatever its declared length.
		const text = await readCappedText(request, POS_PAIR_BODY_MAX_BYTES)
		if (text === null) return null
		let body: unknown = null
		try {
			body = JSON.parse(text)
		} catch {
			return null
		}
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
 * Public bodies read at the edge, before any verification. The same ceiling
 * as the public routes' own body limit (app.ts), so a request the route would
 * accept is never refused here; consent-token forms are tiny.
 */
const MAX_PUBLIC_BODY_BYTES = 1024 * 1024
const MAX_TOKEN_FORM_BYTES = 16 * 1024

/**
 * Reads a clone of the body as text, counting bytes as they arrive: a
 * spoofed small Content-Length cannot make the edge buffer more than `max`.
 * Null when the body is missing or over the limit.
 */
async function readBoundedText(
	request: Request,
	max: number,
): Promise<string | null> {
	const declared = Number(request.headers.get('content-length'))
	if (Number.isFinite(declared) && declared > max) return null
	const body = request.clone().body
	if (!body) return null
	const reader = body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > max) {
			// Not awaited: cancelling one branch of a cloned (tee'd) body only
			// settles once the other branch is cancelled too.
			void reader.cancel().catch(() => {})
			return null
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(bytes)
}

/**
 * Unsubscribe and confirm links carry only `?token=`; the signed consent token
 * names its organization in claim `o`. One-click unsubscribe (RFC 8058) may
 * send the token in a form body instead. The signature is checked here, so a
 * junk token cannot wake an organization's Durable Object; expiry is left to
 * the route, which answers an expired link with a page.
 */
async function orgIdFromConsentToken(
	request: Request,
	url: URL,
	kind: ConsentTokenKind,
): Promise<string | null> {
	let token = url.searchParams.get('token')
	if (!token && request.method === 'POST') {
		const text = await readBoundedText(request, MAX_TOKEN_FORM_BYTES)
		token = text ? new URLSearchParams(text).get('token') : null
	}
	if (!token) return null
	const payload = verifyConsentToken(token, kind, 0)
	return payload && TENANT_ORG_ID_PATTERN.test(payload.o) ? payload.o : null
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
		// Refused at the edge when over the public routes' own limit, whatever
		// names the organization (Origin alone would): an oversized post must
		// not reach, or wake, a tenant's Durable Object.
		const text = await readBoundedText(request, MAX_PUBLIC_BODY_BYTES)
		if (text === null) return null
		// The submission carries slug and host in its JSON body; a query
		// identity, when present, wins.
		if (!identity.slug && !identity.host) {
			let body: unknown = null
			try {
				body = JSON.parse(text)
			} catch {
				body = null
			}
			if (body && typeof body === 'object') {
				const { slug, host } = body as { slug?: unknown; host?: unknown }
				identity = {
					slug: typeof slug === 'string' ? slug : undefined,
					host: typeof host === 'string' ? host : undefined,
				}
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

	// Loyalty tick: same shape as the staff tick.
	if (pathname === '/api/loyalty/tick') {
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

	// Operator loyalty routes: same rule (the `lty+jwt` shares the operator
	// audience list above; the route handler re-verifies typ, audience, scope).
	if (pathname.startsWith('/operator/loyalty')) {
		return orgIdFromOperatorJwt(request, env)
	}

	// Customer loyalty routes: a customer access token is a valid signal (the
	// handler re-checks it against the origin-bound org); otherwise resolve
	// origin + slug/host, never a client-supplied orgId.
	if (pathname === '/loyalty' || pathname.startsWith('/loyalty/')) {
		const fromJwt = await orgIdFromCustomerJwt(request, env)
		if (fromJwt) return fromJwt
		return orgIdFromOrderIdentity(request, url)
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

	// Credential-bearing routes name their organization themselves. A query
	// orgId must not run the request inside another organization's Durable
	// Object (that arms the wrong staff alarm, and a missing in-isolate handle
	// would fall back to a filesystem database).
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

	if (pathname === '/analytics' || pathname.startsWith('/analytics/')) {
		return orgIdFromAnalyticsToken(request)
	}

	if (pathname === '/schedule-link' || pathname.startsWith('/schedule-link/')) {
		return orgIdFromScheduleLink(request)
	}

	if (pathname.startsWith('/shop') || pathname === '/auth/me') {
		return orgIdFromCustomerJwt(request, env)
	}

	if (pathname.startsWith('/auth/')) {
		const fromJwt = await orgIdFromCustomerJwt(request, env)
		if (fromJwt) return fromJwt
		return orgIdFromAuthBody(request)
	}

	if (pathname === '/subscriptions/unsubscribe') {
		return orgIdFromConsentToken(request, url, 'unsubscribe')
	}
	if (pathname === '/subscriptions/confirm') {
		return orgIdFromConsentToken(request, url, 'confirm')
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
	// Mid region switch, after a failed one, or before provisioning finished:
	// the object must not be woken (it would rebuild an empty database). Only
	// `/api/provision` creates it, and that path does not come through here.
	if (!organization.hasProvisionedDb) {
		return Response.json({ error: 'org_not_provisioned' }, { status: 404 })
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
 * deactivated organization is refused within that minute. An organization App
 * does not know is remembered briefly too, so made-up ids in unauthenticated
 * requests do not each cost a control-plane call. "Unavailable" is never
 * remembered.
 */
const POS_ORG_CACHE_MS = 60_000
export const POS_ORG_NEGATIVE_CACHE_MS = 15_000
const POS_ORG_CACHE_MAX = 500
const posOrgCache = new Map<
	string,
	{ at: number; ttl: number; lookup: OrganizationLookup }
>()

/**
 * Control-plane lookups (cache misses) one client address may cause per
 * minute on this isolate, before the router answers 429. A best-effort brake:
 * per isolate, in memory, and only on misses, so a till draining its backlog
 * against a cached organization is never slowed.
 */
export const POS_LOOKUPS_PER_IP_PER_MINUTE = 30
const lookupWindows = new Map<string, { start: number; count: number }>()

/** Tests start from a cold cache. */
export const clearPosOrganizationCache = () => {
	posOrgCache.clear()
	lookupWindows.clear()
}

function remember(orgId: string, lookup: OrganizationLookup, ttl: number) {
	if (posOrgCache.size >= POS_ORG_CACHE_MAX) {
		posOrgCache.delete(posOrgCache.keys().next().value!)
	}
	posOrgCache.set(orgId, { at: Date.now(), ttl, lookup })
}

/** True when this address has used up its lookups for the current minute. */
function lookupLimited(clientIp: string | null, now: number): boolean {
	if (!clientIp) return false
	const window = lookupWindows.get(clientIp)
	if (!window || now - window.start >= 60_000) {
		if (lookupWindows.size >= 5_000) lookupWindows.clear()
		lookupWindows.set(clientIp, { start: now, count: 1 })
		return false
	}
	window.count += 1
	return window.count > POS_LOOKUPS_PER_IP_PER_MINUTE
}

export async function lookupPosOrganization(
	orgId: string,
	clientIp: string | null = null,
): Promise<OrganizationLookup | { status: 'rate_limited' }> {
	const now = Date.now()
	const hit = posOrgCache.get(orgId)
	if (hit && now - hit.at < hit.ttl) return hit.lookup
	if (lookupLimited(clientIp, now)) return { status: 'rate_limited' }
	const lookup = await lookupActiveOrganization(orgId)
	if (lookup.status === 'found') remember(orgId, lookup, POS_ORG_CACHE_MS)
	else if (lookup.status === 'missing')
		remember(orgId, lookup, POS_ORG_NEGATIVE_CACHE_MS)
	else posOrgCache.delete(orgId)
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
	clientIp: string | null = null,
): Promise<Response | null> {
	const error =
		pathname === '/kiosk/pair' || pathname === '/pos/pair'
			? 'invalid_pairing_code'
			: 'invalid_device'
	let organization
	if (pathname.startsWith('/pos/')) {
		// A terminal signs itself out when told it was removed, so a control-plane
		// hiccup must never look like a removal: answer 503, which it retries.
		const lookup = await lookupPosOrganization(orgId, clientIp)
		if (lookup.status === 'unavailable') {
			return Response.json({ error: 'service_unavailable' }, { status: 503 })
		}
		if (lookup.status === 'rate_limited') {
			return Response.json(
				{ error: 'rate_limited' },
				{
					status: 429,
					headers: {
						'Retry-After': '60',
						'Cache-Control': 'private, no-store',
					},
				},
			)
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
