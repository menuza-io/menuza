import { isImpersonating } from '@repo/auth'
import { data, type LoaderFunctionArgs } from 'react-router'
import { requireDiscountsAccess } from '#app/utils/discounts/access.server.ts'
import { mintDiscountToken } from '#app/utils/discounts/token.server.ts'

/**
 * Credentials for the browser-direct usage call:
 * `GET /:orgSlug/discounts-token`. Needs `read:discount:any` (or update).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireDiscountsAccess(request, params.orgSlug)
	const minted = await mintDiscountToken({
		organizationId: access.organization.id,
		userId: access.userId,
		dataRegion: access.organization.dataRegion,
		held: [
			'read:discount:any',
			...(access.canWrite ? ['update:discount:any'] : []),
		],
		locationIds: access.locationIds,
		impersonated: await isImpersonating(request),
	})
	return data(
		{
			jwt: minted.jwt,
			tenantApiUrl: minted.tenantApiUrl,
			scope: minted.scope,
			expiresAt: minted.expiresAt,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
