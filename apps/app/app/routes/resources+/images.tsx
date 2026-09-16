import { createHmac, timingSafeEqual } from 'node:crypto'
import { invariantResponse } from '@epic-web/invariant'
import { getUserId } from '@repo/auth'
import { getDomainUrl, isCloudflareWorkerRuntime } from '@repo/common'
import {
	and,
	db,
	eq,
	OrganizationMediaAsset,
	UserOrganization,
} from '@repo/database'
import { ssrfSafeFetch, validateInstanceUrlWithDns } from '@repo/security'
import { isValidRasterBytes } from '@repo/storage'
import { drainOnCancel } from '#app/utils/drain-on-cancel.server.ts'
import {
	getSignedGetRequestInfoAsync,
	getSignedHeadRequestInfoAsync,
} from '#app/utils/storage.server.ts'
import { type Route } from './+types/images'

const MEDIA_SIGNING_SECRET =
	process.env.INTERNAL_COMMAND_TOKEN || process.env.SESSION_SECRET

if (!MEDIA_SIGNING_SECRET) {
	throw new Error(
		'INTERNAL_COMMAND_TOKEN or SESSION_SECRET is required for media URL signing.',
	)
}

export function signMediaId(mediaId: string, expiresAt: number): string {
	return createHmac('sha256', MEDIA_SIGNING_SECRET)
		.update(`media:${mediaId}:${expiresAt}`)
		.digest('hex')
}

function verifyMediaSignature(
	mediaId: string,
	signature: string | null,
	expiresAtValue: string | null,
): boolean {
	if (!signature || !expiresAtValue || !/^\d+$/u.test(expiresAtValue))
		return false
	const expiresAt = Number(expiresAtValue)
	if (
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= Math.floor(Date.now() / 1000)
	) {
		return false
	}
	const expected = createHmac('sha256', MEDIA_SIGNING_SECRET)
		.update(`media:${mediaId}:${expiresAt}`)
		.digest('hex')
	try {
		return (
			signature.length === expected.length &&
			timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
		)
	} catch {
		return false
	}
}

const ALLOWED_RASTER_MIME_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
])

const MAX_IMAGE_BYTES = 10 * 1024 * 1024 // 10MB

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
	cacheable: boolean,
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

	const responseHeaders = getImageResponseHeaders(cacheable && upstream.ok)
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

const PUBLIC_MEDIA_SOURCES = new Set([
	'organization-logo',
	'site-icon',
	'website-seo',
	'website-asset',
])

/** Platform-scoped assets and organization branding assets are public. */
function isPublicMediaAsset(asset: { storageScope: string; source: string }) {
	return (
		asset.storageScope === 'platform' || PUBLIC_MEDIA_SOURCES.has(asset.source)
	)
}

/**
 * Media that is not public (membership-authorized library assets, signed
 * capability URLs, direct object keys, stored videos, external images) must not
 * be stored by shared caches, otherwise a cached copy can be replayed without
 * re-running authorization or after the signature expired.
 */
