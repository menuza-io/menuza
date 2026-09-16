/// <reference types="@cloudflare/workers-types" />

import './polyfill-crypto.ts'
import {
	createContext,
	createRequestHandler,
	RouterContextProvider,
} from 'react-router'
import { initVarlockEnv } from 'varlock/env'

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

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		applyWorkerEnv(env)
		const [
			cacheModule,
			databaseModule,
			linguiModule,
			siteDataModule,
			tenantApiModule,
		] = await Promise.all([
			import('@repo/cache'),
			import('@repo/database'),
			import('../app/modules/lingui/lingui.server.ts'),
			import('../app/utils/sites/kv-cache.server.ts'),
			import('../app/utils/tenant-api-service.server.ts'),
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
		siteDataModule.bindSiteDataKV((env as any).SITES_DATA_KV)
		if ((env as any).TENANT_API) {
			tenantApiModule.bindTenantApiService((env as any).TENANT_API)
		}
		await linguiModule.ensureLinguiRequestLocale(request)

		const loadContext = new RouterContextProvider()
		loadContext.set(cloudflareContext, { env, ctx })

		return requestHandler(request, loadContext)
	},
} satisfies ExportedHandler<Env>
