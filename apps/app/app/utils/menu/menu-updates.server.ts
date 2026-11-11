import { auditService, AuditAction } from '@repo/audit'
import { type AvailabilityStatus } from '@repo/common/menu-types'
import {
	parseLocalizedString,
	serializeLocalizedString,
} from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	OrganizationMenuCategory,
	OrganizationMenuItem,
} from '@repo/database'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { type MenuTextChange } from './menu-suggestions.ts'

/**
 * Small menu writes that do not need the whole edit form: a translated name,
 * a description, availability. The edit forms and the review suggestions
 * both end in `recordMenuChange` (audit, then site cache purge).
 *
 * Callers check access first with `requireMenuWrite` (the `update:menu:any`
 * permission plus the menu mutation rate limit).
 */

type OrganizationRef = { id: string; slug: string }

export async function recordMenuChange({
	organization,
	userId,
	request,
	resourceType,
	resourceId,
	details,
	metadata,
}: {
	organization: OrganizationRef
	userId: string
	request?: Request
	resourceType: 'menu_item' | 'menu_category'
	resourceId: string
	details: string
	metadata?: Record<string, unknown>
}) {
	await auditService.log({
		action:
			resourceType === 'menu_item'
				? AuditAction.MENU_ITEM_UPDATED
				: AuditAction.MENU_CATEGORY_UPDATED,
		userId,
		organizationId: organization.id,
		resourceType,
		resourceId,
		details,
		metadata,
		request,
	})
	await purgeOrganizationSiteCache(organization.id, organization.slug)
}

export class MenuUpdateError extends Error {
	constructor(
		readonly code: 'not_found' | 'name_required',
		message = code,
	) {
		super(message)
		this.name = 'MenuUpdateError'
	}
}

/**
 * Set or clear localized name and description values on one dish. Returns
 * the values each change replaced (null when there was none), which is
 * exactly what Undo sends back.
 */
export async function updateMenuItemText({
	organization,
	userId,
	request,
	itemId,
	changes,
	defaultLocale,
	reason,
}: {
	organization: OrganizationRef
	userId: string
	request?: Request
	itemId: string
	changes: MenuTextChange[]
	defaultLocale: string
	reason: string
}): Promise<MenuTextChange[]> {
	const previous = await db.transaction(async (tx) => {
		const [item] = await tx
			.select({
				displayName: OrganizationMenuItem.displayName,
				description: OrganizationMenuItem.description,
			})
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.id, itemId),
					eq(OrganizationMenuItem.organizationId, organization.id),
				),
			)
			.limit(1)
		if (!item) throw new MenuUpdateError('not_found')

		const name = parseLocalizedString(item.displayName, defaultLocale)
		const description = parseLocalizedString(item.description, defaultLocale)
		const replaced: MenuTextChange[] = []
		for (const change of changes) {
			const map = change.field === 'displayName' ? name : description
			replaced.push({
				field: change.field,
				locale: change.locale,
				value: map[change.locale] ?? null,
			})
			if (change.value?.trim()) map[change.locale] = change.value.trim()
			else delete map[change.locale]
		}
		// Same rule as the edit form: a dish always keeps a name.
		if (!Object.values(name).some((value) => value?.trim())) {
			throw new MenuUpdateError('name_required')
		}
		const nextDescription = serializeLocalizedString(description)
		await tx
			.update(OrganizationMenuItem)
			.set({
				displayName: serializeLocalizedString(name),
				description: nextDescription === '{}' ? null : nextDescription,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(OrganizationMenuItem.id, itemId),
					eq(OrganizationMenuItem.organizationId, organization.id),
				),
			)
		return replaced
	})

	await recordMenuChange({
		organization,
		userId,
		request,
		resourceType: 'menu_item',
		resourceId: itemId,
		details: `Menu item text updated (${reason}).`,
		// Fields and locales only: the text itself is on the item.
		metadata: {
			reason,
			changes: changes.map(({ field, locale }) => ({ field, locale })),
		},
	})
	return previous
}

export type MenuAvailability = {
	availabilityStatus: AvailabilityStatus
	/** ISO date, only with the `unavailable_until*` statuses. */
	unavailableUntil: string | null
}

