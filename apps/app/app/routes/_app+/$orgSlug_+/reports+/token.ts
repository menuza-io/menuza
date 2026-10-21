import {
	createForbiddenResponse,
	isImpersonating,
	requireUserId,
	userHasOrganizationPermission,
} from '@repo/auth'
import {
	mintOperatorAnalyticsToken,
	ORDER_REPORT_SUBJECTS,
	ORG_WIDE_REPORT_SUBJECTS,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import { data } from 'react-router'
import { ENV } from 'varlock/env'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	intersectScopeIds,
	resolveReservationsReportAccess,
} from '#app/utils/reservations/report-access.server.ts'
import { resolveStaffReportAccess } from '#app/utils/staffing/report-access.server.ts'
import {
	hasAdminReportAccess,
	REPORT_ADMIN_PERMISSIONS,
} from '#app/utils/staffing/report-grants.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/token.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		dataRegion: true,
		hasProvisionedDb: true,
	})

	// Operator analytics token minting grants regional tenant database access.
	// Analytics, settings, or website admin permission opens the
	// organization-wide subjects (customers, text subscribers, shop orders).
	// Without any of them, only the restricted module subjects (staff,
	// Reservations) below can be granted, each by its own permission and limited
	// to the person's scopes or locations, so a manager holding only module
	// report grants still gets a token. A person with none gets a 403.
	const hasAdminAccess = await hasAdminReportAccess(userId, organization.id)
	// Call reports include caller numbers, so they also need call access.
	// Order reports follow the orders page, which menu access covers (and, as
	// before, only for people who can run reports at all).
	const [canReadPhoneCalls, canReadOrders] = await Promise.all([
		hasAdminAccess &&
			userHasOrganizationPermission(
				userId,
				organization.id,
				ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
			),
		hasAdminAccess &&
			userHasOrganizationPermission(
				userId,
				organization.id,
				ORG_PERMISSIONS.READ_MENU_ANY,
			),
	])
	// Staff reports (time cards, shifts, daily labor, applications) follow the
	// staffing flags, the staffing permissions, and the person's scope grants.
	const staff = await resolveStaffReportAccess({
		userId,
		organizationId: organization.id,
		impersonated: await isImpersonating(request),
	})
	// Bookings, waitlist and pacing reports need the reservation report grant
	// and the master Reservations flag, limited to the person's locations.
	const reservations = await resolveReservationsReportAccess({
		request,
		userId,
		organizationId: organization.id,
	})
	if (
		!hasAdminAccess &&
		staff.subjects.length === 0 &&
		reservations.subjects.length === 0
	) {
		throw createForbiddenResponse(REPORT_ADMIN_PERMISSIONS.join(' or '))
	}
	const scopeIds =
		staff.subjects.length > 0 && reservations.subjects.length > 0
			? intersectScopeIds(staff.scopeIds, reservations.scopeIds)
			: reservations.subjects.length > 0
				? reservations.scopeIds
				: staff.scopeIds
	const subjects: RestrictedReportSubject[] = [
		// A module-only grant never lists the organization-wide subjects.
		...(hasAdminAccess ? ORG_WIDE_REPORT_SUBJECTS : []),
		...(canReadPhoneCalls ? (['phone_calls'] as const) : []),
		...(canReadOrders ? ORDER_REPORT_SUBJECTS : []),
		...staff.subjects,
		...reservations.subjects,
	]

	const minted = await mintOperatorAnalyticsToken({
		internalCommandToken: ENV.INTERNAL_COMMAND_TOKEN || '',
		userId,
		orgId: organization.id,
		role: 'operator',
		subjects,
		scopeIds,
	})

	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)

	return data(
		{
			...minted,
			// Which regional subjects this person may run, so the screen can offer
			// only reports that will answer. tenant-api checks the token itself.
			subjects,
			tenantApiUrl,
			orgId: organization.id,
			hasProvisionedDb: organization.hasProvisionedDb,
		},
		// The token can unlock staff data and wages: never store or share it.
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
