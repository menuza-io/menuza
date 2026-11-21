import type * as auditModule from '@repo/audit'
import {
	db,
	eq,
	MenuImport,
	MenuSnapshot,
	Organization,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as storageServer from '#app/utils/storage.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { applyMenuImport } from './apply.server.ts'
import { type MenuImportDraft } from './schema.ts'

const mocks = vi.hoisted(() => ({
	snapshotStore: new Map<string, string>(),
	purgeCache: vi.fn(),
	auditLog: vi.fn(),
}))

vi.mock('#app/utils/storage.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof storageServer>()
	return {
		...actual,
		uploadMenuSnapshotJson: vi.fn(
			async (orgId: string, snapshotId: string, body: string) => {
				const key = `menu-snapshots/${orgId}/${snapshotId}.json`
				mocks.snapshotStore.set(key, body)
				return key
			},
		),
		readMenuSnapshotJson: vi.fn(
			async (key: string) => mocks.snapshotStore.get(key) ?? null,
		),
	}
})

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: mocks.purgeCache,
}))

vi.mock('@repo/audit', async (importOriginal) => {
	const actual = await importOriginal<typeof auditModule>()
	return {
		...actual,
		auditService: { log: mocks.auditLog },
	}
})

function buildSampleDraft(): MenuImportDraft {
	return {
		version: 1,
		detectedCurrency: 'USD',
		detectedLocales: ['en', 'ar'],
		imageSuggestions: [
			{ url: 'https://example.com/photo.jpg', alt: 'Suggested photo' },
		],
		menus: [
			{
				id: 'menu-1',
				included: true,
				name: { en: 'Dinner Menu', ar: 'قائمة العشاء' },
				categories: [
					{
						id: 'cat-1',
						included: true,
						name: { en: 'Burgers', ar: 'برجر' },
						description: { en: 'Chargrilled burgers' },
						items: [
							{
								id: 'item-1',
								included: true,
								name: { en: 'Classic Burger', ar: 'برجر كلاسيك' },
								description: { en: 'With cheddar cheese' },
								price: 15,
								sizes: [
									{ id: 'sz-1', name: { en: 'Single' }, price: 15 },
									{ id: 'sz-2', name: { en: 'Double' }, price: 21 },
								],
								modifierGroups: [
									{
										id: 'grp-1',
										included: true,
										name: { en: 'Add-ons' },
										selectionType: 'multiple',
										minSelections: 0,
										maxSelections: 2,
										options: [
											{
												id: 'opt-1',
												included: true,
												name: { en: 'Extra Cheese' },
												price: 2,
											},
										],
									},
								],
								confidence: 'high',
								lowConfidenceFields: [],
								matchExistingItemId: null,
							},
							{
								id: 'item-skip',
								included: false,
								name: { en: 'Skipped Dish' },
								description: {},
								price: 9,
								sizes: [],
								modifierGroups: [],
								confidence: 'high',
								lowConfidenceFields: [],
								matchExistingItemId: null,
							},
						],
					},
				],
			},
		],
	}
}

