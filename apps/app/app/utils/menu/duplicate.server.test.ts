import {
	db,
	eq,
	OrganizationMenuItem,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	copyLocationOverrides,
	CopyOverridesError,
	duplicateItem,
} from './duplicate.server.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))

describe('duplicate.server', () => {
	it('duplicates an item as unavailable with assignments and without POS links', async () => {
		const user = await insertTestUser()
		const org = await createTestOrganization(user.id)

		const [group] = await db
			.insert(OrganizationMenuModifierGroup)
			.values({ organizationId: org.id, name: '{"en":"Sides"}' })
			.returning()

		const [item] = await db
			.insert(OrganizationMenuItem)
			.values({
				organizationId: org.id,
				displayName: '{"en":"Salad"}',
				price: 8,
				availabilityStatus: 'available',
			})
			.returning()

		await db.insert(OrganizationMenuItemModifierGroupAssignment).values({
			itemId: item!.id,
			modifierGroupId: group!.id,
		})

		const { id: copyId } = await duplicateItem({
			organizationId: org.id,
			organizationSlug: org.slug,
			itemId: item!.id,
			copyModifierGroups: false,
		})

		expect(copyId).not.toBe(item!.id)

		const copy = await db.query.OrganizationMenuItem.findFirst({
			where: eq(OrganizationMenuItem.id, copyId),
			with: { modifierGroupAssignments: true },
		})
		expect(copy?.availabilityStatus).toBe('unavailable')
		expect(copy?.displayName).toContain('(copy)')
		expect(copy?.modifierGroupAssignments).toHaveLength(1)
		expect(copy?.modifierGroupAssignments[0]?.modifierGroupId).toBe(group!.id)
		expect(copyId).not.toBe(item!.id)
	})

	it('refuses copying overrides when the source is among targets', async () => {
		const user = await insertTestUser()
		const org = await createTestOrganization(user.id)

		await expect(
			copyLocationOverrides({
				organizationId: org.id,
				organizationSlug: org.slug,
				sourceLocationId: 'loc-a',
				targetLocationIds: ['loc-a'],
				replace: false,
			}),
		).rejects.toBeInstanceOf(CopyOverridesError)

		try {
			await copyLocationOverrides({
				organizationId: org.id,
				organizationSlug: org.slug,
				sourceLocationId: 'loc-a',
				targetLocationIds: ['loc-a'],
				replace: false,
			})
		} catch (error) {
			expect((error as CopyOverridesError).code).toBe('source_in_targets')
		}
	})
})
