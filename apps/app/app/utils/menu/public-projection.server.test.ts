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
import { describe, expect, it } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	assemblePublicMenuData,
	buildPublicMenusForOrganization,
	collectLiveMenuContent,
	decodeMenuSnapshot,
	encodeMenuSnapshot,
} from './public-projection.server.ts'

/** Inserts one row and fails the test if nothing came back. */
async function insertOne<T>(query: PromiseLike<T[]>): Promise<T> {
	const rows = await query
	const row = rows[0]
	if (!row) throw new Error('Test seed failed')
	return row
}

async function seedMenuTree(organizationId: string) {
	const menu = await insertOne(
		db
			.insert(OrganizationMenu)
			.values({
				organizationId,
				displayName: '{"en":"Dinner"}',
				menuType: 'online_pos_kiosk',
				position: 1,
			})
			.returning(),
	)

	const category = await insertOne(
		db
			.insert(OrganizationMenuCategory)
			.values({ organizationId, displayName: '{"en":"Mains"}', position: 1 })
			.returning(),
	)

	await db.insert(OrganizationMenuCategoryAssignment).values({
		menuId: menu.id,
		categoryId: category.id,
		position: 0,
	})

	const item = await insertOne(
		db
			.insert(OrganizationMenuItem)
			.values({
				organizationId,
				displayName: '{"en":"Burger"}',
				price: 12.5,
				variations: '{"groups":[],"variants":[]}',
			})
			.returning(),
	)

	await db.insert(OrganizationMenuItemCategoryAssignment).values({
		categoryId: category.id,
		itemId: item.id,
		position: 0,
	})

	// A modifier group with one option, whose option nests a second group.
	const sizeGroup = await insertOne(
		db
			.insert(OrganizationMenuModifierGroup)
			.values({
				organizationId,
				name: 'Size',
				selectionType: 'single',
				minSelections: 1,
				maxSelections: 1,
			})
			.returning(),
	)
	const sizeOption = await insertOne(
		db
			.insert(OrganizationMenuOption)
			.values({
				organizationId,
				displayName: 'Large',
				price: 2,
				nestedModifierGroupIds: '[]',
			})
			.returning(),
	)

	await db.insert(OrganizationMenuItemModifierGroupAssignment).values({
		itemId: item.id,
		modifierGroupId: sizeGroup.id,
		position: 0,
	})
	await db.insert(OrganizationMenuModifierGroupOptionAssignment).values({
		modifierGroupId: sizeGroup.id,
		optionId: sizeOption.id,
		position: 0,
		priceOverride: 3,
	})

	const extrasGroup = await insertOne(
		db
			.insert(OrganizationMenuModifierGroup)
			.values({
				organizationId,
				name: 'Extras',
				selectionType: 'multiple',
				minSelections: 0,
			})
			.returning(),
	)
	const extrasOption = await insertOne(
		db
			.insert(OrganizationMenuOption)
			.values({ organizationId, displayName: 'Fries', price: 1 })
			.returning(),
	)
	await db.insert(OrganizationMenuModifierGroupOptionAssignment).values({
		modifierGroupId: extrasGroup.id,
		optionId: extrasOption.id,
		position: 0,
	})

	// Nest the extras group under the size option.
	await db
		.update(OrganizationMenuOption)
		.set({ nestedModifierGroupIds: JSON.stringify([extrasGroup.id]) })
		.where(eq(OrganizationMenuOption.id, sizeOption.id))
	await db.insert(OrganizationMenuOptionNestedModifierGroupAssignment).values({
		optionId: sizeOption.id,
		modifierGroupId: extrasGroup.id,
		position: 0,
	})

	return {
		menu,
		category,
		item,
		sizeGroup,
		sizeOption,
		extrasGroup,
		extrasOption,
	}
}

