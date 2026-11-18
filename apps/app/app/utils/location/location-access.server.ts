import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	partitionByScope,
	resolveMemberLocationIds,
} from './member-scope.server.ts'

export type LocationManager = {
	userId: string
	organization: {
		id: string
		slug: string
		dataRegion: string
		hasProvisionedDb: boolean
	}
	/** Locations the person may manage: `null` is every location, `[]` none. */
	scope: string[] | null
}

/**
 * Settings-level access to the multi-location tools: signed in, a member of the
 * organization, `update:settings:any`, and the person's location scope loaded
 * so the caller can refuse or skip locations outside it on the server. Throws
 * 401, 403 or 404 as the other settings routes do.
 */
export async function requireLocationManager(
	request: Request,
	orgSlug: string | undefined,
): Promise<LocationManager> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		hasProvisionedDb: true,
	})
	const userId = await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const scope = await resolveMemberLocationIds(userId, organization.id)
	return {
		userId,
		organization: {
			id: organization.id,
			slug: organization.slug,
			dataRegion: organization.dataRegion || 'us',
			hasProvisionedDb: organization.hasProvisionedDb,
		},
		scope,
	}
}

/**
 * Head-office access: the same, and the person's location scope must be every
 * location. Tags and chain defaults decide who sees and changes what, so a
 * person limited to some locations never manages them: a scoped manager who
 * could tag a new location with their own tag would widen their own access.
 */
export async function requireHeadOffice(
	request: Request,
	orgSlug: string | undefined,
): Promise<LocationManager> {
	const manager = await requireLocationManager(request, orgSlug)
	if (manager.scope !== null) {
		throw new Response('Forbidden', { status: 403 })
	}
	return manager
}

export { partitionByScope }
