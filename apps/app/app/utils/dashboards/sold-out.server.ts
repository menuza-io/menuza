import { pickLocalized } from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	inArray,
	OrganizationLocation,
	OrganizationMenuItem,
	OrganizationMenuLocationOverride,
} from '@repo/database'
import { getInventoryFeatureState } from '#app/utils/inventory/access.server.ts'
import { orgDefaultLocale } from '#app/utils/location-name.server.ts'
import { recordManualAvailabilityEvent } from '#app/utils/menu/availability-events.server.ts'
import { applyMenuAvailability } from '#app/utils/menu/location-availability.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { soldOutItemIds } from './attention.server.ts'
import { loadStockSoldOutItemIds } from './regional-home.server.ts'

export const MAX_RESTORE_DISHES = 200

export type SoldOutDish = {
	id: string
	name: string
	/** Taken off by inventory: only the inventory undo may give it back. */
	byStock: boolean
}

type DishOrganization = { id: string; slug: string; dataRegion: string | null }

async function organizationHasLocations(organizationId: string) {
	const [row] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.limit(1)
	return Boolean(row)
}

async function loadSoldOutIds(
	organizationId: string,
	locationId: string | null,
	now: Date,
) {
	const [items, overrides] = await Promise.all([
		db
			.select({
				id: OrganizationMenuItem.id,
				availabilityStatus: OrganizationMenuItem.availabilityStatus,
				unavailableUntil: OrganizationMenuItem.unavailableUntil,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId)),
		locationId
			? db
					.select({
						locationId: OrganizationMenuLocationOverride.locationId,
						entityType: OrganizationMenuLocationOverride.entityType,
						entityId: OrganizationMenuLocationOverride.entityId,
						isEnabled: OrganizationMenuLocationOverride.isEnabled,
						availabilityStatus:
							OrganizationMenuLocationOverride.availabilityStatus,
						unavailableUntil: OrganizationMenuLocationOverride.unavailableUntil,
					})
					.from(OrganizationMenuLocationOverride)
					.where(
						and(
							eq(
								OrganizationMenuLocationOverride.organizationId,
								organizationId,
							),
							eq(OrganizationMenuLocationOverride.locationId, locationId),
							eq(OrganizationMenuLocationOverride.entityType, 'item'),
						),
					)
			: Promise.resolve([]),
	])
	return soldOutItemIds(items, overrides, locationId, now)
}

/**
 * Dishes held by inventory at a location. With inventory recipes off nothing
 * can be; with them on, the region is asked, and an unanswered question is
 * `null` so nothing is given back blind.
 */
async function stockHeldIds(
	organization: DishOrganization,
	locationId: string | null,
): Promise<string[] | null> {
	if (!locationId) return []
	const features = await getInventoryFeatureState(organization.id)
	if (!features.enabled || !features.recipes) return []
	return loadStockSoldOutItemIds(organization, locationId)
}

/** Sold-out dishes at a location for the home dialog, names in the default locale. */
export async function listSoldOutDishes({
	organization,
	locationId,
	now = new Date(),
}: {
	organization: DishOrganization
	locationId: string | null
	now?: Date
}): Promise<{ dishes: SoldOutDish[]; stockKnown: boolean }> {
	const ids = await loadSoldOutIds(organization.id, locationId, now)
	if (ids.length === 0) return { dishes: [], stockKnown: true }
	const [rows, stock, locale] = await Promise.all([
		db
			.select({
				id: OrganizationMenuItem.id,
				displayName: OrganizationMenuItem.displayName,
			})
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organization.id),
					inArray(OrganizationMenuItem.id, ids.slice(0, 90)),
				),
			),
		stockHeldIds(organization, locationId),
		orgDefaultLocale(organization.id),
	])
	const held = new Set(stock ?? [])
	return {
		stockKnown: stock !== null,
		dishes: rows
			.map((row) => ({
				id: row.id,
				name: pickLocalized(row.displayName, locale, locale),
				byStock: held.has(row.id),
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
	}
}

export type RestoreDishesResult =
	| { ok: true; restored: number; skippedByStock: number }
	| { ok: false; error: 'location_not_found' | 'stock_unknown' }

/**
 * Marks sold-out dishes available again at one location, as a person would
 * on Station (`by: 'hand'`). Dishes inventory holds off are never given back
 * here, only through the inventory undo; when the region cannot say which
 * those are, nothing is given back. The caller has checked menu edit access
 * and that the viewer may see the location.
 */
export async function restoreDishes({
	organization,
	locationId,
	itemIds,
	now = new Date(),
}: {
	organization: DishOrganization
	locationId: string | null
	itemIds: readonly string[]
	now?: Date
}): Promise<RestoreDishesResult> {
	const hasLocations = await organizationHasLocations(organization.id)
	if (hasLocations !== (locationId !== null)) {
		return { ok: false, error: 'location_not_found' }
	}
	const stock = await stockHeldIds(organization, locationId)
	if (stock === null) return { ok: false, error: 'stock_unknown' }
	const held = new Set(stock)
	const soldOut = new Set(
		await loadSoldOutIds(organization.id, locationId, now),
	)
	let restored = 0
	let skippedByStock = 0
	for (const id of new Set(itemIds)) {
		if (!soldOut.has(id)) continue
		if (held.has(id)) {
			skippedByStock += 1
			continue
		}
		const changed = await applyMenuAvailability({
			organizationId: organization.id,
			locationId,
			change: { entityType: 'item', entityId: id, available: true },
			by: 'hand',
			recordManualEvent:
				organization.dataRegion === null
					? undefined
					: recordManualAvailabilityEvent({
							orgId: organization.id,
							dataRegion: organization.dataRegion,
							locationId,
						}),
		})
		if (changed) restored += 1
	}
	if (restored > 0) {
		await purgeOrganizationSiteCache(organization.id, organization.slug)
	}
	return { ok: true, restored, skippedByStock }
}
