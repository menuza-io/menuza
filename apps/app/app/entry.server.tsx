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
import { runAfterResponse } from '#app/utils/after-response.server.ts'
import { auditSensitiveRoutes } from '#app/utils/audit/audit-middleware.server.ts'
import {
	sitePreviewFrameSrc,
	tenantApiConnectSrc,
} from '#app/utils/csp-frame-src.server.ts'
import { liveKitConnectSrc } from '#app/utils/phone-agent/livekit-csp.ts'
import { recordingMediaSrc } from '#app/utils/phone-agent/recording-csp.ts'
import {
	documentContextFor,
	rendersPrivateRoute,
} from '#app/utils/private-client-code.server.ts'
import {
	hasActiveSession,
	sessionStatus,
} from '#app/utils/session-gate.server.ts'
import { turnstileCspSources } from '#app/utils/turnstile.server.ts'
import { loadCatalog } from './modules/lingui/lingui'
import { linguiServer } from './modules/lingui/lingui.server'
import { capturePostHogServerException } from './utils/posthog.server.ts'

export const streamTimeout = 5000

/**
 * For the Node server (`server/index.ts`), which gates `/assets/app/*` and
 * `/__manifest` like the Worker but cannot load `@repo/auth` from source.
 */
export { hasActiveSession }

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
	responseHeaders.set(
		'Permissions-Policy',
		'camera=(self), microphone=(self), geolocation=(), usb=()',
	)
	responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')

	if (ENV.NODE_ENV === 'production') {
		responseHeaders.set(
			'Strict-Transport-Security',
			'max-age=31536000; includeSubDomains; preload',
		)
	}
}

function applyRuntimeHeaders(responseHeaders: Headers, request?: Request) {
	if (isCloudflareWorkerRuntime()) {
		responseHeaders.set('cf-worker', 'epic-startup-app')
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

export function applyContentSecurity(
	responseHeaders: Headers,
	nonce: string,
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
					// OAuth starts with a form POST that redirects to the provider.
					'form-action': [
						"'self'",
						'https://accounts.google.com',
						'https://github.com',
					],
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
						...liveKitConnectSrc(ENV.LIVEKIT_URL),
						// The Turnstile widget talks to its origin from the page too.
						...turnstileCspSources(),
					],
					'font-src': ["'self'"],
					'frame-src': [
						...sitePreviewFrameSrc(ENV, requestHost),
						...turnstileCspSources(),
					],
					'img-src': ["'self'", 'data:', 'blob:'],
					// Voice previews are same-origin; call recordings play from the bucket.
					'media-src': ["'self'", ...recordingMediaSrc(ENV)],
					'script-src': [
						"'strict-dynamic'",
						"'self'",
						`'nonce-${nonce}'`,
						...turnstileCspSources(),
					],
					'script-src-attr': [`'nonce-${nonce}'`],
					// No stylesheets from other origins (the helmet default allows any
					// `https:` one). Inline styles stay: React `style` props need them.
					// Print pages send their own policy (`printDocumentCsp`).
					'style-src': ["'self'", "'unsafe-inline'"],
					'worker-src': ["'self'", 'blob:', 'data:'],
				},
			},
		},
	})
}

export default async function handleRequest(...args: DocRequestArgs) {
	const [
		request,
		responseStatusCode,
		responseHeaders,
		reactRouterContext,
		loadContext,
	] = args

	// Kept alive past the response on Workers via `waitUntil`.
	runAfterResponse(loadContext, () =>
		auditSensitiveRoutes(
			request,
			new Response(null, { status: responseStatusCode }),
		),
	)

	applySecurityHeaders(responseHeaders)
	applyRuntimeHeaders(responseHeaders, request)
	await applyInstanceHeaders(responseHeaders)

	const nonce = createNonce()
	const locale = await linguiServer.getLocale(request)
	await loadCatalog(locale)

	const requestHost =
		request.headers.get('x-forwarded-host') ?? request.headers.get('host')

	// A logged-out visitor's page must not name private route modules.
	// A private route that rendered successfully already passed its loader's
	// session check (route-guards.test.ts), so the common signed-in page costs
	// no second lookup; public pages and error pages ask the database.
	const privateRoute = rendersPrivateRoute(reactRouterContext)
	const session =
		privateRoute && responseStatusCode < 400
			? 'active'
			: await sessionStatus(request)
	if (privateRoute && session === 'unavailable') {
		// The lookup failed, not the session: do not send a signed-in user to
		// the login page, and do not render a page that names private modules.
		const headers = new Headers({
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
			'Retry-After': '5',
		})
		applySecurityHeaders(headers)
		return new Response('Service Unavailable', { status: 503, headers })
	}
	const authenticated = session === 'active'
	if (!authenticated && privateRoute) {
		const url = new URL(request.url)
		const redirectTo = `${url.pathname}${url.search}`
		const headers = new Headers({
			Location: `/login?${new URLSearchParams({ redirectTo })}`,
			'Cache-Control': 'no-store',
		})
		applySecurityHeaders(headers)
		return new Response(null, { status: 302, headers })
	}
	const documentContext = documentContextFor(reactRouterContext, {
		authenticated,
	})

	let didError = false
	const timings = makeTimings('render', 'renderToReadableStream')

	const stream = await renderToReadableStream(
		<I18nProvider i18n={i18n}>
			<NonceProvider value={nonce}>
				<ServerRouter
					nonce={nonce}
					context={documentContext}
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
	applyContentSecurity(responseHeaders, nonce, requestHost)

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
