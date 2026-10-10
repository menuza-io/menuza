import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import {
	mintOperatorAnalyticsToken,
	ORDER_REPORT_SUBJECTS,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import { data } from 'react-router'
import { ENV } from 'varlock/env'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireAnyUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
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
	// Order reports follow the orders page, which menu access covers.
	const [canReadPhoneCalls, canReadOrders] = await Promise.all([
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
		),
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.READ_MENU_ANY,
		),
	])
	const subjects: RestrictedReportSubject[] = [
		...(canReadPhoneCalls ? (['phone_calls'] as const) : []),
		...(canReadOrders ? ORDER_REPORT_SUBJECTS : []),
	]

	const minted = await mintOperatorAnalyticsToken({
		internalCommandToken: ENV.INTERNAL_COMMAND_TOKEN || '',
		userId,
		orgId: organization.id,
		role: 'operator',
		subjects,
	})

	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)

	return data({
		...minted,
		tenantApiUrl,
		orgId: organization.id,
		hasProvisionedDb: organization.hasProvisionedDb,
	})
}
