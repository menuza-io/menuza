import { z } from 'zod'
import {
	setListTenantOrgIdsProvider,
	TENANT_ORG_ID_PATTERN,
} from '@repo/tenant-db'
import { createTenantApiApp } from '../src/app.ts'
import { organizationFromProvisionPayload } from '../src/lib/origin.ts'
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
import { assertOrgOnUsNode, resolveOrgId } from './org-router.ts'
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
			{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
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

export default {
	async fetch(
		request: Request,
		env: TenantApiWorkerEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		applyWorkerEnv(env)
		assertTenantApiSecrets()

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
				const regionDenied = await assertOrgOnUsNode(orgId, env)
				if (regionDenied) return regionDenied
				return forwardToOrg(request, env, orgId)
			}
			return edgeApp.fetch(request, env)
		}

		const orgId = await resolveOrgId(request, env)
		if (!orgId) {
			return Response.json(
				{ error: 'Could not resolve tenant organization for this request' },
				{ status: 400 },
			)
		}

		const regionDenied = await assertOrgOnUsNode(orgId, env)
		if (regionDenied) return regionDenied

		return forwardToOrg(request, env, orgId)
	},
}
