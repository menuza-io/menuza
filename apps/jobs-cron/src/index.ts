import { MarketingJourneyWorkflow } from './marketing-journey-workflow'
import {
	SOCIAL_PUBLISH_PATH,
	SocialPostWorkflow,
	type SocialPostWorkflowParams,
} from './social-post-workflow'
import { StorageMigrationWorkflow } from './storage-migration-workflow'
import type { MarketingJourneyWorkflowParams } from './types'

export interface Env {
	APP_BASE_URL: string
	INTERNAL_COMMAND_TOKEN: string
	TENANT_API_URL?: string
	TENANT_API_URL_KSA?: string
	STORAGE_MIGRATION_WORKFLOW: Workflow<{ migrationId: string }>
	MARKETING_JOURNEY_WORKFLOW: Workflow<MarketingJourneyWorkflowParams>
	SOCIAL_POST_WORKFLOW: Workflow<SocialPostWorkflowParams>
}

// The Workers free plan allows five cron triggers per Worker, so daily jobs
// share a trigger instead of each getting its own.
export const JOB_ROUTES: Record<string, readonly string[]> = {
	'0 2 * * *': ['/resources/jobs/audit-log-archival'],
	'0 3 * * *': [
		'/resources/jobs/mcp-token-cleanup',
		'/resources/jobs/job-postings-expiry',
	],
	'0 4 * * *': [
		'/resources/jobs/gdpr-erasure',
		'/resources/jobs/voice-retention',
		'/resources/jobs/staffing-outbox',
	],
	// Not in wrangler.jsonc triggers: form retention has never been enabled in
	// production, and turning it on deletes submissions, so it stays opt-in.
	'0 5 * * *': ['/resources/jobs/form-submission-retention'],
}

// The hourly trigger fans out to the regional nodes: engagement sync and the
// staff tick. They are independent, so one failing never blocks the other.
const TENANT_HOURLY_CRON = '0 * * * *'
// Hourly App job: fetches the status of shipped print orders whose vendor
// webhook may have been missed.
const PRINT_SYNC_PATH = '/resources/jobs/print-sync'
// Scheduled social posts are woken on time by SocialPostWorkflow; the hourly
// sweep only catches a wake-up that could not be started.

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

/**
 * POSTs to every configured regional tenant-api node in parallel and fails if
 * any node fails. Shared by the hourly jobs that fan out to the regions.
 */
async function invokeTenantNodes(
	env: Env,
	options: { path: string; body: Record<string, unknown>; label: string },
) {
	const targets = [env.TENANT_API_URL, env.TENANT_API_URL_KSA].filter(
		(url): url is string => Boolean(url),
	)

	const results = await Promise.allSettled(
		targets.map(async (baseUrl) => {
			const response = await fetch(
				`${baseUrl.replace(/\/$/, '')}${options.path}`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(options.body),
				},
			)

			if (!response.ok) {
				const body = await response.text().catch(() => '')
				throw new Error(
					`${options.label} failed for ${baseUrl}: ${response.status} ${response.statusText}${body ? `\n${body}` : ''}`,
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

async function invokeTenantEngagementSync(env: Env) {
	return invokeTenantNodes(env, {
		path: '/api/marketing/sync-engagement',
		body: { lookbackHours: 48 },
		label: 'Tenant engagement sync',
	})
}

/**
 * The staff tick: reminders, alerts and automatic clock-outs for every
 * organization on each regional node. It rides this hourly trigger (the Worker
 * has no spare cron slot), so on its own it runs at hourly granularity. The US
 * Workers node also wakes per-organization Durable Object alarms, and the OCI
 * node runs an in-process interval, which make it sub-hourly where staff are
 * clocked in; this call is the safety net for both. Every task is idempotent.
 * The response is counts only.
 */
async function invokeTenantStaffTick(env: Env) {
	return invokeTenantNodes(env, {
		path: '/api/staff/tick',
		body: {},
		label: 'Tenant staff tick',
	})
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
		// Social Post Workflow: wake the App when a scheduled post is due
		// POST /workflows/social-post/start  { postId, runAt }
		// =========================================================================
		if (
			(pathname === '/workflows/social-post/start' ||
				pathname === '/api/workflows/social-post/start') &&
			request.method === 'POST'
		) {
			const unauthorized = await requireInternalAuth(request, env)
			if (unauthorized) return unauthorized

			const body = ((await request.json().catch(() => ({}))) || {}) as {
				postId?: unknown
				runAt?: unknown
			}
			const postId = typeof body.postId === 'string' ? body.postId : ''
			const runAt =
				typeof body.runAt === 'string' ? new Date(body.runAt) : new Date('')
			if (!/^[a-z0-9]{8,64}$/i.test(postId) || Number.isNaN(runAt.getTime())) {
				return Response.json(
					{ error: 'postId and runAt are required' },
					{ status: 400 },
				)
			}

			// One instance per post and time: starting it twice is harmless.
			const instanceId = `social-${postId}-${runAt.getTime()}`
			try {
				const instance = await env.SOCIAL_POST_WORKFLOW.create({
					id: instanceId,
					params: { postId, runAt: runAt.toISOString() },
				})
				return Response.json({ success: true, instanceId: instance.id })
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				if (/already[ _]exists/i.test(message)) {
					return Response.json({ success: true, instanceId })
				}
				return Response.json(
					{ error: 'Failed to start social post workflow', message },
					{ status: 500 },
				)
			}
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
		if (event.cron === TENANT_HOURLY_CRON) {
			for (const [name, run] of [
				['Tenant engagement sync', invokeTenantEngagementSync],
				['Tenant staff tick', invokeTenantStaffTick],
				[
					'Print order sync',
					(jobEnv: Env) => invokeJob(jobEnv, PRINT_SYNC_PATH),
				],
				[
					'Social post sweep',
					(jobEnv: Env) => invokeJob(jobEnv, SOCIAL_PUBLISH_PATH),
				],
			] as const) {
				ctx.waitUntil(
					run(env).catch((error) => {
						console.error(`${name} failed`, {
							cron: event.cron,
							error: error instanceof Error ? error.message : String(error),
						})
						throw error
					}),
				)
			}
			return
		}

		const paths = JOB_ROUTES[event.cron]
		if (!paths) {
			console.error('Unknown cron schedule', { cron: event.cron })
			return
		}

		for (const path of paths) {
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
		}
	},
}

export { StorageMigrationWorkflow, MarketingJourneyWorkflow, SocialPostWorkflow }
