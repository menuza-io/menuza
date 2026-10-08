import { userHasOrganizationPermission } from '@repo/auth'
import { data, type LoaderFunctionArgs } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireAnyUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { loadCallsViewData } from '#app/utils/phone-agent/calls-view.server.ts'

/**
 * The mailbox opens for anyone who can read at least one of its sources.
 * Forms and reviews need website access; calls need phone call access and are
 * only available where the phone agent runs (US data region).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true, dataRegion: true },
	)
	const orgId = organization.id
	const userId = await requireAnyUserWithOrganizationPermission(
		request,
		orgId,
		[ORG_PERMISSIONS.READ_WEBSITE_ANY, ORG_PERMISSIONS.READ_PHONE_CALL_ANY],
	)
	const [canReadWebsite, canReadCalls] = await Promise.all([
		userHasOrganizationPermission(
			userId,
			orgId,
			ORG_PERMISSIONS.READ_WEBSITE_ANY,
		),
		userHasOrganizationPermission(
			userId,
			orgId,
			ORG_PERMISSIONS.READ_PHONE_CALL_ANY,
		),
	])
	const callsAvailable =
		canReadCalls && (organization.dataRegion ?? 'us') === 'us'
	return data(
		{
			canReadWebsite,
			calls: callsAvailable ? await loadCallsViewData(request, orgId) : null,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
