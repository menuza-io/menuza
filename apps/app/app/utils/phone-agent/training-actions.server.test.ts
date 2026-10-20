import { faker } from '@faker-js/faker'
import { db, eq, Organization, PhoneAgentTrainingRule } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordTrainingChange } from './settings-history.server.ts'
import { handleTrainingAction } from './training-actions.server.ts'

vi.mock('./settings-history.server.ts', () => ({
	recordTrainingChange: vi.fn(),
}))

async function createOrganization() {
	const [organization] = await db
		.insert(Organization)
		.values({
			name: faker.company.name(),
			slug: `actions-${Date.now()}-${faker.string.alphanumeric(6).toLowerCase()}`,
		})
		.returning()
	return organization!.id
}

async function createRule(organizationId: string) {
	const [rule] = await db
		.insert(PhoneAgentTrainingRule)
		.values({
			organizationId,
			category: 'order_flow',
			title: 'Rule',
			description: 'Do the thing.',
			isActive: true,
		})
		.returning()
	return rule!
}

function act(organizationId: string, body: unknown) {
	return handleTrainingAction({
		organizationId,
		userId: 'user',
		request: new Request('http://localhost/'),
		body,
	})
}

describe('handleTrainingAction', () => {
	beforeEach(() => {
		vi.mocked(recordTrainingChange).mockClear()
	})

	it('toggles and deletes a rule of the organization', async () => {
		const orgId = await createOrganization()
		const rule = await createRule(orgId)
		expect(
			await act(orgId, { intent: 'toggle-rule', id: rule.id, isActive: false }),
		).toEqual({ ok: true })
		expect(await act(orgId, { intent: 'delete-rule', id: rule.id })).toEqual({
			ok: true,
		})
		expect(recordTrainingChange).toHaveBeenCalledTimes(2)
	})

	it("refuses another organization's or a missing rule without logging", async () => {
		const orgId = await createOrganization()
		const otherOrgId = await createOrganization()
		const foreign = await createRule(otherOrgId)

		expect(
			await act(orgId, {
				intent: 'toggle-rule',
				id: foreign.id,
				isActive: false,
			}),
		).toEqual({ ok: false, error: 'conflict' })
		expect(await act(orgId, { intent: 'delete-rule', id: foreign.id })).toEqual(
			{ ok: false, error: 'conflict' },
		)
		expect(await act(orgId, { intent: 'delete-rule', id: 'missing' })).toEqual({
			ok: false,
			error: 'conflict',
		})
		expect(recordTrainingChange).not.toHaveBeenCalled()

		const [stored] = await db
			.select()
			.from(PhoneAgentTrainingRule)
			.where(eq(PhoneAgentTrainingRule.id, foreign.id))
		expect(stored?.isActive).toBe(true)
	})
})
