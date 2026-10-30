import { isImpersonating } from '@repo/auth'
import {
	LOYALTY_PERMISSIONS as P,
	loyaltyScopeSchema,
	type LoyaltyPermission,
	type LoyaltyScope,
} from '@repo/loyalty'
import { data, type LoaderFunctionArgs } from 'react-router'
import { requireLoyaltyAccess } from '#app/utils/loyalty/access.server.ts'
import { mintLoyaltyToken } from '#app/utils/loyalty/token.server.ts'

const SCOPE_REQUIREMENTS: Record<
	LoyaltyScope,
	{ anyOf: readonly LoyaltyPermission[] }
> = {
	read: {
		anyOf: [
			P.READ_LOYALTY,
			P.UPDATE_LOYALTY_PROGRAM,
			P.UPDATE_LOYALTY_POINTS,
			P.UPDATE_LOYALTY_REDEMPTION,
		],
	},
	setup: {
		anyOf: [P.UPDATE_LOYALTY_PROGRAM, P.READ_LOYALTY],
	},
	members: {
		anyOf: [P.READ_LOYALTY, P.UPDATE_LOYALTY_POINTS],
	},
	reconcile: {
		anyOf: [P.UPDATE_LOYALTY_REDEMPTION],
	},
	reports: {
		anyOf: [P.READ_LOYALTY_REPORT],
	},
}

/**
 * Credentials for browser-direct loyalty calls:
 * `GET /:orgSlug/loyalty/token?scope=<read|setup|members|reconcile|reports>`
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const rawScope = new URL(request.url).searchParams.get('scope') ?? 'read'
	const parsedScope = loyaltyScopeSchema.safeParse(rawScope)
	if (!parsedScope.success) {
		throw data({ error: 'Unknown loyalty scope' }, { status: 400 })
	}
	const scope = parsedScope.data
	const requirement = SCOPE_REQUIREMENTS[scope]

	const access = await requireLoyaltyAccess(request, params.orgSlug, {
		anyOf: requirement.anyOf,
	})
	const impersonated = await isImpersonating(request)
	const minted = await mintLoyaltyToken({
		organizationId: access.organizationId,
		userId: access.userId,
		dataRegion: access.dataRegion,
		scope,
		grants: access.grants,
		locationIds: access.locationIds,
		features: access.features,
		impersonated,
	})

	return data(
		{
			jwt: minted.jwt,
			tenantApiUrl: minted.tenantApiUrl,
			scope: minted.scope,
			grants: minted.grants,
			locationIds: minted.locationIds,
			features: minted.features,
			expiresAt: minted.expiresAt,
		},
		{
			headers: {
				'Cache-Control': 'private, no-store',
			},
		},
	)
}
