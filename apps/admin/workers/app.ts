/// <reference types="@cloudflare/workers-types" />

// Worker entry for the admin dashboard (Cloudflare Workers).
import './polyfill-crypto.ts'
import {
	createContext,
	createRequestHandler,
	RouterContextProvider,
} from 'react-router'
import { initVarlockEnv } from 'varlock/env'
import { executionContext } from '../app/utils/after-response.server.ts'
import { bindAppService } from '../app/utils/app-service.server.ts'

const cloudflareContext = createContext<{
	env: Env
	ctx: ExecutionContext
}>()

type RequestHandler = ReturnType<typeof createRequestHandler>

let requestHandler: RequestHandler | undefined
let requestHandlerPromise: Promise<RequestHandler> | undefined

function applyWorkerEnv(env: Env) {
	// Cloudflare bindings are the production source of truth. Keep the Varlock
	// proxy and process.env aligned for shared packages that read ENV.* while
	// avoiding any build-time environment snapshot in the Worker bundle.
	const existingConfig = (globalThis as any).__varlockLoadedEnv?.config ?? {}
	const newConfig: Record<string, { value: unknown }> = {}
	for (const [key, value] of Object.entries(env)) {
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			// Preserve Varlock's sensitivity metadata when a legacy bootstrap blob is
			// present, but never retain a value that is absent from Cloudflare `env`.
			newConfig[key] = { ...existingConfig[key], value: String(value) }
			if (typeof process !== 'undefined' && process.env) {
				process.env[key] = String(value)
			}
		}
	}
	;(globalThis as any).__varlockLoadedEnv = {
		...(globalThis as any).__varlockLoadedEnv,
		config: newConfig,
	}
	initVarlockEnv({ allowFail: true })
}

/**
 * Wall-clock time one cron run gives a platform campaign dispatch. A Cron
 * Trigger may run for up to 15 minutes; the dispatch stops between sends
 * well before that, and the next run (every 5 minutes) picks up the rest.
 */
const CRON_DISPATCH_BUDGET_MS = 10 * 60 * 1000

/**
 * Sets up everything a request or a cron run needs: the env, the server build
 * (which initializes Varlock), and the D1, KV and App bindings.
 */
async function prepareWorker(env: Env) {
	applyWorkerEnv(env)
	const [cacheModule, databaseModule] = await Promise.all([
		import('@repo/cache'),
		import('@repo/database'),
	])
	requestHandlerPromise ??= import('virtual:react-router/server-build').then(
		(build) => {
			// The server build initializes Varlock before route modules load.
			// Reapply bindings after that bootstrap so runtime values still win.
			applyWorkerEnv(env)
			return createRequestHandler(build, import.meta.env.MODE)
		},
	)
	requestHandler ??= await requestHandlerPromise
	databaseModule.bindCloudflareD1(env.DB)
	cacheModule.bindCacheKV(env.CACHE)
	bindAppService(env.APP)
	return requestHandler
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const [handler, linguiModule] = await Promise.all([
			prepareWorker(env),
			import('../app/modules/lingui/lingui.server.ts'),
		])
		await linguiModule.ensureLinguiRequestLocale(request)

		const loadContext = new RouterContextProvider()
		loadContext.set(cloudflareContext, { env, ctx })
		loadContext.set(executionContext, ctx)

		return handler(request, loadContext)
	},

	// Cron Trigger (`triggers.crons` in wrangler.jsonc): finishes platform
	// campaigns whose dispatch stopped, independent of anyone opening Admin.
	async scheduled(
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	) {
		await prepareWorker(env)
		const { resumeStalePlatformCampaigns } =
			await import('@repo/marketing/server/platform-campaigns')
		const { resumed } = await resumeStalePlatformCampaigns({
			runInBackground: (task) => {
				ctx.waitUntil(
					task().catch((error: unknown) => {
						console.error('Platform campaign cron dispatch failed', error)
					}),
				)
			},
			dispatch: { budgetMs: CRON_DISPATCH_BUDGET_MS },
		})
		if (resumed.length > 0) {
			console.log(`Resumed ${resumed.length} platform campaign(s)`)
		}
	},
} satisfies ExportedHandler<Env>
