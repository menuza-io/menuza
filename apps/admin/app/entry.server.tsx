import { styleText } from 'node:util'
import { contentSecurity } from '@nichtsam/helmet/content'
import { NonceProvider, makeTimings } from '@repo/common'
import { getInstanceInfo } from '@repo/common/litefs'
import {
	TRACE_ID_HEADER,
	TraceIdProvider,
	generateTraceId,
	parseTraceId,
	traceIdBootstrapScript,
} from '@repo/common/trace-id'
import { i18n, I18nProvider } from '@repo/i18n'
import { isbot } from 'isbot'
import { renderToReadableStream } from 'react-dom/server'
import {
	ServerRouter,
	type LoaderFunctionArgs,
	type ActionFunctionArgs,
	type HandleDocumentRequestFunction,
} from 'react-router'
import { ENV } from 'varlock/env'
import { auditSensitiveRoutes } from '#app/utils/audit-middleware.server.ts'
import { loadCatalog } from './modules/lingui/lingui'
import { linguiServer } from './modules/lingui/lingui.server'

export const streamTimeout = 5000

const MODE = ENV.NODE_ENV ?? 'development'

type DocRequestArgs = Parameters<HandleDocumentRequestFunction>

function createNonce() {
	const bytes = crypto.getRandomValues(new Uint8Array(16))
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

async function setRuntimeHeaders(responseHeaders: Headers) {
	const { currentInstance, primaryInstance } = await getInstanceInfo()

	// Cloudflare Workers deployment
	responseHeaders.set('cf-worker', 'menuza-admin')
	responseHeaders.set('cf-instance', currentInstance)
	responseHeaders.set('cf-primary-instance', primaryInstance)
}

function setSecurityHeaders(responseHeaders: Headers) {
	responseHeaders.set('X-Content-Type-Options', 'nosniff')
	responseHeaders.set('X-Frame-Options', 'SAMEORIGIN')
	responseHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin')
	responseHeaders.set(
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=(), usb=()',
	)
	responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')

	if (ENV.NODE_ENV === 'production') {
		responseHeaders.set(
			'Strict-Transport-Security',
			'max-age=31536000; includeSubDomains; preload',
		)
	}
}

function applyContentSecurity(responseHeaders: Headers, nonce: string) {
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
					'connect-src': [MODE === 'development' ? 'ws:' : undefined, "'self'"],
					'font-src': ["'self'"],
					'frame-src': ["'self'"],
					'img-src': ["'self'", 'data:'],
					'script-src': ["'strict-dynamic'", "'self'", `'nonce-${nonce}'`],
					'script-src-attr': [`'nonce-${nonce}'`],
				},
			},
		},
	})
}

export default async function handleRequest(...args: DocRequestArgs) {
	const [request, responseStatusCode, responseHeaders, reactRouterContext] =
		args

	// Automatic audit logging for sensitive routes
	void auditSensitiveRoutes(
		request,
		new Response(null, { status: responseStatusCode }),
	)

	await setRuntimeHeaders(responseHeaders)
	setSecurityHeaders(responseHeaders)

	const userAgent = request.headers.get('user-agent')
	const waitForAllContent = isbot(userAgent)

	// The page-load trace id (#385): shown on the error page, written on every
	// log line for this request.
	const traceId =
		parseTraceId(request.headers.get(TRACE_ID_HEADER)) ?? generateTraceId()
	responseHeaders.set(TRACE_ID_HEADER, traceId)

	const nonce = createNonce()
	const locale = await linguiServer.getLocale(request)
	await loadCatalog(locale)

	const timings = makeTimings('render', 'renderToReadableStream')
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), streamTimeout + 5000)

	let didError = false

	try {
		const body = await renderToReadableStream(
			<I18nProvider i18n={i18n}>
				<NonceProvider value={nonce}>
					<TraceIdProvider value={traceId}>
						<ServerRouter
							nonce={nonce}
							context={reactRouterContext}
							url={request.url}
						/>
					</TraceIdProvider>
				</NonceProvider>
			</I18nProvider>,
			{
				nonce,
				bootstrapScriptContent: traceIdBootstrapScript(traceId),
				signal: controller.signal,
				onError: () => {
					didError = true
				},
			},
		)

		responseHeaders.set('Content-Type', 'text/html')
		responseHeaders.append('Server-Timing', timings.toString())
		applyContentSecurity(responseHeaders, nonce)

		if (waitForAllContent) {
			await body.allReady
		}

		const status = didError ? 500 : responseStatusCode
		logFailedRequest(request, status, traceId)
		return new Response(body, {
			headers: responseHeaders,
			status,
		})
	} finally {
		clearTimeout(timeoutId)
	}
}

/**
 * One structured log line (JSON, so the log provider reads `traceId` as a
 * field) for a failed request. Admin has no logger package of its own, and the
 * trace id is what the error page shows and support searches for (#385).
 */
export function logRequestFailure(fields: {
	traceId: string | null
	url: string
	method: string
	statusCode?: number
	error?: unknown
}) {
	const { error, ...rest } = fields
	const path = (() => {
		try {
			return new URL(rest.url).pathname
		} catch {
			return rest.url
		}
	})()
	console.error(
		JSON.stringify({
			level: 'error',
			service: 'admin',
			message: 'Request failed',
			...rest,
			url: undefined,
			path,
			...(error instanceof Error
				? { errorType: error.name, errorMessage: error.message }
				: error !== undefined
					? { errorType: 'UnknownError' }
					: {}),
		}),
	)
}

export function logFailedRequest(
	request: Request,
	status: number,
	traceId: string,
) {
	if (status < 500) return
	logRequestFailure({
		traceId,
		url: request.url,
		method: request.method,
		statusCode: status,
	})
}

export async function handleDataRequest(
	response: Response,
	args?: { request?: Request },
) {
	const { currentInstance, primaryInstance } = await getInstanceInfo()
	const request = args?.request
	const traceId = request
		? parseTraceId(request.headers.get(TRACE_ID_HEADER))
		: null
	if (traceId) {
		response.headers.set(TRACE_ID_HEADER, traceId)
		logFailedRequest(request!, response.status, traceId)
	}

	// Cloudflare Workers deployment
	response.headers.set('cf-worker', 'menuza-admin')
	response.headers.set('cf-instance', currentInstance)
	response.headers.set('cf-primary-instance', primaryInstance)

	return response
}

export function handleError(
	error: unknown,
	{ request }: LoaderFunctionArgs | ActionFunctionArgs,
): void {
	// Skip capturing if the request is aborted as Remix docs suggest
	// Ref: https://remix.run/docs/en/main/file-conventions/entry.server#handleerror
	if (request.signal.aborted) {
		return
	}

	logRequestFailure({
		traceId: parseTraceId(request.headers.get(TRACE_ID_HEADER)),
		url: request.url,
		method: request.method,
		error,
	})
	if (error instanceof Error) {
		console.error(styleText('red', String(error.stack)))
	} else {
		console.error(error)
	}
}
