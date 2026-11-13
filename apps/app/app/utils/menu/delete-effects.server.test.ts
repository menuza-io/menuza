import {
	db,
	Integration,
	OrganizationDrop,
	OrganizationDropInventory,
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
	OrganizationMenuPosLink,
	PrintDesign,
} from '@repo/database'
import { type DiscountDefinition } from '@repo/discounts'
import { describe, expect, it } from 'vitest'
import { createDiscount } from '#app/utils/discounts/discounts.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	type DeleteEffectKind,
	type DeleteEffects,
	discountReferences,
	getDeleteEffects,
} from './delete-effects.server.ts'

const baseDefinition: DiscountDefinition = {
	name: 'Discount',
	internalName: null,
	description: null,
	status: 'active',
	application: 'automatic',
	valueType: 'percent',
	percentBp: 1000,
	amountMinor: null,
	currency: null,
	maxDiscountMinor: null,
	target: {
		scope: 'order',
		itemIds: [],
		categoryIds: [],
		excludeItemIds: [],
		excludeCategoryIds: [],
	},
	requirement: null,
	quantityRule: { kind: 'none' },
	maxDiscountedUnits: null,
	minSubtotalMinor: null,
	locationIds: null,
	channels: ['web'],
	fulfillments: ['pickup'],
	includeDrops: false,
	schedule: null,
	startsAt: null,
	endsAt: null,
	eligibility: 'everyone',
	totalLimit: null,
	perCustomerLimit: null,
	combinable: true,
	priority: 0,
	promoteOnMenu: false,
	requireApproval: false,
}

function definition(
	name: string,
	target: Partial<DiscountDefinition['target']>,
): DiscountDefinition {
	return {
		...baseDefinition,
		name,
		target: { ...baseDefinition.target, ...target },
	}
}

/**
 * One organization with a small menu and everything that can name it:
 *
 *   Lunch menu > Mains category > Burger (and Fries)
 *   Burger offers the Sauces group; Sauces holds Ketchup; the Cheese option
 *   opens Sauces as a nested choice.
 */
async function world() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	const organizationId = organization.id

	const [menu] = await db
		.insert(OrganizationMenu)
		.values({ organizationId, displayName: '{"en":"Lunch"}' })
		.returning()
	const [category] = await db
		.insert(OrganizationMenuCategory)
		.values({ organizationId, displayName: '{"en":"Mains"}' })
		.returning()
	const [burger, fries] = await db
		.insert(OrganizationMenuItem)
		.values([
			{ organizationId, displayName: '{"en":"Burger"}' },
			{ organizationId, displayName: '{"en":"Fries"}' },
		])
		.returning()
	const [sauces] = await db
		.insert(OrganizationMenuModifierGroup)
		.values({ organizationId, name: '{"en":"Sauces"}' })
		.returning()
	const [ketchup, cheese] = await db
		.insert(OrganizationMenuOption)
		.values([
			{ organizationId, displayName: '{"en":"Ketchup"}' },
			{ organizationId, displayName: '{"en":"Cheese"}' },
		])
		.returning()

	await db
		.insert(OrganizationMenuCategoryAssignment)
		.values({ menuId: menu!.id, categoryId: category!.id })
	await db.insert(OrganizationMenuItemCategoryAssignment).values([
		{ categoryId: category!.id, itemId: burger!.id, position: 0 },
		{ categoryId: category!.id, itemId: fries!.id, position: 1 },
	])
	await db
		.insert(OrganizationMenuItemModifierGroupAssignment)
		.values({ itemId: burger!.id, modifierGroupId: sauces!.id })
	await db
		.insert(OrganizationMenuModifierGroupOptionAssignment)
		.values({ modifierGroupId: sauces!.id, optionId: ketchup!.id })
	await db
		.insert(OrganizationMenuOptionNestedModifierGroupAssignment)
		.values({ optionId: cheese!.id, modifierGroupId: sauces!.id })

	return {
		user,
		organizationId,
		menu: menu!,
		category: category!,
		burger: burger!,
		fries: fries!,
		sauces: sauces!,
		ketchup: ketchup!,
		cheese: cheese!,
	}
}