describe('public menu projection', () => {
	it('snapshot round-trips to an assembly identical to the live one', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const seed = await seedMenuTree(organization.id)

		const live = await collectLiveMenuContent(organization.id, seed.menu.id)
		expect(live).not.toBeNull()

		// The nested extras group must be included in the closure.
		expect(live?.modifierGroups.map((group) => group.id).sort()).toEqual(
			[seed.extrasGroup.id, seed.sizeGroup.id].sort(),
		)
		expect(live?.options.map((option) => option.id).sort()).toEqual(
			[seed.extrasOption.id, seed.sizeOption.id].sort(),
		)

		const encoded = encodeMenuSnapshot(live!)
		const decoded = decodeMenuSnapshot(encoded)
		expect(decoded).not.toBeNull()

		const now = new Date()
		const liveAssembled = assemblePublicMenuData(live!, now, new Map())
		const snapshotAssembled = assemblePublicMenuData(decoded!, now, new Map())
		expect(snapshotAssembled).toEqual(liveAssembled)

		const menu = snapshotAssembled.menu
		expect(menu.displayName).toBe('{"en":"Dinner"}')
		const categoryData = menu.categories[0]!
		expect(categoryData.displayName).toBe('{"en":"Mains"}')
		const itemData = categoryData.items[0]!
		expect(itemData.displayName).toBe('{"en":"Burger"}')
		expect(itemData.price).toBe(12.5)
		const sizeGroupData = itemData.modifierGroups[0]!
		expect(sizeGroupData.options[0]!.price).toBe(3) // assignment override wins
		expect(sizeGroupData.options[0]!.nestedModifierGroups?.[0]?.name).toBe(
			'Extras',
		)
	})

	it('serves live content before the first publish and the snapshot after', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const seed = await seedMenuTree(organization.id)

		// Before any publish: live content is served.
		const before = await buildPublicMenusForOrganization(organization.id)
		expect(before.menus).toHaveLength(1)
		expect(before.menus[0]?.id).toBe(seed.menu.id)

		// Freeze a snapshot, then edit the live item.
		const live = await collectLiveMenuContent(organization.id, seed.menu.id)
		await db.insert(OrganizationMenuPublished).values({
			organizationId: organization.id,
			menuId: seed.menu.id,
			revision: 1,
			content: encodeMenuSnapshot(live!),
		})

		await db
			.update(OrganizationMenuItem)
			.set({ displayName: '{"en":"Changed live"}' })
			.where(eq(OrganizationMenuItem.id, seed.item.id))

		const after = await buildPublicMenusForOrganization(organization.id)
		expect(after.menus).toHaveLength(1)
		expect(after.menus[0]?.categories[0]?.items[0]?.displayName).toBe(
			'{"en":"Burger"}',
		)
	})

	it('falls back to live content when the snapshot is malformed', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const seed = await seedMenuTree(organization.id)

		await db
			.update(OrganizationMenuItem)
			.set({ displayName: '{"en":"Live only"}' })
			.where(eq(OrganizationMenuItem.id, seed.item.id))

		await db.insert(OrganizationMenuPublished).values({
			organizationId: organization.id,
			menuId: seed.menu.id,
			revision: 1,
			content: '{not valid json',
		})

		const build = await buildPublicMenusForOrganization(organization.id)
		expect(build.menus[0]?.categories[0]?.items[0]?.displayName).toBe(
			'{"en":"Live only"}',
		)
	})

	it('excludes hidden entities and recovers expired temporary holds at serve time', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const seed = await seedMenuTree(organization.id)

		// Hidden items are excluded entirely.
		await db
			.update(OrganizationMenuItem)
			.set({ availabilityStatus: 'hidden' })
			.where(eq(OrganizationMenuItem.id, seed.item.id))

		const hidden = await buildPublicMenusForOrganization(organization.id)
		expect(hidden.menus[0]?.categories[0]?.items).toHaveLength(0)

		// A temporary hold that has expired resolves to available at serve time.
		const live = await collectLiveMenuContent(organization.id, seed.menu.id)
		await db.insert(OrganizationMenuPublished).values({
			organizationId: organization.id,
			menuId: seed.menu.id,
			revision: 1,
			content: JSON.stringify({
				...live!,
				items: live!.items.map((item) => ({
					...item,
					availabilityStatus: 'unavailable_until',
					unavailableUntil: new Date(Date.now() - 60_000).toISOString(),
				})),
			}),
		})

		const recovered = await buildPublicMenusForOrganization(organization.id)
		expect(
			recovered.menus[0]?.categories[0]?.items[0]?.availabilityStatus,
		).toBe('available')
	})
})
