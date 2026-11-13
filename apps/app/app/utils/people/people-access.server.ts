import {
	isImpersonating,
	userHasOrganizationPermission,
	requireUserId,
} from '@repo/auth'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	getReservationsFeatureState,
	getUserReservationsGrants,
	resolveReservationsLocationIds,
	getReservationsNavAccess,
} from '#app/utils/reservations/access.server.ts'
import {
	computePeopleAccess,
	hasPeopleAccess,
	type PeopleAccess,
} from './people-access.ts'

export type PeopleContext = {
	organizationId: string
	userId: string
	access: PeopleAccess
	/**
	 * The member's location scope (`UserOrganization.locationScope`): null is
	 * every location, `[]` none. Signed into the people token as `locationIds`
	 * so the regional summary counts and tile filters follow it.
	 */
	locationIds: string[] | null
	/** Reservations are on and the member may create bookings. */
	canBook: boolean
	reservationsEnabled: boolean
}

/** Resolves what the member may do with people data; 403 when nothing. */
export async function requirePeopleAccess(
	request: Request,
	orgSlug: string,
): Promise<PeopleContext> {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
	})
	const userId = await requireUserId(request)
	const organizationId = organization.id
	const [
		canReadSettings,
		canUpdateSettings,
		canUpdateMarketingConsent,
		features,
		grants,
		locationIds,
	] = await Promise.all([
		userHasOrganizationPermission(
			userId,
			organizationId,
			ORG_PERMISSIONS.READ_SETTINGS_ANY,
		),
		userHasOrganizationPermission(
			userId,
			organizationId,
			ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
		),
		userHasOrganizationPermission(
			userId,
			organizationId,
			ORG_PERMISSIONS.UPDATE_MARKETING_CONSENT_ANY,
		),
		getReservationsFeatureState(organizationId),
		getUserReservationsGrants(userId, organizationId),
		resolveReservationsLocationIds(userId, organizationId),
	])
	const reservationsEnabled =
		features.enabled && !(locationIds !== null && locationIds.length === 0)
	const impersonated = await isImpersonating(request)
	const access = computePeopleAccess({
		canReadSettings,
		canUpdateSettings,
		canUpdateMarketingConsent,
		reservationsEnabled,
		grants,
		impersonated,
	})
	if (!hasPeopleAccess(access)) {
		throw new Response(
			'Forbidden: requires read:settings:any or read:reservation_guest:any',
			{
				status: 403,
			},
		)
	}
	const nav = reservationsEnabled
		? await getReservationsNavAccess(userId, organizationId)
		: null
	return {
		organizationId,
		userId,
		access,
		locationIds,
		canBook: Boolean(nav?.book),
		reservationsEnabled,
	}
}
