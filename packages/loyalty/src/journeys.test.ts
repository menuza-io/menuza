import { describe, expect, it } from 'vitest'
import { planRewardJourneys, type LoyaltyEmissionKnown } from './journeys.ts'

const rewards = [
	{ id: 'coffee', pointsCost: 100 },
	{ id: 'meal', pointsCost: 250 },
]
const both = new Set([
	'loyalty_reward_available',
	'loyalty_near_reward',
] as const)

function plan(available: number, known: LoyaltyEmissionKnown = []) {
	return planRewardJourneys({ available, rewards, known, listening: both })
}

describe('reward journey planner', () => {
	it('does nothing for a member far from every reward', () => {
		expect(plan(10)).toEqual({ emit: [], remember: [] })
	})

	it('fires near_reward at 80% of the cost, not at 79%', () => {
		expect(plan(79).emit).toEqual([])
		expect(plan(80).emit).toEqual([
			{ trigger: 'loyalty_near_reward', rewardId: 'coffee' },
		])
	})

	it('fires reward_available when the cost is reached, and stops being near', () => {
		const first = plan(90)
		expect(first.emit).toEqual([
			{ trigger: 'loyalty_near_reward', rewardId: 'coffee' },
		])
		const second = plan(100, [
			{ trigger: 'loyalty_near_reward', rewardId: 'coffee', state: 'fired' },
		])
		expect(second.emit).toEqual([
			{ trigger: 'loyalty_reward_available', rewardId: 'coffee' },
		])
		// The near trigger re-arms because the member is no longer near.
		expect(second.remember).toContainEqual({
			trigger: 'loyalty_near_reward',
			rewardId: 'coffee',
			state: 'armed',
		})
	})

	it('fires once per crossing: more earning above the cost sends nothing', () => {
		const known: LoyaltyEmissionKnown = [
			{
				trigger: 'loyalty_reward_available',
				rewardId: 'coffee',
				state: 'fired',
			},
		]
		expect(plan(120, known).emit).toEqual([])
		expect(plan(120, known).remember).toEqual([])
	})

	it('fires again after the balance drops below the cost and comes back', () => {
		const fired: LoyaltyEmissionKnown = [
			{
				trigger: 'loyalty_reward_available',
				rewardId: 'coffee',
				state: 'fired',
			},
		]
		const dropped = plan(20, fired)
		expect(dropped.emit).toEqual([])
		expect(dropped.remember).toContainEqual({
			trigger: 'loyalty_reward_available',
			rewardId: 'coffee',
			state: 'armed',
		})
		const back = plan(105, [
			{
				trigger: 'loyalty_reward_available',
				rewardId: 'coffee',
				state: 'armed',
			},
		])
		expect(back.emit).toEqual([
			{ trigger: 'loyalty_reward_available', rewardId: 'coffee' },
		])
	})

	it('one message per kind when a member jumps over several rewards: the dearest reached', () => {
		const result = plan(300)
		expect(result.emit).toEqual([
			{ trigger: 'loyalty_reward_available', rewardId: 'meal' },
		])
		// Both rewards are remembered, so the cheaper one does not fire later.
		expect(result.remember).toEqual(
			expect.arrayContaining([
				{
					trigger: 'loyalty_reward_available',
					rewardId: 'coffee',
					state: 'fired',
				},
				{
					trigger: 'loyalty_reward_available',
					rewardId: 'meal',
					state: 'fired',
				},
			]),
		)
	})

	it('near_reward names the cheapest reward in range', () => {
		expect(
			planRewardJourneys({
				available: 95,
				rewards: [
					{ id: 'b', pointsCost: 110 },
					{ id: 'a', pointsCost: 100 },
				],
				known: [],
				listening: both,
			}).emit,
		).toEqual([{ trigger: 'loyalty_near_reward', rewardId: 'a' }])
	})

	it('plans nothing for a trigger no active journey listens to', () => {
		const result = planRewardJourneys({
			available: 100,
			rewards,
			known: [],
			listening: new Set(['loyalty_near_reward'] as const),
		})
		expect(result.emit).toEqual([])
		expect(
			result.remember.every((row) => row.trigger === 'loyalty_near_reward'),
		).toBe(true)
	})
})
