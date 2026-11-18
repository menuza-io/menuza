import { type TranslatableRecord } from '@repo/common/translation-status'
import {
	db,
	eq,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
} from '@repo/database'

/**
 * Every translatable menu record of an organization (#410): dishes, options,
 * option groups and categories with their stored localized name and
 * description. Read fresh, so the list reflects the last save.
 */
export async function loadTranslatableRecords(
	organizationId: string,
): Promise<TranslatableRecord[]> {
	const [items, options, groups, categories] = await Promise.all([
		db
			.select({
				id: OrganizationMenuItem.id,
				name: OrganizationMenuItem.displayName,
				description: OrganizationMenuItem.description,
			})
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
			.orderBy(OrganizationMenuItem.position),
		db
			.select({
				id: OrganizationMenuOption.id,
				name: OrganizationMenuOption.displayName,
				description: OrganizationMenuOption.description,
			})
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId))
			.orderBy(OrganizationMenuOption.position),
		db
			.select({
				id: OrganizationMenuModifierGroup.id,
				name: OrganizationMenuModifierGroup.name,
			})
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organizationId))
			.orderBy(OrganizationMenuModifierGroup.position),
		db
			.select({
				id: OrganizationMenuCategory.id,
				name: OrganizationMenuCategory.displayName,
				description: OrganizationMenuCategory.description,
			})
			.from(OrganizationMenuCategory)
			.where(eq(OrganizationMenuCategory.organizationId, organizationId))
			.orderBy(OrganizationMenuCategory.position),
	])
	return [
		...items.map((row) => ({ kind: 'item' as const, ...row })),
		...options.map((row) => ({ kind: 'option' as const, ...row })),
		...groups.map((row) => ({ kind: 'modifier_group' as const, ...row })),
		...categories.map((row) => ({ kind: 'category' as const, ...row })),
	]
}
