import { invariantResponse } from '@epic-web/invariant'
import { getDomainUrl, isCloudflareWorkerRuntime } from '@repo/common'
import { ssrfSafeFetch, validateInstanceUrl } from '@repo/security'
import {
	getSignedGetRequestInfoAsync,
	getSignedHeadRequestInfoAsync,
} from '#app/utils/storage.server.ts'
import { type Route } from './+types/images'

const ALLOWED_RASTER_MIME_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
])

type ImageFit = 'cover' | 'contain'
type ImageFormat = 'webp' | 'avif' | 'png' | 'jpeg' | 'jpg'

type ImageParams = {
	width?: number
	height?: number
	fit?: ImageFit
	format?: ImageFormat
}

function parseImageParams(searchParams: URLSearchParams): ImageParams {
	const width = searchParams.get('w')
	const height = searchParams.get('h')
	const fit = searchParams.get('fit')
	const format = searchParams.get('format')

	return {
		width: width ? Number.parseInt(width, 10) : undefined,
		height: height ? Number.parseInt(height, 10) : undefined,
		fit: fit === 'cover' || fit === 'contain' ? fit : undefined,
		format:
			format === 'webp' ||
			format === 'avif' ||
			format === 'png' ||
			format === 'jpeg' ||
			format === 'jpg'
				? format
				: undefined,
	}
}

const VIDEO_OBJECT_KEY = /\.(mp4|webm|mov|m4v)$/i
const VIDEO_PASSTHROUGH_HEADERS = [
	'content-type',
	'content-length',
	'content-range',
	'accept-ranges',
	'etag',
	'last-modified',
] as const

function isVideoObjectKey(objectKey: string) {
	return VIDEO_OBJECT_KEY.test(objectKey)
}

async function streamStoredVideo(
	request: Request,
	objectKey: string,
	organizationId: string | null,
) {
	const method = request.method === 'HEAD' ? 'HEAD' : 'GET'
	const { url: storageUrl, headers: signedHeaders } =
		method === 'HEAD'
			? await getSignedHeadRequestInfoAsync(
					objectKey,
					organizationId ?? undefined,
				)
			: await getSignedGetRequestInfoAsync(
					objectKey,
					organizationId ?? undefined,
				)

	const upstreamHeaders = new Headers(signedHeaders)
	const range = request.headers.get('Range')
	if (range) upstreamHeaders.set('Range', range)

	const upstream = await fetch(storageUrl, {
		method,
		headers: upstreamHeaders,
	})

	const responseHeaders = getImageResponseHeaders()
	for (const headerName of VIDEO_PASSTHROUGH_HEADERS) {
		const value = upstream.headers.get(headerName)
		if (value) responseHeaders.set(headerName, value)
	}
	responseHeaders.set('Accept-Ranges', 'bytes')

	if (method === 'HEAD') {
		return new Response(null, {
			status: upstream.status,
			headers: responseHeaders,
		})
	}

	return new Response(upstream.body, {
		status: upstream.status,
		headers: responseHeaders,
	})
}

function getImageResponseHeaders(isExternal = false) {
	const headers = new Headers()
	headers.set(
		'Cache-Control',
		isExternal ? 'no-store' : 'public, max-age=31536000, immutable',
	)
	headers.set('Access-Control-Allow-Origin', '*')
	headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
	return headers
}

async function fetchExternalImage(
	request: Request,
	searchParams: URLSearchParams,
) {
	const src = searchParams.get('src')
	invariantResponse(src, 'src query parameter is required', { status: 400 })

	const sourceUrl = new URL(src)
	const requestUrl = new URL(request.url)
	invariantResponse(
		sourceUrl.origin !== requestUrl.origin,
		'External image source required',
		{ status: 400 },
	)

	const upstream = await ssrfSafeFetch(sourceUrl)
	const rawContentType = upstream.headers.get('content-type')
	const mimeType = rawContentType?.split(';')[0]?.trim().toLowerCase()
	if (!mimeType || !ALLOWED_RASTER_MIME_TYPES.has(mimeType)) {
		throw new Response('Unsupported Media Type', { status: 415 })
	}

	const headers = getImageResponseHeaders(true)
	headers.set('Content-Type', mimeType)

	return new Response(upstream.body, {
		status: upstream.status,
		headers,
	})
}

async function fetchImageSource(
	request: Request,
	searchParams: URLSearchParams,
	objectKey: string | null,
	organizationId: string | null,
) {
	if (objectKey) {
		const { url: signedUrl, headers: signedHeaders } =
			await getSignedGetRequestInfoAsync(objectKey, organizationId ?? undefined)
		return fetch(signedUrl, { headers: signedHeaders })
	}

	const src = searchParams.get('src')
	invariantResponse(src, 'src query parameter is required', { status: 400 })

	if (URL.canParse(src)) {
		const validation = validateInstanceUrl(src)
		if (!validation.valid) {
			throw new Error(`Invalid image URL: ${validation.reason}`)
		}
		return fetch(src)
	}

	const normalizedSrc = src.replace(/\\/g, '/').replace(/\.\.+/g, '')
	const assetUrl = new URL(normalizedSrc, request.url)
	return fetch(assetUrl)
}

