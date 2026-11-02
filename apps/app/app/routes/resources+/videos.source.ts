import { invariantResponse } from '@epic-web/invariant'
import {
	authorizeRegisteredObject,
	noteVideoOrganizationId,
} from '#app/utils/media-access.server.ts'
import {
	getSignedGetRequestInfoAsync,
	getSignedHeadRequestInfoAsync,
} from '#app/utils/storage.server.ts'
import { type Route } from './+types/videos.source.ts'

const SAFE_THUMBNAIL_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/avif',
])

const PASSTHROUGH_HEADERS = [
	'content-type',
	'content-length',
	'content-range',
	'accept-ranges',
	'etag',
	'last-modified',
] as const

function validateObjectKey(objectKey: string | null) {
	invariantResponse(objectKey, 'objectKey query parameter is required', {
		status: 400,
	})
	invariantResponse(
		objectKey.length >= 16 &&
			!objectKey.includes('..') &&
			/^[a-zA-Z0-9_\-./]+$/.test(objectKey),
		'Invalid or low-entropy objectKey parameter',
		{ status: 400 },
	)
	return objectKey
}

export async function loader({ request }: Route.LoaderArgs) {
	const url = new URL(request.url)
	const objectKey = validateObjectKey(url.searchParams.get('objectKey'))
	// Registered library assets: public ones are open (site visitors, media
	// transforms), private ones need active organization membership. The storage
	// scope comes from the registered asset, never the query. Note videos are
	// not registered; they are matched by the key contract (see
	// noteVideoOrganizationId). Anything else is not served.
	const registered = await authorizeRegisteredObject(request, objectKey)
	const noteOrganizationId = registered
		? null
		: noteVideoOrganizationId(objectKey)
	invariantResponse(registered || noteOrganizationId, 'Not found', {
		status: 404,
	})
	const access = registered ?? {
		isPublic: false,
		organizationId: noteOrganizationId,
	}
	const organizationId = access.organizationId ?? undefined
	const method = request.method === 'HEAD' ? 'HEAD' : 'GET'

	const { url: storageUrl, headers: signedHeaders } =
		method === 'HEAD'
			? await getSignedHeadRequestInfoAsync(objectKey, organizationId)
			: await getSignedGetRequestInfoAsync(objectKey, organizationId)

	const upstreamHeaders = new Headers(signedHeaders)
	const range = request.headers.get('Range')
	if (range) {
		upstreamHeaders.set('Range', range)
	}

	const upstream = await fetch(storageUrl, {
		method,
		headers: upstreamHeaders,
	})

	// The stored Content-Type is whatever the uploader declared, and this
	// response is served from the app origin: only video (and the raster
	// thumbnails kept beside videos) may pass through, never HTML or SVG.
	if (upstream.ok) {
		const mimeType = upstream.headers
			.get('content-type')
			?.split(';')[0]
			?.trim()
			.toLowerCase()
		if (
			!mimeType ||
			!(mimeType.startsWith('video/') || SAFE_THUMBNAIL_TYPES.has(mimeType))
		) {
			await upstream.body?.cancel()
			throw new Response('Unsupported Media Type', { status: 415 })
		}
	}

	const responseHeaders = new Headers()
	for (const headerName of PASSTHROUGH_HEADERS) {
		const value = upstream.headers.get(headerName)
		if (value) {
			responseHeaders.set(headerName, value)
		}
	}
	responseHeaders.set('Accept-Ranges', 'bytes')
	responseHeaders.set(
		'Cache-Control',
		access.isPublic ? 'public, max-age=3600' : 'private, max-age=3600',
	)
	responseHeaders.set('X-Content-Type-Options', 'nosniff')
	responseHeaders.set('Content-Security-Policy', "default-src 'none'; sandbox")
	responseHeaders.set('Access-Control-Allow-Origin', '*')

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
