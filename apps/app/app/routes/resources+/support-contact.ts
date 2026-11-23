import { requireUserId } from '@repo/auth'
import { type LoaderFunctionArgs } from 'react-router'
import {
	loadSupportContact,
	resolveSupportOrganization,
} from '#app/utils/support.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `GET /resources/support-contact?orgSlug=`: "Your Menuza contact: Sara" in the
 * Help menu (#272). The answer is the first name and a photo key, nothing
 * else, and only for a member of that restaurant.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const url = new URL(request.url)
	const orgSlug = url.searchParams.get('orgSlug') ?? ''
	const organization = orgSlug
		? await resolveSupportOrganization(userId, orgSlug)
		: null
	if (!organization) {
		return Response.json({ contact: null }, { status: 404, headers: NO_STORE })
	}
	const locationId = url.searchParams.get('locationId')
	const contact = await loadSupportContact(organization.id, locationId)
	return Response.json({ contact }, { headers: NO_STORE })
}
