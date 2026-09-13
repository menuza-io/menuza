import { contentSecurity } from '@nichtsam/helmet/content'
import {
	NonceProvider,
	isCloudflareWorkerRuntime,
	makeTimings,
} from '@repo/common'
import { getInstanceInfo } from '@repo/common/litefs'
import { i18n, I18nProvider } from '@repo/i18n'
import { logger, sanitizeUrl } from '@repo/observability'
import { isbot } from 'isbot'
import { renderToReadableStream } from 'react-dom/server'
import {
	ServerRouter,
	type LoaderFunctionArgs,
	type ActionFunctionArgs,
	type HandleDocumentRequestFunction,
} from 'react-router'
import { ENV } from 'varlock/env'
import { auditSensitiveRoutes } from '#app/utils/audit/audit-middleware.server.ts'
import {
	sitePreviewFrameSrc,
	tenantApiConnectSrc,
} from '#app/utils/csp-frame-src.server.ts'
import { loadCatalog } from './modules/lingui/lingui'
import { linguiServer } from './modules/lingui/lingui.server'
import { capturePostHogServerException } from './utils/posthog.server.ts'

export const streamTimeout = 5000

const MODE = ENV.NODE_ENV ?? 'development'

function createNonce() {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

type DocRequestArgs = Parameters<HandleDocumentRequestFunction>

function applySecurityHeaders(responseHeaders: Headers) {
	responseHeaders.set('X-Content-Type-Options', 'nosniff')
	responseHeaders.set('X-Frame-Options', 'SAMEORIGIN')
	responseHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin')

	if (ENV.NODE_ENV === 'production') {
		responseHeaders.set(
			'Strict-Transport-Security',
			'max-age=31536000; includeSubDomains; preload',
		)
	}
}

function applyRuntimeHeaders(responseHeaders: Headers, request?: Request) {
	if (isCloudflareWorkerRuntime()) {
		responseHeaders.set('cf-worker', 'menuza-app')
		const cfColo = (request as any)?.cf?.colo
		const datacenter =
			cfColo ||
			(typeof process !== 'undefined' &&
				(process.env?.CF_DATACENTER || process.env?.REGION)) ||
			'unknown'
		responseHeaders.set('cf-datacenter', datacenter)
		return
	}
}

async function applyInstanceHeaders(responseHeaders: Headers) {
	const { currentInstance, primaryInstance } = await getInstanceInfo()
	// Cloudflare Workers instance headers
	responseHeaders.set('cf-instance', currentInstance)
	responseHeaders.set('cf-primary-instance', primaryInstance)
}

function applyContentSecurity(
	responseHeaders: Headers,
	nonce: string,
	builderMode: boolean,
	requestHost?: string | null,
) {
	contentSecurity(responseHeaders, {
		crossOriginEmbedderPolicy: false,
		contentSecurityPolicy: {
			directives: {
				document: {
					'base-uri': ["'self'"],
				},
				navigation: {
					'form-action': ["'self'"],
					'frame-ancestors': ["'self'"],
				},
				fetch: {
					'default-src': ["'self'"],
					'object-src': ["'none'"],
					'connect-src': [
						MODE === 'development' ? 'ws:' : undefined,
						MODE === 'development' ? 'http://localhost:3007' : undefined,
						MODE === 'development' ? 'http://localhost:3009' : undefined,
						ENV.TENANT_API_URL
							? ENV.TENANT_API_URL.replace(/\/$/, '')
							: undefined,
						ENV.TENANT_API_URL_KSA
							? ENV.TENANT_API_URL_KSA.replace(/\/$/, '')
							: undefined,
						ENV.POSTHOG_PROJECT_TOKEN?.startsWith('phc_') && ENV.POSTHOG_HOST
							? new URL(ENV.POSTHOG_HOST).origin
							: undefined,
						ENV.POSTHOG_PROJECT_TOKEN?.startsWith('phc_')
							? 'https://*.posthog.com'
							: undefined,
						'https://cdn.jsdelivr.net',
						"'self'",
						...tenantApiConnectSrc(ENV),
					],
					'font-src': ["'self'"],
					'frame-src': sitePreviewFrameSrc(ENV, requestHost),
					'img-src': ["'self'", 'data:'],
					'script-src': builderMode
						? [
								"'unsafe-inline'",
								"'unsafe-eval'",
								"'self'",
								`'nonce-${nonce}'`,
								'https://cdn.builder.io',
							]
						: ["'strict-dynamic'", "'self'", `'nonce-${nonce}'`],
					'script-src-attr': builderMode
						? [`'nonce-${nonce}'`, "'unsafe-inline'"]
						: [`'nonce-${nonce}'`],
					'worker-src': ["'self'", 'blob:', 'data:'],
				},
			},
		},
	})
}

export default async function handleRequest(...args: DocRequestArgs) {
	const [request, responseStatusCode, responseHeaders, reactRouterContext] =
		args

	void auditSensitiveRoutes(
		request,
		new Response(null, { status: responseStatusCode }),
	)

	applySecurityHeaders(responseHeaders)
	applyRuntimeHeaders(responseHeaders, request)
	await applyInstanceHeaders(responseHeaders)

	const nonce = createNonce()
	const locale = await linguiServer.getLocale(request)
	await loadCatalog(locale)

	const builderMode =
		MODE === 'development' &&
		request.url.includes('builder.my') &&
		!isCloudflareWorkerRuntime()
	const requestHost =
		request.headers.get('x-forwarded-host') ?? request.headers.get('host')

	let didError = false
	const timings = makeTimings('render', 'renderToReadableStream')

	const stream = await renderToReadableStream(
		<I18nProvider i18n={i18n}>
			<NonceProvider value={nonce}>
				<ServerRouter
					nonce={nonce}
					context={reactRouterContext}
					url={request.url}
				/>
			</NonceProvider>
		</I18nProvider>,
		{
			nonce,
			onError: () => {
				didError = true
			},
		},
	)

	if (isbot(request.headers.get('user-agent'))) {
		await stream.allReady
	}

	responseHeaders.set('Content-Type', 'text/html')
	responseHeaders.append('Server-Timing', timings.toString())
	applyContentSecurity(responseHeaders, nonce, builderMode, requestHost)

	return new Response(stream, {
		headers: responseHeaders,
		status: didError ? 500 : responseStatusCode,
	})
}

export async function handleDataRequest(response: Response) {
	applyRuntimeHeaders(response.headers)
	await applyInstanceHeaders(response.headers)
	return response
}

export function handleError(
	error: unknown,
	{ request, context }: LoaderFunctionArgs | ActionFunctionArgs,
): void {
	if (request.signal.aborted) {
		return
	}

	const requestLogger = logger.child({
		url: sanitizeUrl(request.url),
		method: request.method,
	})

	if (error instanceof Error) {
		requestLogger.error({ err: error }, 'Request handling error')
	} else {
		requestLogger.error({ error }, 'Unknown error in request handling')
	}

	capturePostHogServerException(context, error, request)
}
