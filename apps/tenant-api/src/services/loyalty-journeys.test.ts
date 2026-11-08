import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sendSms } from '@repo/sms'
import {
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	journeyStepExecutions,
	loyaltyJourneyEmissions,
	loyaltyMembers,
	marketingJourneys,
	provisionTenantDb,
	type LoyaltyJourneyTriggerType,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	evaluateAndSpawnTriggers,
	executeJourneyStep,
} from './journey-service.ts'
import {
	evaluateRewardJourneys,
	loyaltyJourneysIdle,
	LOYALTY_INACTIVE_BATCH,
	LOYALTY_PENDING_STALE_MS,
	retryPendingRewardJourneys,
	runInactiveJourneys,
	setLoyaltyJourneySpawner,
} from './loyalty-journeys.ts'
import { loyaltyMergeValues } from './loyalty-merge-values.ts'
import { reconcileLoyaltySource } from './loyalty-purchase-service.ts'
import {
	activateProgram,
	assertBalancesMatchLedger,
	balanceOf,
	claimAndQueue,
	givePoints,
	insertCustomer,
	insertOrder,
	makeMember,
	makeReward,
	NOW,
	rewardDefinition,
} from './loyalty-test-fixture.ts'
import { recordOrderRefund } from './order-refund-service.ts'

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true, sid: 'sid', mock: true }),
}))
const spawn = vi.fn().mockResolvedValue([])
const sms = vi.mocked(sendSms)

const ORG = 'org_ll_journeys'
const DAY = 24 * 60 * 60_000

let directory: string
let coffeeId: string
let mealId: string
let customerCounter = 0
let keyCounter = 0

async function journey(
	triggerType: LoyaltyJourneyTriggerType,
	status: 'active' | 'paused' | 'draft' = 'active',
) {
	const db = await getTenantDb(ORG)
	const [row] = await db
		.insert(marketingJourneys)
		.values({ name: `J ${triggerType}`, status, triggerType })
		.returning()
	return row!
}

async function member(points = 0) {
	const customerId = `cus_${++customerCounter}`
	await insertCustomer(ORG, {
		id: customerId,
		name: 'Ada Lovelace',
		phone: `+155500${String(customerCounter).padStart(5, '0')}`,
		verified: true,
	})
	const memberId = await makeMember(ORG, { customerId })
	if (points > 0) await givePoints(ORG, memberId, points)
	return { memberId, customerId }
}

/** A paid 1000-minor order claimed and settled: 10 points. */
async function earnTen(memberId: string) {
	const orderId = await insertOrder(ORG)
	const source = { type: 'restaurant_order' as const, id: orderId }
	await claimAndQueue(ORG, { memberId, source })
	await reconcileLoyaltySource(ORG, source, { now: NOW })
	// The background evaluation this sale started finishes before the next write.
	await loyaltyJourneysIdle()
	return orderId
}

async function emissionsOf(memberId: string) {
	const db = await getTenantDb(ORG)
	return db
		.select()
		.from(loyaltyJourneyEmissions)
		.where(eq(loyaltyJourneyEmissions.memberId, memberId))
		.all()
}

async function setLastPurchase(memberId: string, at: number | null) {
	const db = await getTenantDb(ORG)
	await db
		.update(loyaltyMembers)
		.set({ lastPurchaseAt: at })
		.where(eq(loyaltyMembers.id, memberId))
}

beforeEach(async () => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'loyalty-journeys-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'test-internal-token-123456789')
	await provisionTenantDb(ORG)
	await activateProgram(ORG)
	coffeeId = (
		await makeReward(ORG, rewardDefinition({ name: 'Coffee', pointsCost: 25 }))
	).id
	mealId = (
		await makeReward(ORG, rewardDefinition({ name: 'Meal', pointsCost: 100 }))
	).id
	spawn.mockClear()
	sms.mockClear()
	// Starting a run would call the workflow worker.
	setLoyaltyJourneySpawner(spawn)
})

