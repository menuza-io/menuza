import { isImpersonating, requireUserId } from '@repo/auth'
import { data, type LoaderFunctionArgs } from 'react-router'
import {
	mintGuestPhotosToken,
	requireMenuGuestPhotosAccess,
} from '#app/utils/menu/guest-photos.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

/**
 * Mints a short-lived `pho+jwt` token for browser-direct calls to the
 * regional tenant-api `/operator/photos/*` moderation endpoints (#148).
 * Requires `update:guest_photo:any` and `menu.guest_photos` (non-KSA only).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
	})
	await requireMenuGuestPhotosAccess(request, organization)
	const impersonated = await isImpersonating(request)
	const minted = await mintGuestPhotosToken({
		organizationId: organization.id,
		userId,
		dataRegion: organization.dataRegion,
		impersonated,
	})
	return data(minted, {
		headers: { 'Cache-Control': 'private, no-store' },
	})
}