async function getCloudflareImageResponse(
	request: Request,
	searchParams: URLSearchParams,
	objectKey: string | null,
	organizationId: string | null,
) {
	const params = parseImageParams(searchParams)
	const upstream = await fetchImageSource(
		request,
		searchParams,
		objectKey,
		organizationId,
	)

	const src = searchParams.get('src')
	const isExternal = Boolean(
		!objectKey &&
		src &&
		URL.canParse(src) &&
		new URL(src).origin !== new URL(request.url).origin,
	)

	if (!upstream.ok) {
		return new Response(upstream.statusText, {
			status: upstream.status,
			headers: getImageResponseHeaders(isExternal),
		})
	}

	const shouldTransform =
		params.width != null ||
		params.height != null ||
		params.fit != null ||
		params.format != null

	if (shouldTransform) {
		const imageOptions: Record<string, number | string> = {}
		if (params.width != null) imageOptions.width = params.width
		if (params.height != null) imageOptions.height = params.height
		if (params.fit != null) imageOptions.fit = params.fit
		if (params.format != null) imageOptions.format = params.format

		const transformed = await fetch(upstream.url, {
			headers: upstream.headers,
			cf: { image: imageOptions },
		} as RequestInit & { cf?: { image: Record<string, number | string> } })

		if (transformed.ok) {
			const rawContentType = transformed.headers.get('content-type')
			const mimeType = rawContentType?.split(';')[0]?.trim().toLowerCase()
			if (
				isExternal &&
				(!mimeType || !ALLOWED_RASTER_MIME_TYPES.has(mimeType))
			) {
				throw new Response('Unsupported Media Type', { status: 415 })
			}
			const headers = getImageResponseHeaders(isExternal)
			if (mimeType) headers.set('Content-Type', mimeType)
			return new Response(transformed.body, { headers, status: 200 })
		}
	}

	const rawContentType = upstream.headers.get('content-type')
	const mimeType = rawContentType?.split(';')[0]?.trim().toLowerCase()
	if (isExternal && (!mimeType || !ALLOWED_RASTER_MIME_TYPES.has(mimeType))) {
		throw new Response('Unsupported Media Type', { status: 415 })
	}
	const headers = getImageResponseHeaders(isExternal)
	if (mimeType) headers.set('Content-Type', mimeType)
	return new Response(upstream.body, { headers, status: 200 })
}

let cacheDir: string | 'no_cache' | null = null

async function getCacheDir() {
	if (cacheDir) return cacheDir

	const { promises: fs, constants } = await import('node:fs')

	let dir: string | 'no_cache' = './tests/fixtures/openimg'
	if (process.env.NODE_ENV === 'production') {
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

export async function loader({ request }: Route.LoaderArgs) {
	const url = new URL(request.url)
	const searchParams = url.searchParams

	const objectKey = searchParams.get('objectKey')
	const organizationId = searchParams.get('organizationId')

	if (objectKey) {
		if (
			objectKey.length < 16 ||
			objectKey.includes('..') ||
			!/^[a-zA-Z0-9_\-./]+$/.test(objectKey)
		) {
			invariantResponse(false, 'Invalid or low-entropy objectKey parameter', {
				status: 400,
			})
		}
		if (isVideoObjectKey(objectKey)) {
			return streamStoredVideo(request, objectKey, organizationId)
		}
	}

	const src = searchParams.get('src')
	if (
		src &&
		URL.canParse(src) &&
		new URL(src).origin !== url.origin &&
		!isCloudflareWorkerRuntime()
	) {
		return fetchExternalImage(request, searchParams)
	}

	if (isCloudflareWorkerRuntime()) {
		return getCloudflareImageResponse(
			request,
			searchParams,
			objectKey,
			organizationId,
		)
	}

	const { getImgResponse } = await import('openimg/node')

	const isExternal = Boolean(
		!objectKey &&
		src &&
		URL.canParse(src) &&
		new URL(src).origin !== url.origin,
	)
	const headers = getImageResponseHeaders(isExternal)

	return getImgResponse(request, {
		headers,
		allowlistedOrigins: [
			getDomainUrl(request),
			process.env.AWS_ENDPOINT_URL_S3,
		].filter(Boolean),
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

			const normalizedSrc = src.replace(/\\/g, '/').replace(/\.\.+/g, '')

			if (normalizedSrc.startsWith('/assets')) {
				return {
					type: 'fs',
					path: '.' + normalizedSrc,
				}
			}
			return {
				type: 'fs',
				path: './public' + normalizedSrc,
			}
		},
	})
}
