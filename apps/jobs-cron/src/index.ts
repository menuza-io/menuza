import { MarketingJourneyWorkflow } from './marketing-journey-workflow'
import { StorageMigrationWorkflow } from './storage-migration-workflow'
import type { MarketingJourneyWorkflowParams } from './types'

export interface Env {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
	TENANT_API_URL?: string
	TENANT_API_URL_KSA?: string
	STORAGE_MIGRATION_WORKFLOW: Workflow<{ migrationId: string }>
	MARKETING_JOURNEY_WORKFLOW: Workflow<MarketingJourneyWorkflowParams>
}

const JOB_ROUTES = {
	'0 2 * * *': '/resources/jobs/audit-log-archival',
	'0 3 * * *': '/resources/jobs/mcp-token-cleanup',
	'0 4 * * *': '/resources/jobs/gdpr-erasure',
	'0 5 * * *': '/resources/jobs/form-submission-retention',
} as const

const TENANT_ENGAGEMENT_SYNC_CRON = '0 * * * *'

async function safeCompareAsync(
	a: string | null | undefined,
	b: string | null | undefined,
): Promise<boolean> {
	if (!a || !b) return false

	const encoder = new TextEncoder()
	const hash = async (value: string) => {
		const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
		return new Uint8Array(digest)
	}

	const hashA = await hash(a)
	const hashB = await hash(b)
	if (hashA.length !== hashB.length) return false

	let result = 0
	for (let i = 0; i < hashA.length; i++) {
		result |= hashA[i]! ^ hashB[i]!
	}
	return result === 0
}