const UNTIL_STATUSES = new Set<string>([
	'unavailable_until',
	'unavailable_until_tomorrow',
])

function toUntil(availability: MenuAvailability): Date | null {
	if (!UNTIL_STATUSES.has(availability.availabilityStatus)) return null
	if (!availability.unavailableUntil) return null
	const date = new Date(availability.unavailableUntil)
	return Number.isNaN(date.getTime()) ? null : date
}

function fromRow(row: {
	availabilityStatus: string
	unavailableUntil: Date | null
}): MenuAvailability {
	return {
		availabilityStatus: row.availabilityStatus as AvailabilityStatus,
		unavailableUntil: row.unavailableUntil?.toISOString() ?? null,
	}
}

/**
 * Change a dish's availability and return what it was. `touch` keeps the
 * edit time as it was (used by Undo, so restoring a long-unavailable dish
 * does not hide it from the review for another week).
 */
export async function setMenuItemAvailability({
	organization,
	userId,
	request,
	itemId,
	availability,
	reason,
	restoreUpdatedAt,
}: {
	organization: OrganizationRef
	userId: string
	request?: Request
	itemId: string
	availability: MenuAvailability
	reason: string
	restoreUpdatedAt?: string | null
}): Promise<MenuAvailability & { updatedAt: string }> {
	const previous = await db.transaction(async (tx) => {
		const where = and(
			eq(OrganizationMenuItem.id, itemId),
			eq(OrganizationMenuItem.organizationId, organization.id),
		)
		const [item] = await tx
			.select({
				availabilityStatus: OrganizationMenuItem.availabilityStatus,
				unavailableUntil: OrganizationMenuItem.unavailableUntil,
				updatedAt: OrganizationMenuItem.updatedAt,
			})
			.from(OrganizationMenuItem)
			.where(where)
			.limit(1)
		if (!item) throw new MenuUpdateError('not_found')
		const restored = restoreUpdatedAt ? new Date(restoreUpdatedAt) : null
		await tx
			.update(OrganizationMenuItem)
			.set({
				availabilityStatus: availability.availabilityStatus,
				unavailableUntil: toUntil(availability),
				updatedAt:
					restored && !Number.isNaN(restored.getTime()) ? restored : new Date(),
			})
			.where(where)
		return { ...fromRow(item), updatedAt: item.updatedAt.toISOString() }
	})

	await recordMenuChange({
		organization,
		userId,
		request,
		resourceType: 'menu_item',
		resourceId: itemId,
		details: `Menu item availability set to ${availability.availabilityStatus} (${reason}).`,
		metadata: {
			reason,
			from: previous.availabilityStatus,
			to: availability.availabilityStatus,
		},
	})
	return previous
}

export async function setMenuCategoryAvailability({
	organization,
	userId,
	request,
	categoryId,
	availability,
	reason,
}: {
	organization: OrganizationRef
	userId: string
	request?: Request
	categoryId: string
	availability: MenuAvailability
	reason: string
}): Promise<MenuAvailability> {
	const previous = await db.transaction(async (tx) => {
		const where = and(
			eq(OrganizationMenuCategory.id, categoryId),
			eq(OrganizationMenuCategory.organizationId, organization.id),
		)
		const [category] = await tx
			.select({
				availabilityStatus: OrganizationMenuCategory.availabilityStatus,
				unavailableUntil: OrganizationMenuCategory.unavailableUntil,
			})
			.from(OrganizationMenuCategory)
			.where(where)
			.limit(1)
		if (!category) throw new MenuUpdateError('not_found')
		await tx
			.update(OrganizationMenuCategory)
			.set({
				availabilityStatus: availability.availabilityStatus,
				unavailableUntil: toUntil(availability),
				updatedAt: new Date(),
			})
			.where(where)
		return fromRow(category)
	})

	await recordMenuChange({
		organization,
		userId,
		request,
		resourceType: 'menu_category',
		resourceId: categoryId,
		details: `Menu category availability set to ${availability.availabilityStatus} (${reason}).`,
		metadata: {
			reason,
			from: previous.availabilityStatus,
			to: availability.availabilityStatus,
		},
	})
	return previous
}
