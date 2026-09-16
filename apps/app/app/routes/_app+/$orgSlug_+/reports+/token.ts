import { requireUserId } from '@repo/auth'
import { mintOperatorAnalyticsToken } from '@repo/reports/token'
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

	const minted = await mintOperatorAnalyticsToken({
		internalCommandToken: ENV.INTERNAL_COMMAND_TOKEN || '',
		userId,
		orgId: organization.id,
		role: 'operator',
	})

	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)

	return data({
		...minted,
		tenantApiUrl,
		orgId: organization.id,
		hasProvisionedDb: organization.hasProvisionedDb,
	})
}
