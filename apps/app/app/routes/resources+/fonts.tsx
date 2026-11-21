import { invariantResponse } from '@epic-web/invariant'
import { siteFontFormatFromExtension } from '@repo/common/site-fonts'
import { and, db, eq, FontLicenceAcceptance, isNotNull } from '@repo/database'
import { type LoaderFunctionArgs } from 'react-router'
import { getSignedGetRequestInfoAsync } from '#app/utils/storage.server.ts'

const CONTENT_TYPE_BY_FORMAT = {
	woff2: 'font/woff2',
	woff: 'font/woff',
	truetype: 'font/ttf',
	opentype: 'font/otf',
} as const

export async function loader({ request }: LoaderFunctionArgs) {
	const objectKey = new URL(request.url).searchParams.get('objectKey')
	invariantResponse(objectKey, 'objectKey query parameter is required', {
		status: 400,
	})
	if (
		objectKey.length < 16 ||
		objectKey.includes('..') ||
		!/^org\/[a-zA-Z0-9_-]+\/site-fonts\//.test(objectKey)
	) {
		invariantResponse(false, 'Invalid objectKey parameter', { status: 400 })
	}

	const format = siteFontFormatFromExtension(objectKey)
	invariantResponse(format, 'Unsupported font file', { status: 400 })

	// A font taken off a site because of a licence complaint is no longer served.
	const [removed] = await db
		.select({ id: FontLicenceAcceptance.id })
		.from(FontLicenceAcceptance)
		.where(
			and(
				eq(FontLicenceAcceptance.objectKey, objectKey),
				isNotNull(FontLicenceAcceptance.removedAt),
			),
		)
		.limit(1)
	invariantResponse(!removed, 'Font removed', { status: 410 })

	const { url, headers: signedHeaders } =
		await getSignedGetRequestInfoAsync(objectKey)
	const upstream = await fetch(url, { headers: signedHeaders })
	if (!upstream.ok || !upstream.body) {
		invariantResponse(false, 'Font not found', { status: 404 })
	}

	return new Response(upstream.body, {
		headers: {
			'Content-Type': CONTENT_TYPE_BY_FORMAT[format],
			'Cache-Control': 'public, max-age=31536000, immutable',
			'Access-Control-Allow-Origin': '*',
			'Cross-Origin-Resource-Policy': 'cross-origin',
		},
	})
}
