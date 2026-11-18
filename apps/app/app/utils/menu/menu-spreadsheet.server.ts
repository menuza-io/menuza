import { auditService, AuditAction } from '@repo/audit'
import {
	getLocalizedMenuValue,
	parseMenuVariations,
} from '@repo/common/menu-types'
import {
	asc,
	db,
	eq,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	planMenuSpreadsheet,
	type SpreadsheetChange,
	type SpreadsheetDish,
} from './menu-spreadsheet.ts'
import { createMenuSnapshot } from './snapshot.server.ts'

/** Every dish of the organization as the spreadsheet lists it. */
export async function loadSpreadsheetDishes(
	organizationId: string,
	locale: string,
): Promise<Array<SpreadsheetDish & { updatedAt: Date }>> {
	const [items, links] = await Promise.all([
		db
			.select({
				id: OrganizationMenuItem.id,
				displayName: OrganizationMenuItem.displayName,
				price: OrganizationMenuItem.price,
				orderTypePrices: OrganizationMenuItem.orderTypePrices,
				availabilityStatus: OrganizationMenuItem.availabilityStatus,
				variations: OrganizationMenuItem.variations,
				updatedAt: OrganizationMenuItem.updatedAt,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.orderBy(asc(OrganizationMenuItem.position)),
		db
			.select({
				itemId: OrganizationMenuItemCategoryAssignment.itemId,
				name: OrganizationMenuCategory.displayName,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuCategory,
				eq(
					OrganizationMenuCategory.id,
					OrganizationMenuItemCategoryAssignment.categoryId,
				),
			)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId))
			.orderBy(asc(OrganizationMenuCategory.position)),
	])
	const categoryOf = new Map<string, string>()
	for (const link of links) {
		if (!categoryOf.has(link.itemId)) categoryOf.set(link.itemId, link.name)
	}
	const text = (value: string) => getLocalizedMenuValue(value, locale, locale)
	return items.map((item) => ({
		id: item.id,
		name: text(item.displayName),
		category: text(categoryOf.get(item.id) ?? ''),
		price: item.price,
		orderTypePrices: item.orderTypePrices,
		availabilityStatus: item.availabilityStatus,
		hasVariations: parseMenuVariations(item.variations).variants.length > 0,
		updatedAt: item.updatedAt,
	}))
}

export type SpreadsheetPreview = {
	rows: number
	changes: Array<Omit<SpreadsheetChange, 'write'>>
	problems: Exclude<
		ReturnType<typeof planMenuSpreadsheet>,
		{ ok: false }
	>['problems']
	/** `updatedAt` of every changed dish when previewed; apply refuses if one moved. */
	stamps: Record<string, string>
}

export async function previewSpreadsheet(
	organizationId: string,
	locale: string,
	csv: string,
): Promise<
	{ ok: true; preview: SpreadsheetPreview } | { ok: false; error: string }
> {
	const dishes = await loadSpreadsheetDishes(organizationId, locale)
	const plan = planMenuSpreadsheet(
		csv,
		new Map(dishes.map((dish) => [dish.id, dish])),
	)
	if (!plan.ok) return { ok: false, error: plan.error }
	const updated = new Map(dishes.map((dish) => [dish.id, dish.updatedAt]))
	return {
		ok: true,
		preview: {
			rows: plan.rows,
			changes: plan.changes.map(({ write: _write, ...change }) => change),
			problems: plan.problems,
			stamps: Object.fromEntries(
				plan.changes.map((change) => [
					change.itemId,
					updated.get(change.itemId)!.toISOString(),
				]),
			),
		},
	}
}

/**
 * Applies a checked file: all rows or none. Refuses when the file has a bad
 * row, or when a dish changed since the preview. Takes a menu snapshot first
 * (History can undo it) and records the change in the activity log.
 */
export async function applySpreadsheet(input: {
	organizationId: string
	organizationSlug: string
	userId: string
	locale: string
	csv: string
	stamps: Record<string, string>
	request?: Request
}): Promise<
	| { ok: true; applied: number; snapshotId: string | null }
	| { ok: false; error: string; staleIds?: string[]; problems?: number }
> {
	const dishes = await loadSpreadsheetDishes(input.organizationId, input.locale)
	const plan = planMenuSpreadsheet(
		input.csv,
		new Map(dishes.map((dish) => [dish.id, dish])),
	)
	if (!plan.ok) return { ok: false, error: plan.error }
	if (plan.problems.length > 0)
		return { ok: false, error: 'has_problems', problems: plan.problems.length }
	if (plan.changes.length === 0)
		return { ok: true, applied: 0, snapshotId: null }
	const updated = new Map(
		dishes.map((dish) => [dish.id, dish.updatedAt.toISOString()]),
	)
	const staleIds = plan.changes
		.map((change) => change.itemId)
		.filter((id) => input.stamps[id] !== updated.get(id))
	if (staleIds.length > 0) return { ok: false, error: 'stale_rows', staleIds }

	const snapshotId = await createMenuSnapshot({
		organizationId: input.organizationId,
		reason: 'before_bulk_edit',
		userId: input.userId,
	})
	await db.transaction(async (tx) => {
		for (const change of plan.changes) {
			await tx
				.update(OrganizationMenuItem)
				.set({
					...change.write,
					...(change.write.availabilityStatus
						? { unavailableUntil: null }
						: {}),
					updatedAt: new Date(),
				})
				.where(eq(OrganizationMenuItem.id, change.itemId))
		}
	})
	const itemIds = plan.changes.map((change) => change.itemId)
	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId: input.userId,
		organizationId: input.organizationId,
		resourceType: 'menu_spreadsheet',
		resourceId: snapshotId,
		details: `Updated ${plan.changes.length} menu items from a spreadsheet`,
		metadata: {
			itemIds,
			fields: [...new Set(plan.changes.flatMap((change) => change.fields))],
			undoSnapshotId: snapshotId,
		},
		request: input.request,
	})
	await purgeOrganizationSiteCache(input.organizationId, input.organizationSlug)
	return { ok: true, applied: plan.changes.length, snapshotId }
}
