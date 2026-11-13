import { type InferSelectModel } from 'drizzle-orm'
import { type SQLiteTable } from 'drizzle-orm/sqlite-core'
import {
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuLocationOverride,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuOptionNestedModifierGroupAssignment,
	OrganizationMenuPosLink,
} from '@repo/database'

export const MENU_SNAPSHOT_VERSION = 1 as const

type Row<T extends SQLiteTable> = InferSelectModel<T>

export type MenuSnapshotContent = {
	version: typeof MENU_SNAPSHOT_VERSION
	menus: Row<typeof OrganizationMenu>[]
	categories: Row<typeof OrganizationMenuCategory>[]
	menuCategoryAssignments: Row<typeof OrganizationMenuCategoryAssignment>[]
	items: Row<typeof OrganizationMenuItem>[]
	itemCategoryAssignments: Row<typeof OrganizationMenuItemCategoryAssignment>[]
	modifierGroups: Row<typeof OrganizationMenuModifierGroup>[]
	itemModifierGroupAssignments: Row<
		typeof OrganizationMenuItemModifierGroupAssignment
	>[]
	options: Row<typeof OrganizationMenuOption>[]
	modifierGroupOptionAssignments: Row<
		typeof OrganizationMenuModifierGroupOptionAssignment
	>[]
	optionNestedModifierGroupAssignments: Row<
		typeof OrganizationMenuOptionNestedModifierGroupAssignment
	>[]
	locationOverrides: Row<typeof OrganizationMenuLocationOverride>[]
	posLinks: Row<typeof OrganizationMenuPosLink>[]
}
