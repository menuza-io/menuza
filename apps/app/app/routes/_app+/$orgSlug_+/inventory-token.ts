import {
	INVENTORY_PERMISSIONS as P,
	inventoryScopeSchema,
	type InventoryPermission,
	type InventoryScope,
} from '@repo/inventory'
import { data, type LoaderFunctionArgs } from 'react-router'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import { mintInventoryToken } from '#app/utils/inventory/token.server.ts'

const SCOPE_REQUIREMENTS: Record<
	InventoryScope,
	readonly InventoryPermission[]
> = {
	read: [P.READ_INVENTORY],
	write: [
		P.UPDATE_INVENTORY,
		P.UPDATE_INVENTORY_PURCHASING,
		P.UPDATE_INVENTORY_RECIPE,
	],
}

/**
 * Credentials for browser-direct inventory calls:
 * `GET /:orgSlug/inventory-token?scope=<read|write>`. Support impersonation
 * gets read grants only and a shorter token.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const rawScope = new URL(request.url).searchParams.get('scope') ?? 'read'
	const parsedScope = inventoryScopeSchema.safeParse(rawScope)
	const scope: InventoryScope = parsedScope.success ? parsedScope.data : 'read'

	const access = await requireInventoryAccess(request, params.orgSlug, {
		anyOf: SCOPE_REQUIREMENTS[scope],
	})
	if (!parsedScope.success) {
		throw data({ error: 'Unknown inventory scope' }, { status: 400 })
	}
	const minted = await mintInventoryToken({
		organizationId: access.organizationId,
		userId: access.userId,
		dataRegion: access.dataRegion,
		scope,
		grants: access.grants,
		locationIds: access.locationIds,
		features: access.features,
		impersonated: access.impersonated,
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
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
