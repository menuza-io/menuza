import { data, type LoaderFunctionArgs } from 'react-router'
import { requirePeopleAccess } from '#app/utils/people/people-access.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

/**
 * Credentials for browser-direct calls to tenant-api `/operator/people`. One
 * token carries the claims for both facets (customers and reservation dining),
 * so the regional API decides field by field. People data never transits the
 * App; the claims are signed here and cannot be widened by the browser.
 * The token lives 5 minutes when it includes the guest read grant.
 * `locationIds` is the member's location scope (null: every location), the
 * same claim the orders token carries; the region uses it for the summary
 * counts and the tile filters only. `canUpdateMarketingConsent` is signed
 * only when granted (never while impersonating) and lets the browser record a
 * guest's marketing consent at `/operator/people/:key/consent`.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const { access, locationIds } = await requirePeopleAccess(request, orgSlug)
	const expiresIn = access.dining === 'full' ? '5m' : '15m'
	const { jwt, tenantApiUrl } = await getOperatorTenantClient(
		request,
		orgSlug,
		{
			scope: 'people',
			canUpdate: access.canUpdateCustomers,
			canDelete: access.canDelete,
			expiresIn,
			claims: {
				peopleCustomers: access.customers,
				...(access.dining === 'none' ? {} : { peopleDining: access.dining }),
				...(access.canUpdateDining ? { canUpdateGuest: true } : {}),
				...(access.canUpdateMarketingConsent
					? { canUpdateMarketingConsent: true }
					: {}),
				locationIds,
			},
		},
	)
	return data(
		{
			jwt,
			tenantApiUrl,
			expiresAt: Date.now() + (expiresIn === '5m' ? 5 : 15) * 60_000,
			access,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
