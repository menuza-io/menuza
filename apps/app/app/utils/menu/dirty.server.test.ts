import { db, eq } from '@repo/database'
import {
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
	OrganizationMenuOptionNestedModifierGroupAssignment,
	OrganizationMenuPublished,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

const purgeMock = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: purgeMock,
}))

import {
	markMenusDirty,
	markMenusDirtyForCategories,
	markMenusDirtyForItems,
	markMenusDirtyForModifierGroups,
	markMenusDirtyForOptions,
} from './dirty.server.ts'

/** Inserts one row and fails the test if nothing came back. */
async function insertOne<T>(query: PromiseLike<T[]>): Promise<T> {
	const rows = await query
	const row = rows[0]
	if (!row) throw new Error('Test seed failed')
	return row
}

async function seedMenu(
	organizationId: string,
	displayName: string,
	publish: boolean,
) {
	const menu = await insertOne(
		db
			.insert(OrganizationMenu)
			.values({ organizationId, displayName })
			.returning(),
	)
	if (publish) {
		await db.insert(OrganizationMenuPublished).values({
			organizationId,
			menuId: menu.id,
			revision: 1,
			content: '{"version":1,"menu":{"id":"' + menu.id + '"}}',
		})
	}
	return menu
}

async function seedCategoryInMenu(organizationId: string, menuId: string) {
	const category = await insertOne(
		db
			.insert(OrganizationMenuCategory)
			.values({ organizationId, displayName: 'Cat' })
			.returning(),
	)
	await db
		.insert(OrganizationMenuCategoryAssignment)
		.values({ menuId, categoryId: category.id })
	return category
}

async function seedItemInCategory(organizationId: string, categoryId: string) {
	const item = await insertOne(
		db
			.insert(OrganizationMenuItem)
			.values({ organizationId, displayName: 'Item', price: 5 })
			.returning(),
	)
	await db
		.insert(OrganizationMenuItemCategoryAssignment)
		.values({ categoryId, itemId: item.id })
	return item
}

async function menuDirty(menuId: string) {
	const [menu] = await db
		.select({ dirty: OrganizationMenu.hasUnpublishedChanges })
		.from(OrganizationMenu)
		.where(eq(OrganizationMenu.id, menuId))
	return Boolean(menu?.dirty)
}

describe('master-menu dirty tracking', () => {
	beforeEach(() => {
		purgeMock.mockClear()
	})

	it('flags published menus containing the edited item and purges for legacy menus', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const publishedMenu = await seedMenu(organization.id, 'Published', true)
		const legacyMenu = await seedMenu(organization.id, 'Legacy', false)
		const publishedCategory = await seedCategoryInMenu(
			organization.id,
			publishedMenu.id,
		)
		const legacyCategory = await seedCategoryInMenu(
			organization.id,
			legacyMenu.id,
		)
		const item = await seedItemInCategory(organization.id, publishedCategory.id)
		await seedItemInCategory(organization.id, legacyCategory.id)
		// Put the item in both menus.
		await db
			.insert(OrganizationMenuItemCategoryAssignment)
			.values({ categoryId: legacyCategory.id, itemId: item.id })

		const affected = await markMenusDirtyForItems(
			organization.id,
			organization.slug,
			[item.id],
		)

		expect(affected.has(publishedMenu.id)).toBe(true)
		expect(affected.has(legacyMenu.id)).toBe(true)
		expect(await menuDirty(publishedMenu.id)).toBe(true)
		// The legacy menu has no snapshot: it keeps the live behavior.
		expect(await menuDirty(legacyMenu.id)).toBe(false)
		expect(purgeMock).toHaveBeenCalledWith(organization.id, organization.slug)
	})

	it('flags ancestor menus when a subcategory changes', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const menu = await seedMenu(organization.id, 'Menu', true)
		const parent = await seedCategoryInMenu(organization.id, menu.id)
		const child = await insertOne(
			db
				.insert(OrganizationMenuCategory)
				.values({
					organizationId: organization.id,
					displayName: 'Child',
					parentId: parent.id,
				})
				.returning(),
		)

		const affected = await markMenusDirtyForCategories(
			organization.id,
			organization.slug,
			[child.id],
		)
		expect(affected.has(menu.id)).toBe(true)
	})

	it('walks nested modifier groups from an edited option to its menus', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const menu = await seedMenu(organization.id, 'Menu', true)
		const category = await seedCategoryInMenu(organization.id, menu.id)
		const item = await seedItemInCategory(organization.id, category.id)

		// item -> group A -> option P -> nested group B -> option Q
		const groupA = await insertOne(
			db
				.insert(OrganizationMenuModifierGroup)
				.values({ organizationId: organization.id, name: 'A' })
				.returning(),
		)
		const optionP = await insertOne(
			db
				.insert(OrganizationMenuOption)
				.values({ organizationId: organization.id, displayName: 'P' })
				.returning(),
		)
		const groupB = await insertOne(
			db
				.insert(OrganizationMenuModifierGroup)
				.values({ organizationId: organization.id, name: 'B' })
				.returning(),
		)
		const optionQ = await insertOne(
			db
				.insert(OrganizationMenuOption)
				.values({ organizationId: organization.id, displayName: 'Q' })
				.returning(),
		)

		await db.insert(OrganizationMenuItemModifierGroupAssignment).values({
			itemId: item.id,
			modifierGroupId: groupA.id,
		})
		await db.insert(OrganizationMenuModifierGroupOptionAssignment).values({
			modifierGroupId: groupA.id,
			optionId: optionP.id,
		})
		await db.insert(OrganizationMenuModifierGroupOptionAssignment).values({
			modifierGroupId: groupB.id,
			optionId: optionQ.id,
		})
		await db
			.update(OrganizationMenuOption)
			.set({ nestedModifierGroupIds: JSON.stringify([groupB.id]) })
			.where(eq(OrganizationMenuOption.id, optionP.id))
		await db
			.insert(OrganizationMenuOptionNestedModifierGroupAssignment)
			.values({ optionId: optionP.id, modifierGroupId: groupB.id })

		// Editing the deep option Q dirties the menu.
		const viaOption = await markMenusDirtyForOptions(
			organization.id,
			organization.slug,
			[optionQ.id],
		)
		expect(viaOption.has(menu.id)).toBe(true)

		// Editing the nested group B dirties the menu too.
		const viaGroup = await markMenusDirtyForModifierGroups(
			organization.id,
			organization.slug,
			[groupB.id],
		)
		expect(viaGroup.has(menu.id)).toBe(true)
	})

	it('markMenusDirty flags explicit menus', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const menu = await seedMenu(organization.id, 'Menu', true)

		await markMenusDirty(organization.id, organization.slug, [menu.id])
		expect(await menuDirty(menu.id)).toBe(true)
	})
})
