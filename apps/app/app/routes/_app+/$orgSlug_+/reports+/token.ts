import {
	isImpersonating,
	requireUserId,
	userHasOrganizationPermission,
} from '@repo/auth'
import {
	mintOperatorAnalyticsToken,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import { data } from 'react-router'
import { ENV } from 'varlock/env'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireAnyUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { resolveStaffReportAccess } from '#app/utils/staffing/report-access.server.ts'
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
	// Require analytics, settings, or website admin permission.
	await requireAnyUserWithOrganizationPermission(request, organization.id, [
		ORG_PERMISSIONS.READ_ANALYTICS_ANY,
		ORG_PERMISSIONS.READ_SETTINGS_ANY,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	])
	// Call reports include caller numbers, so they also need call access.
	const canReadPhoneCalls = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
	)
	// Staff reports (time cards, shifts, daily labor, applications) follow the
	// staffing flags, the staffing permissions, and the person's scope grants.
	const staff = await resolveStaffReportAccess({
		userId,
		organizationId: organization.id,
		impersonated: await isImpersonating(request),
	})
	const subjects: RestrictedReportSubject[] = [
		...(canReadPhoneCalls ? (['phone_calls'] as const) : []),
		...staff.subjects,
	]

	const minted = await mintOperatorAnalyticsToken({
		internalCommandToken: ENV.INTERNAL_COMMAND_TOKEN || '',
		userId,
		orgId: organization.id,
		role: 'operator',
		subjects,
		scopeIds: staff.scopeIds,
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