async function requireInternalAuth(request: Request, env: Env) {
	const authHeader = request.headers.get('Authorization')
	const isAuthorized = await safeCompareAsync(
		authHeader,
		`Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
	)
	if (!isAuthorized) {
		return new Response('Unauthorized', { status: 401 })
	}
	return null
}

async function invokeTenantEngagementSync(env: Env) {
	const targets = [env.TENANT_API_URL, env.TENANT_API_URL_KSA].filter(
		(url): url is string => Boolean(url),
	)

	const results = await Promise.allSettled(
		targets.map(async (baseUrl) => {
			const response = await fetch(
				`${baseUrl.replace(/\/$/, '')}/api/marketing/sync-engagement`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ lookbackHours: 48 }),
				},
			)

			if (!response.ok) {
				const body = await response.text().catch(() => '')
				throw new Error(
					`Tenant engagement sync failed for ${baseUrl}: ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`,
				)
			}

			return response.json()
		}),
	)

	const failures = results.filter((result) => result.status === 'rejected')
	if (failures.length > 0) {
		throw new Error(
			failures
				.map((failure) =>
					failure.status === 'rejected' ? failure.reason : null,
				)
				.filter(Boolean)
				.join('\n'),
		)
	}

	return results
}

async function invokeJob(env: Env, path: string) {
	const response = await fetch(
		`${env.APP_BASE_URL.replace(/\/$/, '')}${path}`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
			},
		},
	)

	if (!response.ok) {
		const body = await response.text().catch(() => '')
		throw new Error(
			`Job ${path} failed: ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`,
		)
	}

	return response.json()
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url)
		const pathname = url.pathname

		if (pathname === '/api/health' || pathname === '/health') {
			return Response.json(
				{
					status: 'ok',
					timestamp: new Date().toISOString(),
					service: 'jobs-cron',
				},
				{
					status: 200,
					headers: {
						'Cache-Control': 'no-cache, no-store, must-revalidate',
						'Content-Type': 'application/json',
					},
				},
			)
		}

		// =========================================================================
		// 1. Storage Migration Workflow Endpoints
		// =========================================================================
		if (
			(pathname === '/workflows/storage-migration/start' ||
				pathname === '/api/workflows/storage-migration/start') &&
			request.method === 'POST'
		) {
			const unauthorized = await requireInternalAuth(request, env)
			if (unauthorized) return unauthorized

			const body = ((await request.json().catch(() => ({}))) || {}) as {
				migrationId?: string
			}
			if (!body.migrationId) {
				return Response.json(
					{ error: 'migrationId is required' },
					{ status: 400 },
				)
			}

			const instance = await env.STORAGE_MIGRATION_WORKFLOW.create({
				id: body.migrationId,
				params: { migrationId: body.migrationId },
			})

			return Response.json({ success: true, instanceId: instance.id })
		}

		// =========================================================================
		// 2. Marketing Journey Workflow: Start
		// POST /api/workflows/marketing-journey/start
		// POST /workflows/marketing-journey/start
		// =========================================================================
		if (
			(pathname === '/api/workflows/marketing-journey/start' ||
				pathname === '/workflows/marketing-journey/start') &&
			request.method === 'POST'
		) {
			const unauthorized = await requireInternalAuth(request, env)
			if (unauthorized) return unauthorized

			const body = ((await request.json().catch(() => ({}))) || {}) as Partial<
				MarketingJourneyWorkflowParams & {
					tenantId?: string
					journeyGraph?: MarketingJourneyWorkflowParams['graph']
				}
			>

			const orgId = body.orgId || body.tenantId
			const journeyId = body.journeyId
			const customerId = body.customerId
			const graph = body.graph || body.journeyGraph

			if (!orgId || !journeyId || !customerId || !graph) {
				return Response.json(
					{
						error:
							'Missing required parameters: orgId, journeyId, customerId, and graph are required',
					},
					{ status: 400 },
				)
			}

			const runId = body.runId || body.journeyInstanceId || crypto.randomUUID()
			const instanceId = `journey-${runId}`

			const workflowParams: MarketingJourneyWorkflowParams = {
				orgId,
				journeyId,
				runId,
				customerId,
				tenantApiUrl: body.tenantApiUrl,
				dataRegion: body.dataRegion,
				triggerEvent: body.triggerEvent,
				graph,
				triggerPayload: body.triggerPayload,
			}

			const instance = await env.MARKETING_JOURNEY_WORKFLOW.create({
				id: instanceId,
				params: workflowParams,
			})

			return Response.json({
				success: true,
				instanceId: instance.id,
				runId,
			})
		}

		// =========================================================================
		// 3. Marketing Journey Workflow: Cancel / Terminate
		// POST /api/workflows/marketing-journey/:instanceId/cancel
		// POST /workflows/marketing-journey/:instanceId/cancel
		// =========================================================================
		const cancelMatch = pathname.match(
			/^(?:\/api)?\/workflows\/marketing-journey\/([^/]+)\/cancel$/,
		)
		if (cancelMatch && request.method === 'POST') {
			const unauthorized = await requireInternalAuth(request, env)
			if (unauthorized) return unauthorized

			const instanceId = cancelMatch[1]
			if (!instanceId || instanceId === 'start') {
				return Response.json(
					{ error: 'Instance ID is required' },
					{ status: 400 },
				)
			}

			try {
				const instance = await env.MARKETING_JOURNEY_WORKFLOW.get(instanceId)
				await instance.terminate()
				return Response.json({
					success: true,
					instanceId,
					status: 'terminated',
				})
			} catch (err) {
				return Response.json(
					{
						error: 'Failed to terminate workflow instance',
						message: err instanceof Error ? err.message : String(err),
					},
					{ status: 500 },
				)
			}
		}

		// =========================================================================
		// 4. Marketing Journey Workflow: Status Query
		// GET /api/workflows/marketing-journey/:instanceId
		// GET /workflows/marketing-journey/:instanceId
		// =========================================================================
		const statusMatch = pathname.match(
			/^(?:\/api)?\/workflows\/marketing-journey\/([^/]+)$/,
		)
		if (statusMatch && request.method === 'GET') {
			const unauthorized = await requireInternalAuth(request, env)
			if (unauthorized) return unauthorized

			const instanceId = statusMatch[1]
			if (!instanceId || instanceId === 'start') {
				return new Response('Not Found', { status: 404 })
			}

			try {
				const instance = await env.MARKETING_JOURNEY_WORKFLOW.get(instanceId)
				const status = await instance.status()
				return Response.json({
					success: true,
					instanceId,
					status,
				})
			} catch (err) {
				return Response.json(
					{
						error: 'Failed to retrieve workflow status',
						message: err instanceof Error ? err.message : String(err),
					},
					{ status: 500 },
				)
			}
		}

		return new Response('Not Found', { status: 404 })
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		if (event.cron === TENANT_ENGAGEMENT_SYNC_CRON) {
			ctx.waitUntil(
				invokeTenantEngagementSync(env).catch((error) => {
					console.error('Tenant engagement sync failed', {
						cron: event.cron,
						error: error instanceof Error ? error.message : String(error),
					})
					throw error
				}),
			)
			return
		}

		const path = JOB_ROUTES[event.cron as keyof typeof JOB_ROUTES]
		if (!path) {
			console.error('Unknown cron schedule', { cron: event.cron })
			return
		}

		ctx.waitUntil(
			invokeJob(env, path).catch((error) => {
				console.error('Scheduled job failed', {
					cron: event.cron,
					path,
					error: error instanceof Error ? error.message : String(error),
				})
				throw error
			}),
		)
	},
}

export { StorageMigrationWorkflow, MarketingJourneyWorkflow }