type World = Awaited<ReturnType<typeof world>>

async function addDiscount(w: World, value: DiscountDefinition) {
	const created = await createDiscount({
		organizationId: w.organizationId,
		userId: w.user.id,
		definition: value,
		codes: [],
	})
	if (!created.ok) throw new Error(`discount not created: ${created.reason}`)
	return created
}

async function addDrop(
	w: World,
	title: string,
	entity?: { type: 'item' | 'category'; id: string },
	patch: { menuId?: string; status?: string } = {},
) {
	// A drop needs a menu; one of its own keeps it apart from the Lunch menu.
	let menuId = patch.menuId
	if (!menuId) {
		const [dropMenu] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: w.organizationId,
				displayName: '{"en":"Drop menu"}',
			})
			.returning()
		menuId = dropMenu!.id
	}
	const [drop] = await db
		.insert(OrganizationDrop)
		.values({
			organizationId: w.organizationId,
			menuId,
			title,
			slug: `${title.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}`,
			status: patch.status ?? 'scheduled',
		})
		.returning()
	if (entity) {
		await db.insert(OrganizationDropInventory).values({
			dropId: drop!.id,
			entityType: entity.type,
			entityId: entity.id,
		})
	}
	return drop!
}

async function addPosLink(
	w: World,
	entityType: string,
	localId: string,
	providerName = 'square',
) {
	const [integration] = await db
		.insert(Integration)
		.values({
			organizationId: w.organizationId,
			providerName,
			providerType: 'pos',
			config: '{}',
		})
		.returning()
	await db.insert(OrganizationMenuPosLink).values({
		organizationId: w.organizationId,
		integrationId: integration!.id,
		providerName,
		entityType,
		remoteId: `remote-${localId}`,
		localId,
	})
}

function rows(effects: DeleteEffects, kind: DeleteEffectKind) {
	return effects.groups.find((group) => group.kind === kind)?.rows ?? []
}

function names(effects: DeleteEffects, kind: DeleteEffectKind) {
	return rows(effects, kind).map((row) => row.name)
}

async function status(promise: Promise<unknown>): Promise<number> {
	try {
		await promise
	} catch (thrown) {
		if (thrown instanceof Response) return thrown.status
		throw thrown
	}
	return 200
}

describe('getDeleteEffects: item', () => {
	it('lists the menus, categories, discount, drop, print design and POS link of a dish', async () => {
		const w = await world()
		await addDiscount(
			w,
			definition('Burger deal', {
				scope: 'items',
				itemIds: [w.burger.id, w.fries.id],
			}),
		)
		const drop = await addDrop(w, 'Friday drop', {
			type: 'item',
			id: w.burger.id,
		})
		await addPosLink(w, 'item', w.burger.id)
		const [design] = await db
			.insert(PrintDesign)
			.values({
				organizationId: w.organizationId,
				name: 'Table card',
				product: 'table_card',
				sizeKey: 'a6',
				style: 'classic',
				templateVersion: 1,
				content: { featuredItemIds: [w.burger.id] },
			})
			.returning()

		const effects = await getDeleteEffects(
			w.organizationId,
			'item',
			w.burger.id,
		)

		expect(effects.name).toBe('Burger')
		expect(names(effects, 'in_menus')).toEqual(['Lunch'])
		expect(names(effects, 'in_categories')).toEqual(['Mains'])
		expect(rows(effects, 'discounts')).toEqual([
			expect.objectContaining({ name: 'Burger deal', status: 'active' }),
		])
		expect(rows(effects, 'discounts')[0]?.note).toBeUndefined()
		expect(rows(effects, 'drops')).toEqual([
			expect.objectContaining({ id: drop.id, name: 'Friday drop' }),
		])
		expect(rows(effects, 'print_designs')).toEqual([
			{ id: design!.id, name: 'Table card' },
		])
		expect(rows(effects, 'pos_links')).toEqual([
			{ id: 'square', name: 'square', count: 1 },
		])
		expect(effects.recipeOwners).toEqual([
			{ ownerKind: 'menu_item', ownerId: w.burger.id },
		])
	})

	it('marks a discount whose only target is the dish', async () => {
		const w = await world()
		await addDiscount(
			w,
			definition('Burger only', { scope: 'items', itemIds: [w.burger.id] }),
		)
		await addDiscount(w, definition('Whole order', { scope: 'order' }))

		const effects = await getDeleteEffects(
			w.organizationId,
			'item',
			w.burger.id,
		)

		expect(rows(effects, 'discounts')).toEqual([
			expect.objectContaining({
				name: 'Burger only',
				note: 'loses_all_targets',
			}),
		])
	})

	it('leaves out closed drops and reports only groups that have rows', async () => {
		const w = await world()
		await addDrop(
			w,
			'Old drop',
			{ type: 'item', id: w.fries.id },
			{ status: 'completed' },
		)

		const effects = await getDeleteEffects(w.organizationId, 'item', w.fries.id)

		expect(effects.groups.map((group) => group.kind)).toEqual([
			'in_menus',
			'in_categories',
		])
	})
})

