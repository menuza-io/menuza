import { invariantResponse } from '@epic-web/invariant'
import { getDomainUrl } from '@repo/common'
import { ssrfSafeFetch, validateInstanceUrl } from '@repo/security'
import { ENV } from 'varlock/env'
import { isCloudflareWorkerRuntime } from '#app/utils/runtime.server.ts'
import { getSignedGetRequestInfoAsync } from '#app/utils/storage.server.ts'
import { type Route } from './+types/images'

const ALLOWED_RASTER_MIME_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
])

let cacheDir: string | 'no_cache' | null = null

async function fetchExternalImage(request: Request) {
	const url = new URL(request.url)
	const src = url.searchParams.get('src')
	invariantResponse(src, 'src query parameter is required', { status: 400 })

	const sourceUrl = new URL(src)
	invariantResponse(
		sourceUrl.origin !== url.origin,
		'External image source required',
		{
			status: 400,
		},
	)

	const upstream = await ssrfSafeFetch(sourceUrl)
	const rawContentType = upstream.headers.get('content-type')
	const mimeType = rawContentType?.split(';')[0]?.trim().toLowerCase()
	if (!mimeType || !ALLOWED_RASTER_MIME_TYPES.has(mimeType)) {
		throw new Response('Unsupported Media Type', { status: 415 })
	}

	const headers = new Headers()
	headers.set('Cache-Control', 'no-store')
	headers.set('Access-Control-Allow-Origin', '*')
	headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
	headers.set('Content-Type', mimeType)

	return new Response(upstream.body, {
		status: upstream.status,
		headers,
	})
}

async function getCacheDir() {
	if (cacheDir) return cacheDir

	const { promises: fs, constants } = await import('node:fs')

	let dir: string | 'no_cache' = './tests/fixtures/openimg'
	if (ENV.NODE_ENV === 'production') {
		const isAccessible = await fs
			.access('/data', constants.W_OK)
			.then(() => true)
			.catch(() => false)

		if (isAccessible) {
			dir = '/data/images'
		} else {
			console.warn(
				'Production cache directory /data is not writable, disabling image cache',
			)
			dir = 'no_cache'
		}
	}

	return (cacheDir = dir)
}

async function getCloudflareImageResponse(request: Request) {
	const url = new URL(request.url)
	const searchParams = url.searchParams

	const headers = new Headers()

	const objectKey = searchParams.get('objectKey')
	const organizationId = searchParams.get('organizationId')
	const src = searchParams.get('src')
	const isExternal = Boolean(
		!objectKey &&
		src &&
		URL.canParse(src) &&
		new URL(src).origin !== url.origin,
	)

	let imageUrl: string
	let fetchHeaders: HeadersInit | undefined

	if (objectKey) {
		headers.set('Cache-Control', 'public, max-age=31536000, immutable')
		if (
			objectKey.length < 16 ||
			objectKey.includes('..') ||
			!/^[a-zA-Z0-9_\-./]+$/.test(objectKey)
		) {
			invariantResponse(false, 'Invalid or low-entropy objectKey parameter', {
				status: 400,
			})
		}

		const { url: signedUrl, headers: signedHeaders } =
			await getSignedGetRequestInfoAsync(objectKey, organizationId!)
		imageUrl = signedUrl
		fetchHeaders = signedHeaders
	} else {
		headers.set(
			'Cache-Control',
			isExternal ? 'no-store' : 'public, max-age=31536000, immutable',
		)
		invariantResponse(src, 'src query parameter is required', { status: 400 })

		if (URL.canParse(src)) {
			const validation = validateInstanceUrl(src)
			if (!validation.valid) {
				throw new Error(`Invalid image URL: ${validation.reason}`)
			}
			imageUrl = src
		} else {
			const normalizedSrc = src.replace(/\\/g, '/').replace(/\.\.+/g, '')
			const assetPath = normalizedSrc.startsWith('/')
				? normalizedSrc
				: `/${normalizedSrc}`
			imageUrl = new URL(assetPath, url.origin).toString()
		}
	}

	const imageResponse = await fetch(imageUrl, {
		headers: fetchHeaders,
	})

	if (!imageResponse.ok) {
		throw new Response('Not Found', { status: 404 })
	}

	const rawContentType = imageResponse.headers.get('content-type')
	const mimeType = rawContentType?.split(';')[0]?.trim().toLowerCase()
	if (isExternal && (!mimeType || !ALLOWED_RASTER_MIME_TYPES.has(mimeType))) {
		throw new Response('Unsupported Media Type', { status: 415 })
	}
	if (mimeType) {
		headers.set('Content-Type', mimeType)
	}

	return new Response(imageResponse.body, {
		headers,
		status: imageResponse.status,
	})
}

export async function loader({ request }: Route.LoaderArgs) {
	const url = new URL(request.url)
	const src = url.searchParams.get('src')
	if (
		src &&
		URL.canParse(src) &&
		new URL(src).origin !== url.origin &&
		!isCloudflareWorkerRuntime()
	) {
		return fetchExternalImage(request)
	}

	if (isCloudflareWorkerRuntime()) {
		return getCloudflareImageResponse(request)
	}

	const { getImgResponse } = await import('openimg/node')

	const searchParams = url.searchParams

	const objectKey = searchParams.get('objectKey')
	const organizationId = searchParams.get('organizationId')

	const isExternal = Boolean(
		!objectKey &&
		src &&
		URL.canParse(src) &&
		new URL(src).origin !== url.origin,
	)
	const headers = new Headers()
	headers.set(
		'Cache-Control',
		isExternal ? 'no-store' : 'public, max-age=31536000, immutable',
	)

	return getImgResponse(request, {
		headers,
		allowlistedOrigins: [getDomainUrl(request), ENV.AWS_ENDPOINT_URL_S3].filter(
			Boolean,
		),
		cacheFolder: await getCacheDir(),
		getImgSource: async () => {
			if (objectKey) {
				const { url: signedUrl, headers: signedHeaders } =
					await getSignedGetRequestInfoAsync(objectKey, organizationId!)
				return {
					type: 'fetch',
					url: signedUrl,
					headers: signedHeaders,
				}
			}

			const src = searchParams.get('src')
			invariantResponse(src, 'src query parameter is required', { status: 400 })

			if (URL.canParse(src)) {
				const validation = validateInstanceUrl(src)
				if (!validation.valid) {
					throw new Error(`Invalid image URL: ${validation.reason}`)
				}
				return {
					type: 'fetch',
					url: src,
				}
			}
			if (src.startsWith('/assets')) {
				return {
					type: 'fs',
					path: '.' + src,
				}
			}
			return {
				type: 'fs',
				path: './public' + src,
			}
		},
	})
}
