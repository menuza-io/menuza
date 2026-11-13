import {
	db,
	OrganizationMenuModifierGroup,
	OrganizationMenuModifierGroupOptionAssignment,
	OrganizationMenuOption,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { checkModifierGraphChange } from './modifier-graph.server.ts'

describe('checkModifierGraphChange', () => {
	it('refuses a save that would close a nested group loop', async () => {
		const user = await insertTestUser()
		const organization = await createTestOrganization(user.id)

		const [size] = await db
			.insert(OrganizationMenuModifierGroup)
			.values({
				organizationId: organization.id,
				name: '{"en":"Size"}',
			})
			.returning()
		const [extras] = await db
			.insert(OrganizationMenuModifierGroup)
			.values({
				organizationId: organization.id,
				name: '{"en":"Extras"}',
			})
			.returning()

		const [sizeOption] = await db
			.insert(OrganizationMenuOption)
			.values({
				organizationId: organization.id,
				displayName: '{"en":"Large"}',
				nestedModifierGroupIds: JSON.stringify([extras!.id]),
			})
			.returning()
		const [extrasOption] = await db
			.insert(OrganizationMenuOption)
			.values({
				organizationId: organization.id,
				displayName: '{"en":"Cheese"}',
				nestedModifierGroupIds: JSON.stringify([]),
			})
			.returning()

		await db.insert(OrganizationMenuModifierGroupOptionAssignment).values([
			{
				modifierGroupId: size!.id,
				optionId: sizeOption!.id,
				position: 0,
			},
			{
				modifierGroupId: extras!.id,
				optionId: extrasOption!.id,
				position: 0,
			},
		])

		const failure = await checkModifierGraphChange(organization.id, {
			options: [
				{
					id: extrasOption!.id,
					nestedGroupIds: [size!.id],
				},
			],
		})

		expect(failure).toMatchObject({ reason: 'modifier_cycle' })
		expect(failure?.message).toContain('loop')
	})
})
