import { z } from 'zod'
import {
	setListTenantOrgIdsProvider,
	TENANT_ORG_ID_PATTERN,
} from '@repo/tenant-db'
import { createTenantApiApp } from '../src/app.ts'
import { registerReservationsDemandSource } from '../src/restaurant/reservations-demand-source.ts'
import { registerReservationVoiceActions } from '../src/restaurant/reservations-voice-actions.ts'
import { registerRestaurantOrderSource } from '../src/restaurant/staffing-order-source.ts'
import {
	findActiveOrganizationById,
	isPosOrigin,
	organizationFromProvisionPayload,
	resolveCorsAllowOrigin,
} from '../src/lib/origin.ts'
import {
	DEPROVISION_RECORDING_BUDGET_MS,
	deleteOrganizationRecordings,
	type PrefixDeleteResult,
} from '../src/lib/recording-storage.ts'
import {
	applyVarlockEnv,
	assertTenantApiSecrets,
	getBearerToken,
	timingSafeEqualString,
} from '../src/lib/secrets.ts'
import {
	assertKioskOrgOnUsNode,
	assertOrgOnUsNode,
	assertReservationsOrgOnUsNode,
	isPublicReservationsPath,
	reservationsPublicNotFound,
	resolveOrgId,
} from './org-router.ts'
import { createInventoryTickModule } from '../src/lib/inventory-alarm.ts'
import { registerOrgTickModule } from '../src/lib/org-alarm.ts'
import {
	fanOutInventoryTick,
	runInventoryTickForOrg,
	type InventoryTickOutcome,
} from '../src/services/inventory-tick-service.ts'
import {
	fanOutLoyaltyTick,
	type LoyaltyTickResult,
} from '../src/services/loyalty-tick-service.ts'
import { fanOutReservationsTick } from '../src/services/rsv-tick-fanout.ts'
import type { ReservationsTickResult } from '../src/services/rsv-tick-service.ts'
import { fanOutStaffTick } from '../src/services/staff-tick-fanout.ts'
import type { TickResult } from '../src/services/staff-tick-service.ts'
import { TENANT_ORG_HEADER, TenantOrg } from './tenant-org.ts'
import { TenantRegistry } from './tenant-registry.ts'
import type { TenantApiWorkerEnv } from './bindings.ts'

export { TenantOrg, TenantRegistry }

// Restaurant orders feed the demand guide, forecast, labor sales and tip pools.
registerRestaurantOrderSource()
registerReservationVoiceActions()
registerReservationsDemandSource()
// The inventory alarm (retries of alerts the App could not take). Registered
// here, in the entry both the Worker and its Durable Objects load, so the
// object's alarm finds it next to the staff, reservations and loyalty modules
// that `tenant-org.ts` registers.
registerOrgTickModule(
	createInventoryTickModule((orgId, now) =>
		runInventoryTickForOrg(orgId, { now }),
	),
)

const edgeApp = createTenantApiApp()

export function applyWorkerEnv(env: TenantApiWorkerEnv) {
	applyVarlockEnv(env)
}

function registryStub(env: TenantApiWorkerEnv) {
	return env.TENANT_REGISTRY.get(env.TENANT_REGISTRY.idFromName('us'))
}

function orgStub(env: TenantApiWorkerEnv, orgId: string) {
	return env.TENANT_ORG.get(env.TENANT_ORG.idFromName(orgId))
}

function forwardToOrg(
	request: Request,
	env: TenantApiWorkerEnv,
	orgId: string,
) {
	const headers = new Headers(request.headers)
	headers.set(TENANT_ORG_HEADER, orgId)
	const forwarded = new Request(request, { headers })
	return orgStub(env, orgId).fetch(forwarded)
}

const provisionBodySchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN, 'Invalid orgId format'),
	slug: z.string().min(1).optional(),
	customDomain: z.string().nullable().optional(),
	dataRegion: z.enum(['us', 'ksa']).optional(),
})

