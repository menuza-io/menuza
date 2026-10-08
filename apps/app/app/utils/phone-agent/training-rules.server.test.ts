import { faker } from '@faker-js/faker'
import { db, Organization, PhoneAgentTrainingRule } from '@repo/database'
import { MAX_TRAINING_RULES } from '@repo/phone-agent'
import { describe, expect, it } from 'vitest'
import {
	canAddTrainingRule,
	countTrainingRules,
} from './training-rules.server.ts'

async function createOrganization() {
	const [organization] = await db
		.insert(Organization)
		.values({
			name: faker.company.name(),
			slug: `rules-${Date.now()}-${faker.string.alphanumeric(6).toLowerCase()}`,
		})
		.returning()
	return organization!.id
}

function rules(organizationId: string, total: number, isActive = true) {
	return Array.from({ length: total }, (ignoredValue, index) => ({
		organizationId,
		category: 'order_flow',
		title: `Rule ${index}`,
		description: 'Do the thing.',
		isActive,
	}))
}

describe('canAddTrainingRule', () => {
	it('allows rules up to the cap, counting inactive ones', async () => {
		const orgId = await createOrganization()
		const otherOrgId = await createOrganization()
		await db
			.insert(PhoneAgentTrainingRule)
			.values(rules(otherOrgId, MAX_TRAINING_RULES))
		await db
			.insert(PhoneAgentTrainingRule)
			.values(rules(orgId, MAX_TRAINING_RULES - 2))
		expect(await canAddTrainingRule(orgId)).toBe(true)

		await db.insert(PhoneAgentTrainingRule).values(rules(orgId, 2, false))
		expect(await countTrainingRules(orgId)).toBe(MAX_TRAINING_RULES)
		expect(await canAddTrainingRule(orgId)).toBe(false)
	})
})
