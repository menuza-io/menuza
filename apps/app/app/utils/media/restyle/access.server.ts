import { requireUserId } from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	isMediaFlagOn,
	isMediaRestyleKillSwitchOn,
	MEDIA_FLAG_KEYS,
} from '../media-flags.ts'

export { isMediaRestyleKillSwitchOn }

export async function mediaRestyleEnabled(organizationId: string) {
	return isMediaFlagOn(
		await getFeatureFlag(MEDIA_FLAG_KEYS.restyle, { organizationId }),
	)
}

/** What the person is about to do: look, start or retry, or change a dish. */
export type MediaRestyleAccessKind = 'view' | 'start' | 'apply'

/**
 * Media, Restyle menu (#146): a member of the organization, 404 while
 * `media.restyle` is off, and a permission that grows with what they do.
 *
 * - `view` (runs and drafts): `update:media:any`.
 * - `start` (a run, a retry; each spends model credits): also
 *   `create:media_studio:any`.
 * - `apply` (use, use all, switch back; each changes a dish): also
 *   `update:menu:any`.
 *
 * Every restyle loader and action calls it first. The kill switch is not
 * checked here: reviewing drafts keeps working while it is on.
 */
export async function requireMediaRestyleAccess(
	request: Request,
	orgSlug: string | undefined,
	kind: MediaRestyleAccessKind,
) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
	})
	if (!(await mediaRestyleEnabled(organization.id))) {
		throw new Response('Not Found', { status: 404 })
	}
	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_MEDIA_ANY,
	)
	if (kind === 'start') {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.CREATE_MEDIA_STUDIO_ANY,
		)
	}
	if (kind === 'apply') {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.UPDATE_MENU_ANY,
		)
	}
	return { organization, userId }
}
