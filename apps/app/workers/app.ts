/// <reference types="@cloudflare/workers-types" />

import './polyfill-crypto.ts'
import { bindCacheKV } from '@repo/cache'
import { bindCloudflareD1 } from '@repo/database'
import {
	createContext,
	createRequestHandler,
	RouterContextProvider,
} from 'react-router'
import { initVarlockEnv } from 'varlock/env'
import { ensureLinguiRequestLocale } from '../app/modules/lingui/lingui.server.ts'
import { bindSiteDataKV } from '../app/utils/sites/kv-cache.server.ts'
import { bindTenantApiService } from '../app/utils/tenant-api-service.server.ts'

const cloudflareContext = createContext<{
	env: Env
	ctx: ExecutionContext
}>()

type RequestHandler = ReturnType<typeof createRequestHandler>

let requestHandler: RequestHandler | undefined
let requestHandlerPromise: Promise<RequestHandler> | undefined

function applyWorkerEnv(env: Env) {
	const existingConfig = (globalThis as any).__varlockLoadedEnv?.config ?? {}
	const newConfig: Record<string, { value: unknown }> = { ...existingConfig }
	for (const [key, value] of Object.entries(env)) {
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean'
		) {
			newConfig[key] = { ...newConfig[key], value: String(value) }
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
		requestHandlerPromise ??= import('virtual:react-router/server-build').then(
			(build) => {
				// The server build initializes Varlock's build-time fallback graph.
				// Reapply bindings so runtime values (notably BASE_URL) win.
				applyWorkerEnv(env)
				return createRequestHandler(build, import.meta.env.MODE)
			},
		)
		requestHandler ??= await requestHandlerPromise
		bindCloudflareD1(env.DB)
		bindCacheKV(env.CACHE)
		bindSiteDataKV((env as any).SITES_DATA_KV)
		if ((env as any).TENANT_API) {
			bindTenantApiService((env as any).TENANT_API)
		}
		await ensureLinguiRequestLocale(request)

		const loadContext = new RouterContextProvider()
		loadContext.set(cloudflareContext, { env, ctx })

		return requestHandler(request, loadContext)
	},
} satisfies ExportedHandler<Env>
