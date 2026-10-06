/// <reference types="@cloudflare/workers-types" />

// Worker entry for the operator app (Cloudflare Workers).
import './polyfill-crypto.ts'
import {
	createContext,
	createRequestHandler,
	RouterContextProvider,
} from 'react-router'
import { installDevS3Mock } from './dev-s3-mock.ts'
import { applyWorkerEnv } from './worker-env.ts'

// Durable Object classes must be exported from the Worker entry.
export { ChatOrg } from './chat-org.ts'

const cloudflareContext = createContext<{
	env: Env
	ctx: ExecutionContext
}>()

type RequestHandler = ReturnType<typeof createRequestHandler>

let requestHandler: RequestHandler | undefined
let requestHandlerPromise: Promise<RequestHandler> | undefined

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		applyWorkerEnv(env)
		installDevS3Mock(env)
		const [
			cacheModule,
			databaseModule,
			linguiModule,
			siteDataModule,
			tenantApiModule,
			chatNamespaceModule,
			chatUpgradeModule,
		] = await Promise.all([
			import('@repo/cache'),
			import('@repo/database'),
			import('../app/modules/lingui/lingui.server.ts'),
			import('../app/utils/sites/kv-cache.server.ts'),
			import('../app/utils/tenant-api-service.server.ts'),
			import('../app/utils/chat/namespace.server.ts'),
			import('../app/utils/chat/upgrade.server.ts'),
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
		chatNamespaceModule.bindChatNamespace(env.CHAT_ORG)

		// Chat WebSockets bypass the React Router handler: they are authenticated
		// here and forwarded to the organization's Durable Object.
		const chatResponse = await chatUpgradeModule.handleChatRequest(request)
		if (chatResponse) return chatResponse

		await linguiModule.ensureLinguiRequestLocale(request)

		const loadContext = new RouterContextProvider()
		loadContext.set(cloudflareContext, { env, ctx })

		return requestHandler(request, loadContext)
	},
} satisfies ExportedHandler<Env>