async function handleProvision(
	request: Request,
	env: TenantApiWorkerEnv,
	ctx: ExecutionContext,
	command: 'provision' | 'deprovision',
) {
	const internalToken = env.INTERNAL_COMMAND_TOKEN || ''
	if (internalToken.length < 16) {
		return Response.json(
			{ error: 'Provisioning is not configured' },
			{ status: 503 },
		)
	}

	const presented = getBearerToken(request.headers.get('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 })
	}

	const body = await request.json().catch(() => ({}))
	const parsed = provisionBodySchema.safeParse(body)
	if (!parsed.success) {
		return Response.json(
			{ error: parsed.error.issues[0]?.message || 'Invalid payload' },
			{ status: 400 },
		)
	}

	const { orgId } = parsed.data
	// The App's own record wins over the region the caller put in the payload
	// (as on the Node runtime): a stale or crossed command must not wipe or
	// create a US database for an organization the App has in another region.
	const organization =
		(await findActiveOrganizationById(orgId)) ||
		organizationFromProvisionPayload(parsed.data)
	if (!organization) {
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

	const stub = orgStub(env, orgId)
	const registry = registryStub(env)

	let recordings: PrefixDeleteResult['status'] | undefined
	try {
		if (command === 'provision') {
			await stub.provision()
			await registry.add(orgId)
		} else {
			recordings = await deleteOrganizationRecordings(orgId, {
				budgetMs: DEPROVISION_RECORDING_BUDGET_MS,
				runInBackground: (task) =>
					ctx.waitUntil(
						task.catch((error) => {
							console.error('Background recording cleanup failed', error)
						}),
					),
			})
			await stub.deprovision()
			await registry.remove(orgId)
		}
	} catch (error) {
		console.error(`Failed to ${command} DB for ${orgId}:`, error)
		return Response.json(
			{
				error:
					command === 'provision'
						? 'Failed to provision tenant database'
						: 'Failed to delete tenant database',
			},
			{ status: 500 },
		)
	}

	const verb = command === 'provision' ? 'provisioned' : 'deleted'
	return Response.json({
		success: true,
		orgId,
		region: 'us',
		message: `Database ${verb} for tenant ${orgId} in us`,
		...(recordings ? { recordings } : {}),
	})
}

const tickBodySchema = z.object({ orgId: z.unknown().optional() })

/**
 * The hourly tick on the Workers runtime, for staffing, reservations,
 * loyalty and inventory. The cron posts here without an organization; each organization's
 * data lives in its own Durable Object, so the edge asks every one of them to
 * run its own tick (which lands back in the module's `/api/<module>/tick`
 * route inside the object, behind the same token check) and folds the answers
 * into counts. Organizations without the module cost the object one local
 * query and no outbound call.
 */
type TickModuleName = 'staff' | 'reservations' | 'loyalty' | 'inventory'

async function handleTickFanOut(
	request: Request,
	env: TenantApiWorkerEnv,
	module: TickModuleName,
) {
	const internalToken = env.INTERNAL_COMMAND_TOKEN || ''
	if (internalToken.length < 16) {
		return Response.json({ error: 'Tick is not configured' }, { status: 503 })
	}
	const presented = getBearerToken(request.headers.get('Authorization'))
	if (!presented || !timingSafeEqualString(presented, internalToken)) {
		return Response.json({ error: 'Unauthorized' }, { status: 401 })
	}

	const body = await request
		.clone()
		.json()
		.catch(() => ({}))
	const parsed = tickBodySchema.safeParse(body ?? {})
	// An orgId that is present but malformed is a mistake, not "run everyone".
	if (!parsed.success || parsed.data.orgId !== undefined) {
		return Response.json({ error: 'Invalid payload' }, { status: 400 })
	}

	const orgIds = await registryStub(env).list()
	const tickUrl = new URL(`/api/${module}/tick`, request.url)
	const runOne = async <T>(orgId: string): Promise<T | null> => {
		const failed = (detail: unknown): null => {
			console.error(
				`Tick fan-out (${module}) failed for organization`,
				orgId,
				detail,
			)
			return null
		}
		try {
			const forwarded = new Request(tickUrl, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ orgId }),
			})
			const response = await forwardToOrg(forwarded, env, orgId)
			if (!response.ok) return failed(response.status)
			const answer = (await response.json().catch(() => null)) as {
				result?: T
			} | null
			return answer?.result ?? failed('no result')
		} catch (error) {
			return failed(error)
		}
	}
	const totals =
		module === 'staff'
			? await fanOutStaffTick({
					orgIds,
					run: (orgId) => runOne<TickResult>(orgId),
				})
			: module === 'reservations'
				? await fanOutReservationsTick({
						orgIds,
						run: (orgId) => runOne<ReservationsTickResult>(orgId),
					})
				: module === 'inventory'
					? await fanOutInventoryTick({
							orgIds,
							run: (orgId) => runOne<InventoryTickOutcome>(orgId),
						})
					: await fanOutLoyaltyTick({
							orgIds,
							run: (orgId) => runOne<LoyaltyTickResult>(orgId),
						})
	return Response.json({ success: totals.errors === 0, ...totals })
}