describe('getDeleteEffects: category', () => {
	it('lists its menus, its dishes, discounts, drops and POS links', async () => {
		const w = await world()
		await addDiscount(
			w,
			definition('Mains deal', {
				scope: 'categories',
				categoryIds: [w.category.id],
			}),
		)
		await addDrop(w, 'Mains drop', { type: 'category', id: w.category.id })
		await addPosLink(w, 'category', w.category.id)

		const effects = await getDeleteEffects(
			w.organizationId,
			'category',
			w.category.id,
		)

		expect(names(effects, 'in_menus')).toEqual(['Lunch'])
		expect(names(effects, 'contains_items')).toEqual(['Burger', 'Fries'])
		expect(rows(effects, 'discounts')).toEqual([
			expect.objectContaining({
				name: 'Mains deal',
				note: 'loses_all_targets',
			}),
		])
		expect(names(effects, 'drops')).toEqual(['Mains drop'])
		expect(rows(effects, 'pos_links')[0]?.count).toBe(1)
		expect(effects.recipeOwners).toEqual([])
	})
})

describe('getDeleteEffects: menu', () => {
	it('lists its categories and the drops that block the delete', async () => {
		const w = await world()
		const drop = await addDrop(w, 'Menu drop', undefined, {
			menuId: w.menu.id,
			status: 'completed',
		})
		await addPosLink(w, 'menu', w.menu.id)

		const effects = await getDeleteEffects(w.organizationId, 'menu', w.menu.id)

		expect(names(effects, 'contains_categories')).toEqual(['Mains'])
		expect(rows(effects, 'drops')).toEqual([
			expect.objectContaining({ id: drop.id, note: 'blocks_delete' }),
		])
		expect(rows(effects, 'pos_links')).toHaveLength(1)
	})
})

describe('getDeleteEffects: modifier group', () => {
	it('lists the dishes using it, its options, nesting options, discounts and POS links', async () => {
		const w = await world()
		await addDiscount(
			w,
			definition('Free sauce', {
				scope: 'modifiers',
				modifierGroupIds: [w.sauces.id],
				modifierOptionIds: [],
			}),
		)
		await addPosLink(w, 'modifier_group', w.sauces.id)

		const effects = await getDeleteEffects(
			w.organizationId,
			'modifier_group',
			w.sauces.id,
		)

		expect(names(effects, 'used_by_items')).toEqual(['Burger'])
		expect(names(effects, 'contains_options')).toEqual(['Ketchup'])
		expect(names(effects, 'nested_in_options')).toEqual(['Cheese'])
		expect(rows(effects, 'discounts')).toEqual([
			expect.objectContaining({
				name: 'Free sauce',
				note: 'loses_all_targets',
			}),
		])
		expect(rows(effects, 'pos_links')).toHaveLength(1)
	})
})

