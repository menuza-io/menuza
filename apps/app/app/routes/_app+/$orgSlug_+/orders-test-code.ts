import { getFeatureFlag } from '@repo/common/feature-flags'
import { buildLink } from '@repo/common/links'
import {
	TEST_ORDER_FLAG,
	mintTestOrderCodeRequestSchema,
} from '@repo/common/test-orders'
import { data, type ActionFunctionArgs } from 'react-router'
import { orgSiteUrl } from '#app/utils/launch/launch.server.ts'
import { resolveLoyaltyLocationIds } from '#app/utils/loyalty/access.server.ts'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/**
 * `POST /:orgSlug/orders-test-code` (#119): opens a free test order. Needs the
 * orders write permission and the `launch.test_order` flag (404 while it is
 * off). The region mints one one-time code for one location the member
 * reaches; the answer is the website's menu with the code in the URL fragment,
 * so the code never reaches a server log. Nothing about an order passes here:
 * only the location id goes out and a link comes back.
 */
export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug || '',
		{ id: true, slug: true, customDomain: true },
	)
	if (
		(await getFeatureFlag(TEST_ORDER_FLAG, {
			organizationId: organization.id,
		})) !== true
	) {
		throw data({ error: 'Not found' }, { status: 404 })
	}
	const userId = await requireMenuWrite(request, organization.id)
	const parsed = mintTestOrderCodeRequestSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) {
		return data(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const { locationId } = parsed.data
	const locationIds = await resolveLoyaltyLocationIds(userId, organization.id)
	if (locationIds !== null && !locationIds.includes(locationId)) {
		return data(
			{ error: 'location_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	const { fetchTenant } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
		{ scope: 'orders:write', claims: { locationIds } },
	)
	let response: Response
	try {
		response = await fetchTenant('/operator/orders/test-code', {
			method: 'POST',
			body: JSON.stringify({ locationId }),
		})
	} catch {
		return data({ error: 'unavailable' }, { status: 503, headers: NO_STORE })
	}
	const body = (await response.json().catch(() => null)) as {
		code?: unknown
		expiresAt?: unknown
		error?: unknown
	} | null
	if (!response.ok || typeof body?.code !== 'string') {
		return data(
			{ error: typeof body?.error === 'string' ? body.error : 'unavailable' },
			{ status: response.ok ? 502 : response.status, headers: NO_STORE },
		)
	}
	// The registry's menu link; the one-time code rides in the fragment only.
	const menu = buildLink(
		'menu_home',
		{ location: locationId },
		{ origin: orgSiteUrl(organization) },
	)
	if (!menu) {
		return data({ error: 'unavailable' }, { status: 503, headers: NO_STORE })
	}
	return data(
		{
			url: `${menu}#test=${encodeURIComponent(body.code)}`,
			expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
		},
		{ headers: NO_STORE },
	)
}
