import { invariantResponse } from '@epic-web/invariant'
import {
	noteVideoOrganizationId,
	requireOrganizationMember,
} from '#app/utils/media-access.server.ts'
import { signMediaId } from '#app/utils/media-signing.server.ts'
import { type Route } from './+types/videos.ticket.ts'

const TICKET_TTL_SECONDS = 60 * 60

/**
 * Mints a short-lived signature for a note video. Media transforms fetch the
 * source URL without the viewer's cookie, so membership alone cannot gate it.
 */
export async function loader({ request }: Route.LoaderArgs) {
	const objectKey = new URL(request.url).searchParams.get('objectKey')
	const organizationId = objectKey ? noteVideoOrganizationId(objectKey) : null
	invariantResponse(objectKey && organizationId, 'Not found', { status: 404 })
	invariantResponse(
		objectKey.length >= 16 &&
			!objectKey.includes('..') &&
			/^[a-zA-Z0-9_\-./]+$/.test(objectKey),
		'Invalid objectKey',
		{ status: 400 },
	)
	await requireOrganizationMember(request, organizationId)
	const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS
	return Response.json({
		sig: signMediaId(objectKey, expiresAt),
		expires: String(expiresAt),
	})
}
