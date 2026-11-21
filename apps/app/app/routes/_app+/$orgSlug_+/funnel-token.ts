import { data, type LoaderFunctionArgs } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { funnelEnabled } from '#app/utils/site-events/site-events.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'
import { loadPublicActionTargets } from '#app/utils/website/action-targets.server.ts'
import { hasExternalTarget } from '@repo/common/action-targets'

/**
 * Credentials for the browser-direct funnel read:
 * `GET /:orgSlug/funnel-token` (#179). Needs `read:website:any` and the
 * `website.funnel` flag (404 while it is off). The token is bound to the
 * `funnel` scope, so it cannot reach the Mailbox, customers or forms.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true },
	)
	// The funnel is behind `website.funnel`. Clicks that leave for another site
	// (#318) are counted whenever a button goes there, so their count is
	// readable then too, from the same endpoint.
	if (
		!(await funnelEnabled(organization.id)) &&
		!hasExternalTarget(await loadPublicActionTargets(organization.id))
	) {
		throw new Response('Not found', { status: 404 })
	}
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
		{ scope: 'funnel', expiresIn: '15m' },
	)
	return data(
		{ jwt, tenantApiUrl },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