function getImageResponseHeaders(cacheable: boolean) {
	const headers = new Headers()
	headers.set(
		'Cache-Control',
		cacheable ? 'public, max-age=31536000, immutable' : 'no-store',
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

	const upstream = await ssrfSafeFetch(sourceUrl, {
		signal: AbortSignal.timeout(10_000),
	})
	const rawContentType = upstream.headers.get('content-type')
	const mimeType = rawContentType?.split(';')[0]?.trim().toLowerCase()
	if (!mimeType || !ALLOWED_RASTER_MIME_TYPES.has(mimeType)) {
		throw new Response('Unsupported Media Type', { status: 415 })
	}

	const contentLength = upstream.headers.get('content-length')
	if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
		throw new Response('Payload Too Large', { status: 413 })
	}

	const arrayBuffer = await upstream.arrayBuffer()
	if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
		throw new Response('Payload Too Large', { status: 413 })
	}

	if (!isValidRasterBytes(arrayBuffer)) {
		throw new Response('Unsupported Media Type', { status: 415 })
	}

	const headers = getImageResponseHeaders(false)
	headers.set('Content-Type', mimeType)

	return new Response(arrayBuffer, {
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
		return ssrfSafeFetch(src, {
			signal: AbortSignal.timeout(10_000),
		})
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
	cacheable: boolean,
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
			headers: getImageResponseHeaders(false),
		})
	}

	if (isExternal) {
		const contentLength = upstream.headers.get('content-length')
		if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
			throw new Response('Payload Too Large', { status: 413 })
		}
		const arrayBuffer = await upstream.arrayBuffer()
		if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
			throw new Response('Payload Too Large', { status: 413 })
		}
		if (!isValidRasterBytes(arrayBuffer)) {
			throw new Response('Unsupported Media Type', { status: 415 })
		}
		const rawContentType = upstream.headers.get('content-type')
		const mimeType = rawContentType?.split(';')[0]?.trim().toLowerCase()
		if (!mimeType || !ALLOWED_RASTER_MIME_TYPES.has(mimeType)) {
			throw new Response('Unsupported Media Type', { status: 415 })
		}
		const headers = getImageResponseHeaders(false)
		headers.set('Content-Type', mimeType)
		return new Response(arrayBuffer, { headers, status: 200 })
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
			const headers = getImageResponseHeaders(cacheable && !isExternal)
			if (mimeType) headers.set('Content-Type', mimeType)
			return new Response(transformed.body, { headers, status: 200 })
		}
	}

	const rawContentType = upstream.headers.get('content-type')
	const mimeType = rawContentType?.split(';')[0]?.trim().toLowerCase()
	if (isExternal && (!mimeType || !ALLOWED_RASTER_MIME_TYPES.has(mimeType))) {
		throw new Response('Unsupported Media Type', { status: 415 })
	}
	const headers = getImageResponseHeaders(cacheable && !isExternal)
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

	const src = searchParams.get('src')
	let objectKey = searchParams.get('objectKey')
	let organizationId = searchParams.get('organizationId')
	const mediaId = searchParams.get('mediaId')
	// Only assets we can positively identify as public may be stored by shared
	// caches. Private media (membership-authorized or signed capability URLs),
	// direct object keys and external images are all non-cacheable.
	let cacheable = false

	if (mediaId) {
		invariantResponse(
			/^[a-zA-Z0-9_-]{16,64}$/.test(mediaId),
			'Invalid mediaId',
			{
				status: 400,
			},
		)
		const [asset] = await db
			.select({
				objectKey: OrganizationMediaAsset.objectKey,
				organizationId: OrganizationMediaAsset.organizationId,
				storageScope: OrganizationMediaAsset.storageScope,
				source: OrganizationMediaAsset.source,
			})
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.id, mediaId))
			.limit(1)
		invariantResponse(asset, 'Media not found', { status: 404 })

		const isPublicMedia = isPublicMediaAsset(asset)
		cacheable = isPublicMedia

		const sig = searchParams.get('sig')
		const hasValidSignature = verifyMediaSignature(
			mediaId,
			sig,
			searchParams.get('expires'),
		)

		if (!isPublicMedia && !hasValidSignature) {
			const userId = await getUserId(request)
			invariantResponse(userId, 'Unauthorized', { status: 401 })

			const [membership] = await db
				.select({ userId: UserOrganization.userId })
				.from(UserOrganization)
				.where(
					and(
						eq(UserOrganization.userId, userId),
						eq(UserOrganization.organizationId, asset.organizationId),
					),
				)
				.limit(1)
			invariantResponse(membership, 'Forbidden', { status: 403 })
		}

		objectKey = asset.objectKey
		organizationId =
			asset.storageScope === 'organization' ? asset.organizationId : null
	} else if (objectKey) {
		// A direct object key can point at private note or comment media, so it
		// is only cacheable when it is a registered public branding asset.
		const [asset] = await db
			.select({
				storageScope: OrganizationMediaAsset.storageScope,
				source: OrganizationMediaAsset.source,
			})
			.from(OrganizationMediaAsset)
			.where(eq(OrganizationMediaAsset.objectKey, objectKey))
			.limit(1)
		cacheable = asset ? isPublicMediaAsset(asset) : false
	} else if (src && !URL.canParse(src)) {
		// Local static assets served from `/public` or the client build.
		cacheable = true
	}

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
			return streamStoredVideo(request, objectKey, organizationId, cacheable)
		}
	}

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
			cacheable,
		)
	}

	const { getImgResponse } = await import('openimg/node')

	const isExternal = Boolean(
		!objectKey &&
		src &&
		URL.canParse(src) &&
		new URL(src).origin !== url.origin,
	)
	const headers = getImageResponseHeaders(cacheable && !isExternal)

	const imgResponse = await getImgResponse(request, {
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
				const validation = await validateInstanceUrlWithDns(src)
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

	if (!imgResponse.body) return imgResponse

	// openimg streams the transformed image through a Node `PassThrough`
	// (`Readable.toWeb`); draining on cancel keeps a client abort from killing
	// the server. See `drainOnCancel`.
	return new Response(drainOnCancel(imgResponse.body), {
		status: imgResponse.status,
		statusText: imgResponse.statusText,
		headers: imgResponse.headers,
	})
}
