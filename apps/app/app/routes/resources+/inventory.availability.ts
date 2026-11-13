import {
	and,
	count,
	db,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import {
	DEFAULT_INVENTORY_LOCATION_ID,
	inventoryAvailabilityRequestSchema,
	type InventoryAvailabilityResult,
	inventoryAvailabilityResultSchema,
} from '@repo/inventory'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getInventoryFeatureState } from '#app/utils/inventory/access.server.ts'
import { applyMenuAvailability } from '#app/utils/menu/location-availability.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function answer(result: InventoryAvailabilityResult) {
	return Response.json(inventoryAvailabilityResultSchema.parse(result), {
		headers: NO_STORE,
	})
}

/**
 * `POST /resources/inventory/availability`: where the regional inventory
 * service takes dishes and options off the menu because an ingredient ran out
 * ("auto sold out"), and gives them back.
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only; the request is ids and a
 * boolean (the contract's strict `inventoryAvailabilityRequestSchema`).
 *
 * - It can only turn a dish or option `unavailable` when it is available now,
 *   and only put back one that is `unavailable` and that nobody changed by
 *   hand since the region took it off (`since`). A dish taken off by hand is
 *   never overruled in either direction.
 * - With locations the change is the location's override (the entity's own
 *   availability is untouched); an organization without locations changes the
 *   entity itself.
 * - Taking something off needs `inventory.enabled` and `inventory.recipes`;
 *   giving back always works, so switching inventory off cannot strand a dish.
 * - The answer lists the entity ids that were really changed, so the region
 *   records only those. Everything changed purges the site cache, which
 *   reaches Sites and QR at once and Station at its next menu refresh.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const raw = await request.json().catch(() => null)
	const parsed = inventoryAvailabilityRequestSchema.safeParse(raw)
	if (!parsed.success) {
		return Response.json(
			{
				error: 'invalid_request',
				issues: parsed.error.issues.slice(0, 10).map((issue) => ({
					path: issue.path.join('.'),
					code: issue.code,
				})),
			},
			{ status: 400, headers: NO_STORE },
		)
	}
	const input = parsed.data

	const organization = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, input.orgId),
			eq(Organization.active, true),
			eq(Organization.hasProvisionedDb, true),
		),
		columns: { id: true, slug: true },
	})
	if (!organization) {
		return Response.json(
			{ error: 'org_not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}

	const features = await getInventoryFeatureState(organization.id)
	const mayTakeOff = features.enabled && features.recipes

	const [{ value: locationCount } = { value: 0 }] = await db
		.select({ value: count() })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
	const implicit = locationCount === 0
	if (implicit) {
		if (input.locationId !== DEFAULT_INVENTORY_LOCATION_ID) {
			return answer({ applied: [], skipped: 'unknown_location' })
		}
	} else {
		const location = await db.query.OrganizationLocation.findFirst({
			where: and(
				eq(OrganizationLocation.id, input.locationId),
				eq(OrganizationLocation.organizationId, organization.id),
			),
			columns: { id: true },
		})
		if (!location) return answer({ applied: [], skipped: 'unknown_location' })
	}

	const applied: string[] = []
	for (const change of input.changes) {
		if (!change.available && !mayTakeOff) continue
		const done = await applyMenuAvailability({
			organizationId: organization.id,
			locationId: implicit ? null : input.locationId,
			change,
			by: 'stock',
		})
		if (done) applied.push(change.entityId)
	}
	if (applied.length > 0) {
		await purgeOrganizationSiteCache(organization.id, organization.slug)
	}
	return answer({ applied })
}