describe('getDeleteEffects: option', () => {
	it('lists its groups, the dishes offering them, discounts and POS links', async () => {
		const w = await world()
		await addDiscount(
			w,
			definition('Free ketchup', {
				scope: 'modifiers',
				modifierGroupIds: [],
				modifierOptionIds: [w.ketchup.id, w.cheese.id],
			}),
		)
		await addPosLink(w, 'modifier_option', w.ketchup.id)

		const effects = await getDeleteEffects(
			w.organizationId,
			'modifier_option',
			w.ketchup.id,
		)

		expect(names(effects, 'in_modifier_groups')).toEqual(['Sauces'])
		expect(names(effects, 'used_by_items')).toEqual(['Burger'])
		expect(rows(effects, 'discounts')).toEqual([
			expect.objectContaining({ name: 'Free ketchup' }),
		])
		expect(rows(effects, 'discounts')[0]?.note).toBeUndefined()
		expect(rows(effects, 'pos_links')).toHaveLength(1)
		expect(effects.recipeOwners).toEqual([
			{ ownerKind: 'option', ownerId: w.ketchup.id },
		])
	})
})

describe('getDeleteEffects: organization isolation', () => {
	it("answers 404 for another organization's record of every type", async () => {
		const mine = await world()
		const theirs = await world()
		const cases = [
			['menu', theirs.menu.id],
			['category', theirs.category.id],
			['item', theirs.burger.id],
			['modifier_group', theirs.sauces.id],
			['modifier_option', theirs.ketchup.id],
		] as const
		for (const [type, id] of cases) {
			expect(
				await status(getDeleteEffects(mine.organizationId, type, id)),
				type,
			).toBe(404)
		}
		expect(
			await status(getDeleteEffects(mine.organizationId, 'item', 'missing')),
		).toBe(404)
	})

	it("never lists another organization's discount, drop or POS link", async () => {
		const mine = await world()
		const theirs = await world()
		// Their records name my dish by id (ids are opaque; nothing stops it).
		await addDiscount(
			theirs,
			definition('Theirs', { scope: 'items', itemIds: [mine.burger.id] }),
		)
		await addDrop(theirs, 'Their drop', { type: 'item', id: mine.burger.id })
		await addPosLink(theirs, 'item', mine.burger.id)

		const effects = await getDeleteEffects(
			mine.organizationId,
			'item',
			mine.burger.id,
		)

		expect(effects.groups.map((group) => group.kind)).toEqual([
			'in_menus',
			'in_categories',
		])
	})
})

describe('discountReferences', () => {
	it('counts an exclusion as a reference that leaves the discount working', () => {
		const value = definition('All but one', {
			scope: 'items',
			itemIds: ['a'],
			excludeItemIds: ['b'],
		})
		expect(discountReferences(value, 'item', 'b')).toEqual({
			references: true,
			losesAllTargets: false,
		})
		expect(discountReferences(value, 'item', 'a')).toEqual({
			references: true,
			losesAllTargets: true,
		})
		expect(discountReferences(value, 'item', 'c').references).toBe(false)
	})

	it('sees a buy side that names only this dish', () => {
		const value: DiscountDefinition = {
			...definition('Buy one get one', { scope: 'order' }),
			quantityRule: {
				kind: 'buy_get',
				buy: { itemIds: ['a'], categoryIds: [] },
				get: { itemIds: ['b', 'c'], categoryIds: [], quantity: 1 },
			},
		}
		expect(discountReferences(value, 'item', 'a').losesAllTargets).toBe(true)
		expect(discountReferences(value, 'item', 'b').losesAllTargets).toBe(false)
	})
})
