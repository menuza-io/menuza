import { z } from 'zod'
import {
	setListTenantOrgIdsProvider,
	TENANT_ORG_ID_PATTERN,
} from '@repo/tenant-db'
import { createTenantApiApp } from '../src/app.ts'
import {
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
	resolveOrgId,
} from './org-router.ts'
import { fanOutStaffTick } from '../src/services/staff-tick-fanout.ts'
import type { TickResult } from '../src/services/staff-tick-service.ts'
import { TENANT_ORG_HEADER, TenantOrg } from './tenant-org.ts'
import { TenantRegistry } from './tenant-registry.ts'
import type { TenantApiWorkerEnv } from './bindings.ts'

export { TenantOrg, TenantRegistry }

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
	const organization = organizationFromProvisionPayload(parsed.data)
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
 * The hourly staff tick on the Workers runtime. The cron posts here without an
 * organization; each organization's data lives in its own Durable Object, so
 * the edge asks every one of them to run its own tick (which lands back in the
 * `/api/staff/tick` route inside the object, behind the same token check) and
 * folds the answers into counts. Organizations without staff cost the object one
 * local query and no outbound call.
 */
async function handleStaffTickFanOut(
	request: Request,
	env: TenantApiWorkerEnv,
) {
	const internalToken = env.INTERNAL_COMMAND_TOKEN || ''
	if (internalToken.length < 16) {
		return Response.json(
			{ error: 'Staff tick is not configured' },
			{ status: 503 },
		)
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
	const tickUrl = new URL('/api/staff/tick', request.url)
	const totals = await fanOutStaffTick({
		orgIds,
		run: async (orgId) => {
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
				if (!response.ok) return null
				const answer = (await response.json().catch(() => null)) as {
					result?: TickResult
				} | null
				return answer?.result ?? null
			} catch (error) {
				console.error('Staff tick fan-out failed for an organization', error)
				return null
			}
		},
	})
	return Response.json({ success: totals.errors === 0, ...totals })
}

const worker = {
	async fetch(
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

		if (url.pathname === '/api/staff/tick' && request.method === 'POST') {
			const tickOrgId = await resolveOrgId(request, env)
			if (tickOrgId) {
				const regionDenied = await assertOrgOnUsNode(tickOrgId, env, request)
				if (regionDenied) return regionDenied
				return forwardToOrg(request, env, tickOrgId)
			}
			return handleStaffTickFanOut(request, env)
		}

		const orgId = await resolveOrgId(request, env)
		if (!orgId && url.pathname.startsWith('/kiosk/')) {
			return Response.json(
				{
					error:
						url.pathname === '/kiosk/pair'
							? 'invalid_pairing_code'
							: 'invalid_device',
				},
				{ status: 401 },
			)
		}
		if (!orgId) {
			return Response.json(
				{ error: 'Could not resolve tenant organization for this request' },
				{ status: 400 },
			)
		}

		if (url.pathname.startsWith('/kiosk/')) {
			const kioskDenied = await assertKioskOrgOnUsNode(orgId, url.pathname)
			if (kioskDenied) return kioskDenied
			return forwardToOrg(request, env, orgId)
		}

		const regionDenied = await assertOrgOnUsNode(orgId, env, request)
		if (regionDenied) return regionDenied

		return forwardToOrg(request, env, orgId)
	},
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