afterEach(async () => {
	setLoyaltyJourneySpawner(null)
	try {
		await assertBalancesMatchLedger(ORG)
	} finally {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(directory, { recursive: true, force: true })
		vi.unstubAllEnvs()
	}
})

describe('reward journeys', () => {
	it('start once when earning takes the balance to a reward, not on every sale after', async () => {
		await journey('loyalty_reward_available')
		const { memberId, customerId } = await member()
		await earnTen(memberId) // 10
		await earnTen(memberId) // 20
		await vi.waitFor(async () => {
			expect((await balanceOf(ORG, memberId)).available).toBe(20)
		})
		expect(spawn).not.toHaveBeenCalled()

		await earnTen(memberId) // 30: the coffee (25) is reached
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
		expect(spawn).toHaveBeenCalledWith(
			ORG,
			'loyalty_reward_available',
			customerId,
			undefined,
			{ rewardId: coffeeId },
		)

		await earnTen(memberId) // 40: still above, nothing new
		await evaluateRewardJourneys(ORG, memberId)
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it('near_reward starts when the balance gets within 80% of the cheapest reward', async () => {
		await journey('loyalty_near_reward')
		const { memberId, customerId } = await member()
		await earnTen(memberId) // 10 of 25: not near
		await evaluateRewardJourneys(ORG, memberId)
		expect(spawn).not.toHaveBeenCalled()
		await earnTen(memberId) // 20 = 80% of 25
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
		expect(spawn).toHaveBeenCalledWith(
			ORG,
			'loyalty_near_reward',
			customerId,
			undefined,
			{ rewardId: coffeeId },
		)
	})

	it('fire again after a refund takes the member back out of range', async () => {
		await journey('loyalty_reward_available')
		const { memberId } = await member()
		await earnTen(memberId)
		await earnTen(memberId)
		const third = await earnTen(memberId) // 30: fires
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))

		const refund = await recordOrderRefund(ORG, third, {
			request: { full: true, note: 'Returned' },
			actorId: 'op_test',
			idempotencyKey: `journeys-refund-${++keyCounter}`,
			loyaltyAccess: { refundLoyalty: true, impersonated: false },
			now: NOW,
		})
		expect(refund.ok).toBe(true)
		await vi.waitFor(async () => {
			const rows = await emissionsOf(memberId)
			expect(rows.find((row) => row.ref === coffeeId)?.state).toBe('armed')
		})

		await earnTen(memberId) // back to 30
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
	})

	it('start nothing, and remember nothing, without an active journey for the trigger', async () => {
		await journey('loyalty_reward_available', 'paused')
		await journey('loyalty_near_reward', 'draft')
		const { memberId } = await member(30)
		await evaluateRewardJourneys(ORG, memberId)
		expect(spawn).not.toHaveBeenCalled()
		expect(await emissionsOf(memberId)).toEqual([])
	})

	it('re-arms a fired state once out of range even when no journey listens', async () => {
		await journey('loyalty_reward_available')
		const { memberId } = await member()
		await earnTen(memberId)
		await earnTen(memberId)
		const third = await earnTen(memberId) // 30: fires
		await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
		const db = await getTenantDb(ORG)
		await db
			.update(marketingJourneys)
			.set({ status: 'paused' })
			.where(eq(marketingJourneys.triggerType, 'loyalty_reward_available'))
		await recordOrderRefund(ORG, third, {
			request: { full: true, note: 'Returned' },
			actorId: 'op_test',
			idempotencyKey: `journeys-refund-${++keyCounter}`,
			loyaltyAccess: { refundLoyalty: true, impersonated: false },
			now: NOW,
		})
		await loyaltyJourneysIdle()
		await evaluateRewardJourneys(ORG, memberId)
		const rows = await emissionsOf(memberId)
		expect(rows.find((row) => row.ref === coffeeId)?.state).toBe('armed')
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it('one message when a member jumps over several rewards: the dearest', async () => {
		await journey('loyalty_reward_available')
		const { memberId } = await member(150)
		await evaluateRewardJourneys(ORG, memberId)
		expect(spawn).toHaveBeenCalledTimes(1)
		expect(spawn.mock.calls[0]![4]).toEqual({ rewardId: mealId })
		// The cheaper reward is remembered too, so it never fires later.
		await evaluateRewardJourneys(ORG, memberId)
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it('never starts for a suspended member', async () => {
		await journey('loyalty_reward_available')
		const { memberId } = await member(30)
		const db = await getTenantDb(ORG)
		await db
			.update(loyaltyMembers)
			.set({ status: 'suspended' })
			.where(eq(loyaltyMembers.id, memberId))
		await evaluateRewardJourneys(ORG, memberId)
		expect(spawn).not.toHaveBeenCalled()
	})

	it('a failure in the journey service is logged and never thrown', async () => {
		await journey('loyalty_reward_available')
		const { memberId } = await member(30)
		spawn.mockRejectedValueOnce(new Error('worker down'))
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		await expect(evaluateRewardJourneys(ORG, memberId)).resolves.toBeUndefined()
		expect(JSON.stringify(log.mock.calls)).not.toContain('+1555')
		log.mockRestore()
	})
})

describe('reward journeys: spawn before fired', () => {
	it('a failed start leaves no fired state and retries on the next evaluation', async () => {
		await journey('loyalty_reward_available')
		const { memberId } = await member(30)
		spawn.mockRejectedValueOnce(new Error('worker down'))
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		await evaluateRewardJourneys(ORG, memberId)
		log.mockRestore()
		expect(
			(await emissionsOf(memberId)).filter((r) => r.state === 'fired'),
		).toEqual([])
		await evaluateRewardJourneys(ORG, memberId)
		expect(spawn).toHaveBeenCalledTimes(2)
		const rows = await emissionsOf(memberId)
		expect(rows.find((r) => r.ref === coffeeId)?.state).toBe('fired')
	})

	it('records pending while the start runs, and fired after', async () => {
		await journey('loyalty_reward_available')
		const { memberId } = await member(30)
		let seen: string | undefined
		spawn.mockImplementationOnce(async () => {
			seen = (await emissionsOf(memberId)).find(
				(r) => r.ref === coffeeId,
			)?.state
		})
		await evaluateRewardJourneys(ORG, memberId)
		expect(seen).toBe('pending')
		expect((await emissionsOf(memberId))[0]?.state).toBe('fired')
	})

	it('concurrent evaluations start the journey once', async () => {
		await journey('loyalty_reward_available')
		const { memberId } = await member(30)
		await Promise.all([
			evaluateRewardJourneys(ORG, memberId),
			evaluateRewardJourneys(ORG, memberId),
			evaluateRewardJourneys(ORG, memberId),
		])
		expect(spawn).toHaveBeenCalledTimes(1)
	})

	it('a stale pending (start never finished) is retried by the tick', async () => {
		await journey('loyalty_reward_available')
		const { memberId } = await member(30)
		const db = await getTenantDb(ORG)
		await db.insert(loyaltyJourneyEmissions).values({
			memberId,
			trigger: 'loyalty_reward_available',
			ref: coffeeId,
			state: 'pending' as 'fired',
			emittedAt: NOW,
		})
		await evaluateRewardJourneys(ORG, memberId, { now: NOW + 1000 })
		expect(spawn).not.toHaveBeenCalled() // fresh pending blocks
		await retryPendingRewardJourneys(ORG, {
			now: NOW + LOYALTY_PENDING_STALE_MS + 1,
		})
		expect(spawn).toHaveBeenCalledTimes(1)
		expect((await emissionsOf(memberId))[0]?.state).toBe('fired')
	})
})

describe('inactive journeys', () => {
	const LAST = NOW - 40 * DAY

	it('start once per quiet spell, and again after the member buys', async () => {
		await journey('loyalty_inactive')
		const { memberId, customerId } = await member(15)
		await setLastPurchase(memberId, LAST)

		expect(await runInactiveJourneys(ORG, { now: NOW })).toEqual({ started: 1 })
		expect(spawn).toHaveBeenCalledWith(
			ORG,
			'loyalty_inactive',
			customerId,
			undefined,
			{},
		)
		// The same quiet spell never fires twice.
		expect(await runInactiveJourneys(ORG, { now: NOW + DAY })).toEqual({
			started: 0,
		})

		// They buy, then go quiet again: a new spell.
		await setLastPurchase(memberId, NOW + DAY)
		expect(await runInactiveJourneys(ORG, { now: NOW + 40 * DAY })).toEqual({
			started: 1,
		})
		expect(spawn).toHaveBeenCalledTimes(2)
	})

	it('wait until the member has been quiet for 30 days and leave dormant members alone', async () => {
		await journey('loyalty_inactive')
		const recent = await member(15)
		await setLastPurchase(recent.memberId, NOW - 29 * DAY)
		const dormant = await member(15)
		await setLastPurchase(dormant.memberId, NOW - 181 * DAY)
		const neverBought = await member(15)
		await setLastPurchase(neverBought.memberId, null)
		expect(await runInactiveJourneys(ORG, { now: NOW })).toEqual({ started: 0 })
		expect(spawn).not.toHaveBeenCalled()
	})

	it('need points to be worth a message', async () => {
		await journey('loyalty_inactive')
		const { memberId } = await member(0)
		await setLastPurchase(memberId, LAST)
		expect(await runInactiveJourneys(ORG, { now: NOW })).toEqual({ started: 0 })
	})

	it('a failed start leaves no emission, does not abort the batch, and is retried', async () => {
		await journey('loyalty_inactive')
		const first = await member(15)
		const second = await member(15)
		await setLastPurchase(first.memberId, LAST - 1)
		await setLastPurchase(second.memberId, LAST)
		spawn.mockRejectedValueOnce(new Error('worker down'))
		const log = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(await runInactiveJourneys(ORG, { now: NOW })).toEqual({ started: 1 })
		log.mockRestore()
		expect(await emissionsOf(first.memberId)).toEqual([])
		expect(await emissionsOf(second.memberId)).toHaveLength(1)
		// Next tick retries only the one that failed.
		expect(await runInactiveJourneys(ORG, { now: NOW })).toEqual({ started: 1 })
		expect(await emissionsOf(first.memberId)).toHaveLength(1)
		expect(await runInactiveJourneys(ORG, { now: NOW })).toEqual({ started: 0 })
	})

	it('do nothing without an active journey', async () => {
		const { memberId } = await member(15)
		await setLastPurchase(memberId, LAST)
		expect(await runInactiveJourneys(ORG, { now: NOW })).toEqual({ started: 0 })
		expect(await emissionsOf(memberId)).toEqual([])
	})

	it('start at most one batch a tick; the rest wait for the next', async () => {
		await journey('loyalty_inactive')
		for (let i = 0; i < LOYALTY_INACTIVE_BATCH + 3; i++) {
			const { memberId } = await member(15)
			await setLastPurchase(memberId, LAST - i)
		}
		const first = await runInactiveJourneys(ORG, { now: NOW })
		expect(first.started).toBe(LOYALTY_INACTIVE_BATCH)
		const second = await runInactiveJourneys(ORG, { now: NOW })
		expect(second.started).toBe(3)
	})
})

describe('loyalty merge values', () => {
	it('reads the balance and the reward the journey is about', async () => {
		const { customerId } = await member(12)
		expect(await loyaltyMergeValues(ORG, customerId, coffeeId)).toEqual({
			pointsBalance: '12',
			rewardName: 'Coffee',
			pointsToNextReward: '13',
		})
	})

	it('without a named reward: the best one within reach, else the cheapest', async () => {
		const rich = await member(120)
		expect(await loyaltyMergeValues(ORG, rich.customerId)).toMatchObject({
			rewardName: 'Meal',
			pointsToNextReward: '0',
		})
		const poor = await member(3)
		expect(await loyaltyMergeValues(ORG, poor.customerId)).toMatchObject({
			rewardName: 'Coffee',
			pointsToNextReward: '22',
		})
	})

	it('is empty for a customer with no points account, so a fallback shows', async () => {
		await insertCustomer(ORG, { id: 'cus_nobody', verified: false })
		expect(await loyaltyMergeValues(ORG, 'cus_nobody')).toEqual({})
	})
})

describe('a loyalty journey step', () => {
	it('fills the points tags from the account as it is when the message is built', async () => {
		const { customerId, memberId } = await member(12)
		const db = await getTenantDb(ORG)
		const [row] = await db
			.insert(marketingJourneys)
			.values({
				name: 'Near',
				status: 'active',
				triggerType: 'loyalty_near_reward',
			})
			.returning()
		const [run] = await db
			.insert(journeyRuns)
			.values({
				journeyId: row!.id,
				customerId,
				triggerEvent: 'loyalty_near_reward',
				contextData: JSON.stringify({ rewardId: coffeeId }),
			})
			.returning()
		await db.insert(customerSubscriptions).values({
			customerId,
			topic: 'marketing',
			channel: 'sms',
			source: 'operator',
			subscribedAt: new Date(),
		})
		// The balance moves after the run started: the message shows the new one.
		await givePoints(ORG, memberId, 8)

		const result = await executeJourneyStep(ORG, {
			orgId: ORG,
			journeyId: row!.id,
			runId: run!.id,
			customerId,
			nodeId: 'sms-1',
			nodeType: 'action_sms',
			config: {
				messageText:
					'{{firstName}}, {{pointsToNextReward}} more for {{rewardName}} (you have {{pointsBalance}})',
			},
		})
		expect(result.success).toBe(true)
		expect(sms).toHaveBeenCalledTimes(1)
		expect(sms.mock.calls[0]![0].message).toBe(
			'Ada, 5 more for Coffee (you have 20)',
		)
	})

	it('skips, and records the skip, for a member without marketing consent', async () => {
		const { customerId } = await member(12)
		const db = await getTenantDb(ORG)
		const [row] = await db
			.insert(marketingJourneys)
			.values({
				name: 'Near',
				status: 'active',
				triggerType: 'loyalty_near_reward',
			})
			.returning()
		const [run] = await db
			.insert(journeyRuns)
			.values({
				journeyId: row!.id,
				customerId,
				triggerEvent: 'loyalty_near_reward',
			})
			.returning()
		const result = await executeJourneyStep(ORG, {
			orgId: ORG,
			journeyId: row!.id,
			runId: run!.id,
			customerId,
			nodeId: 'sms-1',
			nodeType: 'action_sms',
			config: { messageText: 'Hi' },
		})
		expect(result).toMatchObject({ success: true, status: 'skipped' })
		expect(sms).not.toHaveBeenCalled()
		const steps = await db.select().from(journeyStepExecutions).all()
		expect(steps).toHaveLength(1)
		expect(steps[0]!.status).toBe('skipped')
	})

	it('leaves a non-loyalty journey alone: the loyalty tags stay as written', async () => {
		const { customerId } = await member(12)
		const db = await getTenantDb(ORG)
		const [row] = await db
			.insert(marketingJourneys)
			.values({
				name: 'Welcome',
				status: 'active',
				triggerType: 'phone_verified',
			})
			.returning()
		const [run] = await db
			.insert(journeyRuns)
			.values({
				journeyId: row!.id,
				customerId,
				triggerEvent: 'phone_verified',
			})
			.returning()
		// Every journey needs marketing consent for its channel.
		await db.insert(customerSubscriptions).values({
			customerId,
			topic: 'marketing',
			channel: 'sms',
			source: 'operator',
			subscribedAt: new Date(),
		})
		await executeJourneyStep(ORG, {
			orgId: ORG,
			journeyId: row!.id,
			runId: run!.id,
			customerId,
			nodeId: 'sms-1',
			nodeType: 'action_sms',
			config: { messageText: 'You have {{pointsBalance|some}} points' },
		})
		expect(sms.mock.calls[0]![0].message).toBe('You have some points')
	})
})
