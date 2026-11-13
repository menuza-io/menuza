import {
	and,
	db,
	eq,
	OrganizationMenuItem,
	OrganizationMenuLocationOverride,
	OrganizationMenuOption,
} from '@repo/database'

/** A change the App made by hand within this long of the region's own is still the region's. */
export const AVAILABILITY_RESTORE_GRACE_MS = 60_000

export type MenuAvailabilityChange = {
	entityType: 'item' | 'modifier_option'
	entityId: string
	available: boolean
	/** Stock only: when the region took it off (a later hand change wins). */
	since?: number
}

/**
 * Takes a dish or an option off the menu at one location, or gives it back.
 * The one writer behind inventory's auto sold out and Station's manual sold
 * out, so both land in the same place: the location's override when the
 * organization has locations (`locationId`), the entity itself when it has
 * none (`locationId` null).
 *
 * - `stock` (inventory): only an available entity is taken off, and only one
 *   still `unavailable` and untouched by hand since `since` is given back.
 * - `hand` (a person on Station): taken off whenever it is not already off;
 *   given back whenever this location's own setting holds it off. An entity
 *   switched off for every location in the App stays off: that is the App's.
 *
 * Returns whether anything changed. The caller purges the site cache.
 */
export async function applyMenuAvailability(input: {
	organizationId: string
	locationId: string | null
	change: MenuAvailabilityChange
	by: 'stock' | 'hand'
}): Promise<boolean> {
	return input.locationId === null
		? applyToEntity(input.organizationId, input.change, input.by)
		: applyToOverride(
				input.organizationId,
				input.locationId,
				input.change,
				input.by,
			)
}

/** Whether a restore is still ours: nobody touched the row since the region took it off. */
function restorable(
	updatedAt: Date | null | undefined,
	change: MenuAvailabilityChange,
) {
	if (change.since === undefined) return true
	if (!updatedAt) return true
	return updatedAt.getTime() <= change.since + AVAILABILITY_RESTORE_GRACE_MS
}

const isOff = (status: string | null | undefined) =>
	status !== null && status !== undefined && status !== 'available'

/** An organization without locations: the entity's own availability. */
async function applyToEntity(
	organizationId: string,
	change: MenuAvailabilityChange,
	by: 'stock' | 'hand',
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
			if (by === 'stock' ? row.status !== 'available' : isOff(row.status))
				return false
			await tx
				.update(table)
				.set({ availabilityStatus: 'unavailable', unavailableUntil: null })
				.where(eq(table.id, change.entityId))
			return true
		}
		if (
			by === 'stock'
				? row.status !== 'unavailable' || !restorable(row.updatedAt, change)
				: !isOff(row.status)
		) {
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
	change: MenuAvailabilityChange,
	by: 'stock' | 'hand',
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
					eq(OrganizationMenuLocationOverride.organizationId, organizationId),
					eq(OrganizationMenuLocationOverride.locationId, locationId),
					eq(OrganizationMenuLocationOverride.entityType, change.entityType),
					eq(OrganizationMenuLocationOverride.entityId, change.entityId),
				),
			)
			.get()
		if (!change.available) {
			const status = existing?.availabilityStatus ?? null
			if (
				by === 'stock'
					? status !== null && status !== 'available'
					: isOff(status)
			)
				return false
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
			(by === 'stock'
				? existing.availabilityStatus !== 'unavailable' ||
					!restorable(existing.updatedAt, change)
				: !isOff(existing.availabilityStatus))
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