const ALLOW_ORIGIN_HEADER = 'Access-Control-Allow-Origin'

function terminalCorsOrigin(
	url: string,
	headers: Headers,
	hasAllowOrigin: boolean,
): string | null {
	if (hasAllowOrigin) return null
	const candidate = headers.get('Origin')
	if (!candidate) return null
	const path = new URL(url).pathname
	const terminalPath =
		path.startsWith('/pos/') || path.startsWith('/operator/reservations/book/')
	if (!terminalPath || !isPosOrigin(candidate)) return null
	try {
		return new URL(candidate).origin
	} catch {
		return null
	}
}

/**
 * Refusals made here, before a request reaches the app (and its CORS layer),
 * still carry CORS for a Station till's origin, so the till reads the code
 * ("invalid_device", "region_mismatch") instead of a bare network error.
 */
export function withTerminalCors(request: Request, response: Response) {
	const allowedOrigin = terminalCorsOrigin(
		request.url,
		request.headers,
		response.headers.has('Access-Control-Allow-Origin'),
	)
	if (!allowedOrigin) return response
	const headers = new Headers(response.headers)
	// The value is an origin `isPosOrigin` accepted (exact match against
	// POS_ORIGINS, or a local dev host), never an arbitrary caller input.
	headers.set(ALLOW_ORIGIN_HEADER, allowedOrigin)
	headers.append('Vary', 'Origin')
	// As the app does: the till measures its clock skew from the Date header.
	headers.set('Access-Control-Expose-Headers', 'Date')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

const worker = {
	async fetch(
		request: Request,
		env: TenantApiWorkerEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		return withTerminalCors(request, await handle(request, env, ctx))
	},
}

async function handle(
	request: Request,
	env: TenantApiWorkerEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	applyWorkerEnv(env)
	assertTenantApiSecrets()
	// No consent-origin assert here: a missing TENANT_API_URL must not take
	// the whole Worker (health, login, provisioning) down. Each email send
	// checks `consentBaseUrl()` and skips (or fails the broadcast) instead.
	// The hard startup assert stays on the Node entry (`src/index.ts`).

	setListTenantOrgIdsProvider(async () => registryStub(env).list())

	const url = new URL(request.url)

	if (request.method === 'OPTIONS') {
		return edgeApp.fetch(request, env)
	}

	if (url.pathname === '/health' || url.pathname === '/api/health') {
		return edgeApp.fetch(request, env)
	}

	if (url.pathname === '/api/provision' && request.method === 'POST') {
		return handleProvision(request, env, ctx, 'provision')
	}

	if (url.pathname === '/api/deprovision' && request.method === 'POST') {
		return handleProvision(request, env, ctx, 'deprovision')
	}

	if (
		url.pathname === '/api/marketing/sync-engagement' &&
		request.method === 'POST'
	) {
		const orgId = await resolveOrgId(request, env)
		if (orgId) {
			const regionDenied = await assertOrgOnUsNode(orgId, env, request)
			if (regionDenied) return regionDenied
			return forwardToOrg(request, env, orgId)
		}
		return edgeApp.fetch(request, env)
	}

	const tickModule: TickModuleName | null =
		request.method !== 'POST'
			? null
			: url.pathname === '/api/staff/tick'
				? 'staff'
				: url.pathname === '/api/reservations/tick'
					? 'reservations'
					: url.pathname === '/api/loyalty/tick'
						? 'loyalty'
						: url.pathname === '/api/inventory/tick'
							? 'inventory'
							: null
	if (tickModule) {
		const tickOrgId = await resolveOrgId(request, env)
		if (tickOrgId) {
			const regionDenied = await assertOrgOnUsNode(tickOrgId, env, request)
			if (regionDenied) return regionDenied
			return forwardToOrg(request, env, tickOrgId)
		}
		return handleTickFanOut(request, env, tickModule)
	}

	const orgId = await resolveOrgId(request, env)
	const isTerminalPath =
		url.pathname.startsWith('/kiosk/') || url.pathname.startsWith('/pos/')
	if (!orgId && isTerminalPath) {
		return Response.json(
			{
				error:
					url.pathname === '/kiosk/pair' || url.pathname === '/pos/pair'
						? 'invalid_pairing_code'
						: 'invalid_device',
			},
			{ status: 401 },
		)
	}
	if (!orgId && isPublicReservationsPath(url.pathname)) {
		return reservationsPublicNotFound()
	}
	if (
		!orgId &&
		(url.pathname === '/schedule-link' ||
			url.pathname.startsWith('/schedule-link/'))
	) {
		return Response.json(
			{ error: 'invalid_link' },
			{ status: 401, headers: { 'Cache-Control': 'private, no-store' } },
		)
	}
	if (!orgId) {
		return Response.json(
			{ error: 'Could not resolve tenant organization for this request' },
			{ status: 400 },
		)
	}

	if (isTerminalPath) {
		const kioskDenied = await assertKioskOrgOnUsNode(
			orgId,
			url.pathname,
			request.headers.get('CF-Connecting-IP'),
		)
		if (kioskDenied) return kioskDenied
		return forwardToOrg(request, env, orgId)
	}

	const regionDenied = isPublicReservationsPath(url.pathname)
		? await assertReservationsOrgOnUsNode(orgId)
		: await assertOrgOnUsNode(orgId, env, request)
	if (regionDenied) return regionDenied

	return forwardToOrg(request, env, orgId)
}

/**
 * The edge answers some requests itself (unresolvable organization, unknown
 * organization, region mismatch) before the Hono app and its CORS middleware
 * run. A browser hides a response without `Access-Control-Allow-Origin`, so
 * those errors reached operators as an opaque "Failed to fetch". Add the same
 * header the app sets, for allowed origins only.
 */
async function withCors(request: Request, response: Response) {
	// A 101 upgrade response cannot be rebuilt (it carries the socket).
	if (
		response.status === 101 ||
		response.headers.has('Access-Control-Allow-Origin')
	) {
		return response
	}
	const allowOrigin = await resolveCorsAllowOrigin(
		request.headers.get('Origin'),
	)
	if (!allowOrigin) return response
	// Responses forwarded from a Durable Object have immutable headers, so build
	// a new response instead of mutating this one.
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: [
			...response.headers,
			['Access-Control-Allow-Origin', allowOrigin],
			['Vary', 'Origin'],
		],
	})
}

export default {
	async fetch(
		request: Request,
		env: TenantApiWorkerEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		return withCors(request, await worker.fetch(request, env, ctx))
	},
}
