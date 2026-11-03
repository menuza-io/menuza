/**
 * Loyalty journey triggers: when a member's points reach a reward, come within
 * reach of one, or go quiet. The planner is pure: it reads the balance, the
 * rewards and what already fired, and says what to send now and what to
 * remember. It never touches a database.
 *
 * - `loyalty_reward_available`: the balance reached a reward's cost. One
 *   message per evaluation, for the dearest reward newly reached.
 * - `loyalty_near_reward`: the balance is at least `LOYALTY_NEAR_REWARD_PERCENT`
 *   of a reward's cost but below it. One message, for the cheapest such reward.
 * - A reward's trigger fires once, then waits for the balance to fall back out
 *   of its range (a redemption, a refund) before it can fire again.
 * - `loyalty_inactive`: the member has points and has not bought for
 *   `LOYALTY_INACTIVE_AFTER_DAYS`; once per quiet spell, which ends at the next
 *   purchase. Dormant members are left alone after `LOYALTY_INACTIVE_UNTIL_DAYS`.
 */

export const LOYALTY_NEAR_REWARD_PERCENT = 80
export const LOYALTY_INACTIVE_AFTER_DAYS = 30
export const LOYALTY_INACTIVE_UNTIL_DAYS = 180

export type LoyaltyRewardTrigger =
	'loyalty_reward_available' | 'loyalty_near_reward'

export type LoyaltyEmissionState = 'fired' | 'armed'

export type LoyaltyEmissionKnown = Array<{
	trigger: LoyaltyRewardTrigger
	rewardId: string
	state: LoyaltyEmissionState
}>

export type LoyaltyJourneyPlan = {
	/** Triggers to start now, at most one of each kind. */
	emit: Array<{ trigger: LoyaltyRewardTrigger; rewardId: string }>
	/** What to remember: `fired` after emitting, `armed` once back out of range. */
	remember: Array<{
		trigger: LoyaltyRewardTrigger
		rewardId: string
		state: LoyaltyEmissionState
	}>
}

export function planRewardJourneys(input: {
	available: number
	rewards: ReadonlyArray<{ id: string; pointsCost: number }>
	known: LoyaltyEmissionKnown
	/** Which triggers an active journey is listening to; others never start or fire, but a fired one still re-arms. */
	listening: ReadonlySet<LoyaltyRewardTrigger>
}): LoyaltyJourneyPlan {
	const state = new Map(
		input.known.map((row) => [`${row.trigger}:${row.rewardId}`, row.state]),
	)
	const remember: LoyaltyJourneyPlan['remember'] = []
	const newlyReached: Array<{ id: string; pointsCost: number }> = []
	const newlyNear: Array<{ id: string; pointsCost: number }> = []

	for (const reward of input.rewards) {
		const reached = input.available >= reward.pointsCost
		const near =
			!reached &&
			input.available * 100 >= reward.pointsCost * LOYALTY_NEAR_REWARD_PERCENT
		for (const [trigger, inRange, list] of [
			['loyalty_reward_available', reached, newlyReached],
			['loyalty_near_reward', near, newlyNear],
		] as const) {
			const listening = input.listening.has(trigger)
			const current = state.get(`${trigger}:${reward.id}`)
			if (inRange) {
				// Nothing listens: start nothing and remember nothing new, but
				// still reset below once the balance leaves the range.
				if (!listening) continue
				if (current === undefined || current === 'armed') {
					list.push(reward)
					remember.push({ trigger, rewardId: reward.id, state: 'fired' })
				}
			} else if (current === 'fired') {
				remember.push({ trigger, rewardId: reward.id, state: 'armed' })
			}
		}
	}

	const emit: LoyaltyJourneyPlan['emit'] = []
	const dearest = [...newlyReached].sort(
		(a, b) => b.pointsCost - a.pointsCost,
	)[0]
	if (dearest) {
		emit.push({ trigger: 'loyalty_reward_available', rewardId: dearest.id })
	}
	const cheapest = [...newlyNear].sort((a, b) => a.pointsCost - b.pointsCost)[0]
	if (cheapest) {
		emit.push({ trigger: 'loyalty_near_reward', rewardId: cheapest.id })
	}
	return { emit, remember }
}
