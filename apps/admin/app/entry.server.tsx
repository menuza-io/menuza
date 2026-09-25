import { styleText } from 'node:util'
import { contentSecurity } from '@nichtsam/helmet/content'
import { NonceProvider, makeTimings } from '@repo/common'
import { getInstanceInfo } from '@repo/common/litefs'
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

	if (ENV.NODE_ENV === 'production') {
		responseHeaders.set(
			'Strict-Transport-Security',
			'max-age=31536000; includeSubDomains; preload',
		)
	}
}

function applyContentSecurity(
	responseHeaders: Headers,
	nonce: string,
	options: { relaxed: boolean },
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
					'connect-src': [MODE === 'development' ? 'ws:' : undefined, "'self'"],
					'font-src': ["'self'"],
					'frame-src': ["'self'", 'builder.io'],
					'img-src': ["'self'", 'data:'],
					'script-src': options.relaxed
						? [
								"'unsafe-inline'",
								"'unsafe-eval'",
								"'self'",
								`'nonce-${nonce}'`,
								'https://cdn.builder.io',
							]
						: ["'strict-dynamic'", "'self'", `'nonce-${nonce}'`],
					'script-src-attr': options.relaxed
						? [`'nonce-${nonce}'`, "'unsafe-inline'"]
						: [`'nonce-${nonce}'`],
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

	const nonce = createNonce()
	const locale = await linguiServer.getLocale(request)
	await loadCatalog(locale)

	const relaxedCsp =
		MODE === 'development' && request.url.includes('builder.my')
	const timings = makeTimings('render', 'renderToReadableStream')
	const controller = new AbortController()
	const timeoutId = setTimeout(() => controller.abort(), streamTimeout + 5000)

	let didError = false

	try {
		const body = await renderToReadableStream(
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
				signal: controller.signal,
				onError: () => {
					didError = true
				},
			},
		)

		responseHeaders.set('Content-Type', 'text/html')
		responseHeaders.append('Server-Timing', timings.toString())
		if (!relaxedCsp) {
			applyContentSecurity(responseHeaders, nonce, { relaxed: false })
		}

		if (waitForAllContent) {
			await body.allReady
		}

		return new Response(body, {
			headers: responseHeaders,
			status: didError ? 500 : responseStatusCode,
		})
	} finally {
		clearTimeout(timeoutId)
	}
}

export async function handleDataRequest(response: Response) {
	const { currentInstance, primaryInstance } = await getInstanceInfo()

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

	if (error instanceof Error) {
		console.error(styleText('red', String(error.stack)))
	} else {
		console.error(error)
	}
}
