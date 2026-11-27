import { createForbiddenResponse, requireUserId } from '@repo/auth'
import {
	mintOperatorAnalyticsToken,
	resolveOperatorAnalyticsSecret,
} from '@repo/reports/token'
import { isInsecureSecret, isProductionLike } from '@repo/security'
import { data } from 'react-router'
import { ENV } from 'varlock/env'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { resolveReportTokenGrants } from '#app/utils/reports/token-grants.server.ts'
import { REPORT_ADMIN_PERMISSIONS } from '#app/utils/staffing/report-grants.server.ts'
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
	// Reservations) can be granted, each by its own permission and limited to
	// the person's scopes or locations, so a manager holding only module report
	// grants still gets a token. A person with none gets a 403.
	const { hasAnyGrant, subjects, scopeIds, locationIds } =
		await resolveReportTokenGrants({
			request,
			userId,
			organizationId: organization.id,
		})
	if (!hasAnyGrant) {
		throw createForbiddenResponse(REPORT_ADMIN_PERMISSIONS.join(' or '))
	}

	// A production build on localhost (E2E, build + preview) may keep the schema
	// default; a real deploy may not. tenant-api applies its own rule (it has no
	// BASE_URL, and an unset NODE_ENV counts as production there), so a
	// production-mode tenant-api still answers 401 to a token signed with the
	// default. Real deploys refuse the default on both sides.
	const signingSecret = resolveOperatorAnalyticsSecret({
		secret: ENV.OPERATOR_ANALYTICS_TOKEN,
		internalCommandToken: ENV.INTERNAL_COMMAND_TOKEN,
		isPlaceholder: isInsecureSecret,
		placeholderAllowed: !isProductionLike(),
	})
	if (!signingSecret) {
		console.error('operator_analytics_token_not_configured')
		throw data(
			{ error: 'Reports are temporarily unavailable' },
			{ status: 503 },
		)
	}
	const minted = await mintOperatorAnalyticsToken({
		signingSecret,
		userId,
		orgId: organization.id,
		role: 'operator',
		subjects,
		scopeIds,
		...(locationIds !== undefined ? { locationIds } : {}),
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
