import { asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import {
	DEFAULT_INVENTORY_LOCATION_ID,
	INVENTORY_PERMISSIONS as P,
	inventoryScopeSchema,
	type InventoryPermission,
	type InventoryScope,
} from '@repo/inventory'
import { data } from 'react-router'
import { z } from 'zod'
import { requireInventoryAccessForUser } from '#app/utils/inventory/access.server.ts'
import { mintInventoryToken } from '#app/utils/inventory/token.server.ts'
import { isAuthenticationError, requireAuth } from '#app/utils/jwt.server.ts'
import {
	checkRateLimit,
	MENU_MUTATION_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { type Route } from './+types/inventory.token.ts'

/**
 * Credentials for the operator phone app's inventory screens (#516):
 * `GET /api/inventory/token?organizationId=&scope=<read|write>` with the mobile
 * bearer login. It is the phone's version of
 * `/:orgSlug/inventory-token` and answers the same short-lived `inv+jwt`, so the
 * phone then calls the regional node directly: stock, counts, deliveries and
 * orders never pass through this server. Everything is checked per request:
 * the member must be in the organization, the module must be on, and the grants
 * and location scope are the member's own (the same rules as the web screens).
 * Besides the token it names the member's locations (id and name) for the
 * phone's location switcher.
 */

const Query = z.object({
	organizationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
	scope: inventoryScopeSchema.default('read'),
})

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

function failure(status: number, error: string, message: string) {
	return data(
		{ success: false, error, message },
		{ status, headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export async function loader({ request }: Route.LoaderArgs) {
	let userId: string
	try {
		userId = (await requireAuth(request)).sub
	} catch (error) {
		if (isAuthenticationError(error)) {
			return failure(401, 'unauthorized', 'Authentication required')
		}
		throw error
	}
	const limit = await checkRateLimit(
		{ type: 'user', value: userId },
		{
			...MENU_MUTATION_RATE_LIMIT,
			scope: 'mobile-inventory-token',
			maxRequests: 240,
		},
	)
	if (!limit.allowed) {
		return data(
			{
				success: false,
				error: 'rate_limited',
				message: 'Too many requests. Try again shortly.',
			},
			{
				status: 429,
				headers: {
					'Retry-After': String(
						Math.max(
							1,
							Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000),
						),
					),
				},
			},
		)
	}
	const parsed = Query.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return failure(400, 'validation_error', 'Invalid request')
	}
	const { organizationId, scope } = parsed.data

	let access
	try {
		access = await requireInventoryAccessForUser(userId, organizationId, {
			anyOf: SCOPE_REQUIREMENTS[scope],
		})
	} catch (error) {
		// Not a member, module off: the same 404 (nothing leaks). No permission: 403.
		if (error instanceof Response) {
			return error.status === 403
				? failure(403, 'forbidden', 'You do not have access to inventory')
				: failure(404, 'not_found', 'Inventory is not available')
		}
		throw error
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
		canManageSettings: access.canManageSettings,
		isOwner: access.isOwner,
	})

	const rows = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, access.organizationId))
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.createdAt),
		)
	// An organization without locations keeps its stock at the implicit one.
	const locations =
		rows.length === 0
			? [{ id: DEFAULT_INVENTORY_LOCATION_ID, name: access.organizationName }]
			: access.locationIds === null
				? rows
				: rows.filter((row) => access.locationIds!.includes(row.id))

	return data(
		{
			success: true,
			data: {
				jwt: minted.jwt,
				tenantApiUrl: minted.tenantApiUrl,
				scope: minted.scope,
				grants: minted.grants,
				features: minted.features,
				expiresAt: minted.expiresAt,
				organizationId: access.organizationId,
				currency: access.currency,
				canManageSettings: access.canManageSettings,
				locations,
			},
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}
