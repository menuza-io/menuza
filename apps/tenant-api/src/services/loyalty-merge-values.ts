import { getTenantDb, loyaltyMembers } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { readBalanceViewInTx } from './loyalty-ledger.ts'
import { activeRewardsInTx } from './loyalty-program-service.ts'

export type LoyaltyMergeValues = {
	pointsBalance: string
	pointsToNextReward: string
	rewardName: string
}

/**
 * The loyalty merge tags for one customer, read when a message is built:
 * `{{pointsBalance}}`, `{{rewardName}}` (the reward the journey is about, else
 * the best one within reach, else the cheapest) and `{{pointsToNextReward}}`
 * (what that reward still needs, never below zero). Empty strings when the
 * customer has no account, so a tag's fallback text shows instead.
 */
export async function loyaltyMergeValues(
	orgId: string,
	customerId: string,
	rewardId?: string | null,
): Promise<Partial<LoyaltyMergeValues>> {
	const db = await getTenantDb(orgId)
	const member = await db
		.select({ id: loyaltyMembers.id, status: loyaltyMembers.status })
		.from(loyaltyMembers)
		.where(eq(loyaltyMembers.customerId, customerId))
		.get()
	if (!member || member.status !== 'active') return {}
	const balance = await readBalanceViewInTx(db, member.id)
	const rewards = (await activeRewardsInTx(db)).map((reward) => ({
		id: reward.rewardId,
		name: reward.definition.name,
		pointsCost: reward.definition.pointsCost,
	}))
	const named = rewardId
		? rewards.find((reward) => reward.id === rewardId)
		: null
	const affordable = rewards.filter(
		(reward) => reward.pointsCost <= balance.available,
	)
	const target = named ?? affordable.at(-1) ?? rewards[0] ?? null
	return {
		pointsBalance: String(balance.available),
		...(target
			? {
					rewardName: target.name,
					pointsToNextReward: String(
						Math.max(0, target.pointsCost - balance.available),
					),
				}
			: {}),
	}
}
