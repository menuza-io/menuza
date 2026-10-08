import { count, db, eq, PhoneAgentTrainingRule } from '@repo/database'
import { MAX_TRAINING_RULES } from '@repo/phone-agent'

export async function countTrainingRules(organizationId: string) {
	const [row] = await db
		.select({ value: count() })
		.from(PhoneAgentTrainingRule)
		.where(eq(PhoneAgentTrainingRule.organizationId, organizationId))
	return row?.value ?? 0
}

/** Inactive rules count too, so turning rules off can't lift the cap. */
export async function canAddTrainingRule(organizationId: string) {
	return (await countTrainingRules(organizationId)) < MAX_TRAINING_RULES
}
