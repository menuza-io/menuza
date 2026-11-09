import {
	and,
	count,
	db,
	eq,
	Organization,
	OrganizationLocation,
	OrganizationMenuItem,
	OrganizationMenuLocationOverride,
	OrganizationMenuOption,
} from '@repo/database'
import {
	DEFAULT_INVENTORY_LOCATION_ID,
	type InventoryAvailabilityRequest,
	inventoryAvailabilityRequestSchema,
	type InventoryAvailabilityResult,
	inventoryAvailabilityResultSchema,
} from '@repo/inventory'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getInventoryFeatureState } from '#app/utils/inventory/access.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** A change the App made by hand within this long of the region's own is still the region's. */
export const AVAILABILITY_RESTORE_GRACE_MS = 60_000

function answer(result: InventoryAvailabilityResult) {
	return Response.json(inventoryAvailabilityResultSchema.parse(result), {
		headers: NO_STORE,
	})
}

type Change = InventoryAvailabilityRequest['changes'][number]

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
		const done = implicit
			? await applyToEntity(organization.id, change)
			: await applyToOverride(organization.id, input.locationId, change)
		if (done) applied.push(change.entityId)
	}
	if (applied.length > 0) {
		await purgeOrganizationSiteCache(organization.id, organization.slug)
	}
	return answer({ applied })
}

/** Whether a restore is still ours: nobody touched the row since the region took it off. */
function restorable(updatedAt: Date | null | undefined, change: Change) {
	if (change.since === undefined) return true
	if (!updatedAt) return true
	return updatedAt.getTime() <= change.since + AVAILABILITY_RESTORE_GRACE_MS
}

/** An organization without locations: the entity's own availability. */
async function applyToEntity(
	organizationId: string,
	change: Change,
): Promise<boolean> {
	return db.transaction(async (tx) => {
		const table =
			change.entityType === 'item'
				? OrganizationMenuItem
				: OrganizationMenuOption
		const row = await tx
			.select({
				status: table.availabilityStatus,
				updatedAt: table.updatedAt,
			})
			.from(table)
			.where(
				and(
					eq(table.id, change.entityId),
					eq(table.organizationId, organizationId),
				),
			)
			.get()
		if (!row) return false
		if (!change.available) {
			if (row.status !== 'available') return false
			await tx
				.update(table)
				.set({ availabilityStatus: 'unavailable', unavailableUntil: null })
				.where(eq(table.id, change.entityId))
			return true
		}
		if (row.status !== 'unavailable' || !restorable(row.updatedAt, change)) {
			return false
		}
		await tx
			.update(table)
			.set({ availabilityStatus: 'available', unavailableUntil: null })
			.where(eq(table.id, change.entityId))
		return true
	})
}

/** An organization with locations: the location's override of the entity. */
async function applyToOverride(
	organizationId: string,
	locationId: string,
	change: Change,
): Promise<boolean> {
	return db.transaction(async (tx) => {
		const table =
			change.entityType === 'item'
				? OrganizationMenuItem
				: OrganizationMenuOption
		// The entity must be this organization's.
		const entity = await tx
			.select({ id: table.id })
			.from(table)
			.where(
				and(
					eq(table.id, change.entityId),
					eq(table.organizationId, organizationId),
				),
			)
			.get()
		if (!entity) return false
		const existing = await tx
			.select()
			.from(OrganizationMenuLocationOverride)
			.where(
				and(
					eq(OrganizationMenuLocationOverride.locationId, locationId),
					eq(OrganizationMenuLocationOverride.entityType, change.entityType),
					eq(OrganizationMenuLocationOverride.entityId, change.entityId),
				),
			)
			.get()
		if (!change.available) {
			const status = existing?.availabilityStatus ?? null
			if (status !== null && status !== 'available') return false
			if (existing) {
				await tx
					.update(OrganizationMenuLocationOverride)
					.set({ availabilityStatus: 'unavailable', unavailableUntil: null })
					.where(eq(OrganizationMenuLocationOverride.id, existing.id))
			} else {
				await tx.insert(OrganizationMenuLocationOverride).values({
					organizationId,
					locationId,
					entityType: change.entityType,
					entityId: change.entityId,
					availabilityStatus: 'unavailable',
				})
			}
			return true
		}
		if (
			!existing ||
			existing.availabilityStatus !== 'unavailable' ||
			!restorable(existing.updatedAt, change)
		) {
			return false
		}
		// A row that holds nothing else goes away; otherwise only the status does.
		if (
			(existing.isEnabled === null || existing.isEnabled === true) &&
			existing.price === null
		) {
			await tx
				.delete(OrganizationMenuLocationOverride)
				.where(eq(OrganizationMenuLocationOverride.id, existing.id))
		} else {
			await tx
				.update(OrganizationMenuLocationOverride)
				.set({ availabilityStatus: null, unavailableUntil: null })
				.where(eq(OrganizationMenuLocationOverride.id, existing.id))
		}
		return true
	})
}