describe('menu import apply.server (#73)', () => {
	let organizationId = ''
	let organizationSlug = ''
	let userId = ''

	beforeEach(async () => {
		vi.clearAllMocks()
		mocks.snapshotStore.clear()
		const user = await insertTestUser()
		const org = await createTestOrganization(user.id)
		organizationId = org.id
		organizationSlug = org.slug
		userId = user.id
	})

	afterEach(() => {
		mocks.snapshotStore.clear()
	})

	it('creates menus and dishes unavailable by default, takes a before_import snapshot, and never fills allergens or calories', async () => {
		const [imp] = await db
			.insert(MenuImport)
			.values({
				organizationId,
				sourceKind: 'url',
				sourceUrl: 'https://example.com/menu',
				status: 'ready',
				confirmedOwnership: true,
				createdById: userId,
			})
			.returning()

		const result = await applyMenuImport({
			importId: imp!.id,
			organizationId,
			organizationSlug,
			userId,
			draft: buildSampleDraft(),
			publishNow: false,
		})

		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.createdMenus).toBe(1)
		expect(result.createdCategories).toBe(1)
		expect(result.createdItems).toBe(1) // Skipped Dish was unticked
		expect(result.createdModifierGroups).toBe(1)
		expect(result.createdOptions).toBe(1)

		// Snapshot taken before import
		const snapshots = await db
			.select()
			.from(MenuSnapshot)
			.where(eq(MenuSnapshot.organizationId, organizationId))
		expect(snapshots.some((s) => s.reason === 'before_import')).toBe(true)

		// Menu and dish start unavailable by default
		const menus = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.organizationId, organizationId))
		expect(menus).toHaveLength(1)
		expect(menus[0]!.availabilityStatus).toBe('unavailable')
		// Org defaults to 'en' only, so 'ar' is not stored
		expect(menus[0]!.displayName).toBe('{"en":"Dinner Menu"}')

		const items = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
		expect(items).toHaveLength(1)
		expect(items[0]!.availabilityStatus).toBe('unavailable')
		expect(items[0]!.allergens).toBe('[]')
		expect(items[0]!.calorieMin).toBeNull()
		expect(items[0]!.calorieMax).toBeNull()
		expect(items[0]!.imageKey).toBeNull()
		expect(items[0]!.imageUrl).toBeNull()

		const options = await db
			.select()
			.from(OrganizationMenuOption)
			.where(eq(OrganizationMenuOption.organizationId, organizationId))
		expect(options[0]!.allergens).toBe('[]')
		expect(options[0]!.calories).toBeNull()

		expect(mocks.purgeCache).toHaveBeenCalledWith(
			organizationId,
			organizationSlug,
		)
	})

	it('is idempotent when applied twice and matches existing dishes by id or exact name without duplicates', async () => {
		// Pre-seed an existing dish with safety data that must never be overwritten
		const [existingDish] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId,
				displayName: '{"en":"Classic Burger"}',
				price: 12,
				allergens: '["gluten","dairy"]',
				calorieMin: 550,
				calorieMax: 650,
				availabilityStatus: 'available',
			})
			.returning()

		const [unrelatedDish] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId,
				displayName: '{"en":"Caesar Salad"}',
				price: 10,
				availabilityStatus: 'available',
			})
			.returning()

		const [imp1] = await db
			.insert(MenuImport)
			.values({
				organizationId,
				sourceKind: 'pdf',
				status: 'ready',
				createdById: userId,
			})
			.returning()

		const draft = buildSampleDraft()
		const first = await applyMenuImport({
			importId: imp1!.id,
			organizationId,
			organizationSlug,
			userId,
			draft,
			publishNow: true,
			missingExistingAction: 'mark_unavailable',
		})
		expect(first.ok).toBe(true)
		if (!first.ok) return
		expect(first.createdItems).toBe(0)
		expect(first.updatedItems).toBe(1)
		expect(first.markedUnavailable).toBe(1)

		// Applying the exact same import a second time is an idempotent no-op
		const second = await applyMenuImport({
			importId: imp1!.id,
			organizationId,
			organizationSlug,
			userId,
			draft,
			publishNow: true,
		})
		expect(second.ok).toBe(true)
		if (!second.ok) return
		expect(second.alreadyApplied).toBe(true)
		expect(second.createdItems).toBe(0)

		// A fresh second import with identical names matches existing entities (no duplicates)
		const [imp2] = await db
			.insert(MenuImport)
			.values({
				organizationId,
				sourceKind: 'pdf',
				status: 'ready',
				createdById: userId,
			})
			.returning()

		const third = await applyMenuImport({
			importId: imp2!.id,
			organizationId,
			organizationSlug,
			userId,
			draft,
			publishNow: false,
		})
		expect(third.ok).toBe(true)
		if (!third.ok) return
		expect(third.createdMenus).toBe(0)
		expect(third.createdCategories).toBe(0)
		expect(third.createdItems).toBe(0)
		expect(third.createdModifierGroups).toBe(0)
		expect(third.createdOptions).toBe(0)

		// Check DB totals and safety data preservation
		const allItems = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
		expect(allItems).toHaveLength(2)

		const updatedClassic = allItems.find((i) => i.id === existingDish!.id)!
		expect(updatedClassic.price).toBe(15)
		expect(updatedClassic.allergens).toBe('["gluten","dairy"]')
		expect(updatedClassic.calorieMin).toBe(550)
		expect(updatedClassic.calorieMax).toBe(650)

		const updatedUnrelated = allItems.find((i) => i.id === unrelatedDish!.id)!
		expect(updatedUnrelated.availabilityStatus).toBe('unavailable')

		expect(
			await db
				.select()
				.from(OrganizationMenuCategory)
				.where(eq(OrganizationMenuCategory.organizationId, organizationId)),
		).toHaveLength(1)
		expect(
			await db
				.select()
				.from(OrganizationMenuModifierGroup)
				.where(
					eq(OrganizationMenuModifierGroup.organizationId, organizationId),
				),
		).toHaveLength(1)
	})

	it('fills bilingual en and ar localized fields when org supports both locales and enforces org isolation', async () => {
		await db
			.update(Organization)
			.set({ siteLocales: '["en","ar"]', siteDefaultLocale: 'en' })
			.where(eq(Organization.id, organizationId))

		const otherUser = await insertTestUser()
		const otherOrg = await createTestOrganization(otherUser.id)

		const [imp] = await db
			.insert(MenuImport)
			.values({
				organizationId,
				sourceKind: 'image',
				status: 'ready',
				createdById: userId,
			})
			.returning()

		// Cross-org apply must be refused with 404
		const crossOrg = await applyMenuImport({
			importId: imp!.id,
			organizationId: otherOrg.id,
			organizationSlug: otherOrg.slug,
			userId: otherUser.id,
			draft: buildSampleDraft(),
		})
		expect(crossOrg.ok).toBe(false)
		if (!crossOrg.ok) expect(crossOrg.status).toBe(404)

		const ownOrg = await applyMenuImport({
			importId: imp!.id,
			organizationId,
			organizationSlug,
			userId,
			draft: buildSampleDraft(),
		})
		expect(ownOrg.ok).toBe(true)

		const [item] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, organizationId))
		expect(JSON.parse(item!.displayName)).toEqual({
			en: 'Classic Burger',
			ar: 'برجر كلاسيك',
		})
	})
})
