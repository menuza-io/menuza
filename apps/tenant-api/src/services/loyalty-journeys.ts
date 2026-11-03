import {
	LOYALTY_INACTIVE_AFTER_DAYS,
	LOYALTY_INACTIVE_UNTIL_DAYS,
	planRewardJourneys,
	type LoyaltyEmissionKnown,
	type LoyaltyRewardTrigger,
} from '@repo/loyalty'
import {
	getTenantDb,
	loyaltyBalances,
	loyaltyJourneyEmissions,
	loyaltyMembers,
	marketingJourneys,
	type LoyaltyJourneyTriggerType,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, inArray, isNotNull, lt, gte, or, sql } from 'drizzle-orm'
import { errorLogFields } from '../lib/error-log.ts'
import { withLoyaltyWrite } from '../lib/loyalty-write.ts'
import { readBalanceViewInTx } from './loyalty-ledger.ts'
import {
	activeRewardsInTx,
	readProgramInTx,
} from './loyalty-program-service.ts'

/**
 * Loyalty journeys: starts marketing journeys from a member's points. Three
 * triggers (`loyalty_reward_available`, `loyalty_near_reward`,
 * `loyalty_inactive`), each firing once per crossing or quiet spell. What the
 * planner decides is in `@repo/loyalty` (`journeys.ts`).
 *
 * The journey only starts here; whether anything is sent is decided by its
 * steps, which check the customer's marketing subscription again. The run
 * carries ids only (the reward id): the points and the reward's name are read
 * fresh when a message is built (`loyaltyMergeValues`), so a message sent
 * after a delay never shows a stale balance.
 */

const DAY_MS = 24 * 60 * 60_000
/** Most quiet members one tick starts; the rest wait for the next tick. */
export const LOYALTY_INACTIVE_BATCH = 50

const REWARD_TRIGGERS: readonly LoyaltyRewardTrigger[] = [
	'loyalty_reward_available',
	'loyalty_near_reward',
]

type JourneySpawner = (
	...args: Parameters<
		typeof import('./journey-service.ts').evaluateAndSpawnTriggers
	>
) => Promise<unknown>

let spawner: JourneySpawner | null = null

/** For tests: replaces the journey starter (`null` restores the real one). */
export function setLoyaltyJourneySpawner(next: JourneySpawner | null): void {
	spawner = next
}

/**
 * Starts the journeys for a trigger. The real starter is imported when used:
 * the journey service reaches the purchase service (which calls this module)
 * through its own imports, and a static import would close that loop.
 */
async function spawnJourneys(...args: Parameters<JourneySpawner>) {
	if (spawner) return spawner(...args)
	const { evaluateAndSpawnTriggers } = await import('./journey-service.ts')
	return evaluateAndSpawnTriggers(...args)
}

/** The loyalty triggers an active journey listens to. */
async function listeningTriggers(
	db: TenantDatabase,
	triggers: readonly LoyaltyJourneyTriggerType[],
): Promise<Set<LoyaltyJourneyTriggerType>> {
	const rows = await db
		.selectDistinct({ trigger: marketingJourneys.triggerType })
		.from(marketingJourneys)
		.where(
			and(
				eq(marketingJourneys.status, 'active'),
				or(...triggers.map((t) => eq(marketingJourneys.triggerType, t))),
			),
		)
		.all()
	return new Set(rows.map((row) => row.trigger as LoyaltyJourneyTriggerType))
}

const inFlight = new Set<Promise<void>>()

/**
 * Evaluates a member's reward journeys in the background, after a write that
 * changed their points. The sale that caused it never waits for it.
 */
export function scheduleRewardJourneys(orgId: string, memberId: string): void {
	const work = evaluateRewardJourneys(orgId, memberId).finally(() => {
		inFlight.delete(work)
	})
	inFlight.add(work)
}

/** Resolves once every background evaluation has finished (for tests and shutdown). */
export async function loyaltyJourneysIdle(): Promise<void> {
	while (inFlight.size > 0) await Promise.all(inFlight)
}

/**
 * After a member's points change: starts the reward journeys the new balance
 * calls for, and remembers what fired so it does not fire again until the
 * balance has left the range and come back. Never throws.
 */
export async function evaluateRewardJourneys(
	orgId: string,
	memberId: string,
	options: { now?: number } = {},
): Promise<void> {
	try {
		const db = await getTenantDb(orgId)
		const listening = (await listeningTriggers(
			db,
			REWARD_TRIGGERS,
		)) as Set<LoyaltyRewardTrigger>
		// Nothing listening is not a reason to stop tracking: a stored `fired`
		// state must still re-arm once the member is out of range (the planner
		// starts and fires nothing for a trigger no journey listens to). A cheap
		// read skips the write transaction when there is nothing to re-arm.
		if (listening.size === 0) {
			const fired = await db
				.select({ memberId: loyaltyJourneyEmissions.memberId })
				.from(loyaltyJourneyEmissions)
				.where(
					and(
						eq(loyaltyJourneyEmissions.memberId, memberId),
						inArray(loyaltyJourneyEmissions.trigger, [...REWARD_TRIGGERS]),
						eq(loyaltyJourneyEmissions.state, 'fired'),
					),
				)
				.limit(1)
				.get()
			if (!fired) return
		}

		const decision = await withLoyaltyWrite(
			{ orgId, now: options.now },
			async (tx, ctx) => {
				const program = await readProgramInTx(tx)
				if (!program || program.program.status !== 'active') return null
				const member = await tx
					.select({
						id: loyaltyMembers.id,
						status: loyaltyMembers.status,
						customerId: loyaltyMembers.customerId,
					})
					.from(loyaltyMembers)
					.where(eq(loyaltyMembers.id, memberId))
					.get()
				if (!member || member.status !== 'active' || !member.customerId) {
					return null
				}
				const balance = await readBalanceViewInTx(tx, member.id)
				const rewards = (await activeRewardsInTx(tx))
					.filter((reward) => reward.currency === program.program.currency)
					.map((reward) => ({
						id: reward.rewardId,
						pointsCost: reward.definition.pointsCost,
					}))
				const known = (await tx
					.select({
						trigger: loyaltyJourneyEmissions.trigger,
						rewardId: loyaltyJourneyEmissions.ref,
						state: loyaltyJourneyEmissions.state,
					})
					.from(loyaltyJourneyEmissions)
					.where(
						and(
							eq(loyaltyJourneyEmissions.memberId, member.id),
							inArray(loyaltyJourneyEmissions.trigger, [...REWARD_TRIGGERS]),
						),
					)
					.all()) as LoyaltyEmissionKnown
				const plan = planRewardJourneys({
					available: balance.available,
					rewards,
					known,
					listening,
				})
				for (const entry of plan.remember) {
					await tx
						.insert(loyaltyJourneyEmissions)
						.values({
							memberId: member.id,
							trigger: entry.trigger,
							ref: entry.rewardId,
							state: entry.state,
							emittedAt: ctx.now,
						})
						.onConflictDoUpdate({
							target: [
								loyaltyJourneyEmissions.memberId,
								loyaltyJourneyEmissions.trigger,
								loyaltyJourneyEmissions.ref,
							],
							set: { state: entry.state, emittedAt: ctx.now },
						})
				}
				return { customerId: member.customerId, emit: plan.emit }
			},
		)
		if (!decision) return
		for (const entry of decision.emit) {
			await spawnJourneys(
				orgId,
				entry.trigger,
				decision.customerId,
				undefined,
				{ rewardId: entry.rewardId },
			)
		}
	} catch (error) {
		// Ids and error codes only; points and customers stay out of the log.
		console.error('Loyalty journeys could not be evaluated', {
			orgId,
			memberId,
			...errorLogFields(error),
		})
	}
}

/**
 * The tick's part: members with points who have not bought for a while start
 * `loyalty_inactive` once per quiet spell (the spell ends at their next
 * purchase). Bounded per call; whatever is left waits for the next tick.
 */
export async function runInactiveJourneys(
	orgId: string,
	options: { now?: number } = {},
): Promise<{ started: number }> {
	const now = options.now ?? Date.now()
	try {
		const db = await getTenantDb(orgId)
		const listening = await listeningTriggers(db, ['loyalty_inactive'])
		if (listening.size === 0) return { started: 0 }
		const program = await readProgramInTx(db)
		if (!program || program.program.status !== 'active') return { started: 0 }

		const quietBefore = now - LOYALTY_INACTIVE_AFTER_DAYS * DAY_MS
		const dormantBefore = now - LOYALTY_INACTIVE_UNTIL_DAYS * DAY_MS
		const candidates = await db
			.select({
				memberId: loyaltyMembers.id,
				customerId: loyaltyMembers.customerId,
				lastPurchaseAt: loyaltyMembers.lastPurchaseAt,
			})
			.from(loyaltyMembers)
			.innerJoin(
				loyaltyBalances,
				eq(loyaltyBalances.memberId, loyaltyMembers.id),
			)
			.where(
				and(
					eq(loyaltyMembers.status, 'active'),
					isNotNull(loyaltyMembers.customerId),
					isNotNull(loyaltyMembers.lastPurchaseAt),
					lt(loyaltyMembers.lastPurchaseAt, quietBefore),
					gte(loyaltyMembers.lastPurchaseAt, dormantBefore),
					sql`${loyaltyBalances.points} - ${loyaltyBalances.reserved} > 0`,
					sql`not exists (select 1 from ${loyaltyJourneyEmissions} where ${loyaltyJourneyEmissions.memberId} = ${loyaltyMembers.id} and ${loyaltyJourneyEmissions.trigger} = 'loyalty_inactive' and ${loyaltyJourneyEmissions.ref} = cast(${loyaltyMembers.lastPurchaseAt} as text))`,
				),
			)
			.orderBy(asc(loyaltyMembers.lastPurchaseAt))
			.limit(LOYALTY_INACTIVE_BATCH)
			.all()

		let started = 0
		for (const row of candidates) {
			if (!row.customerId || row.lastPurchaseAt === null) continue
			try {
				// Spawn first, record after: a failed spawn leaves no emission row,
				// so the member is retried on the next tick, and one failure never
				// aborts the rest of the batch. A crash between the two repeats one
				// start at most (the journey run dedupes on its own).
				await spawnJourneys(
					orgId,
					'loyalty_inactive',
					row.customerId,
					undefined,
					{},
				)
				const inserted = await db
					.insert(loyaltyJourneyEmissions)
					.values({
						memberId: row.memberId,
						trigger: 'loyalty_inactive',
						ref: String(row.lastPurchaseAt),
						state: 'fired',
						emittedAt: now,
					})
					.onConflictDoNothing()
					.returning({ memberId: loyaltyJourneyEmissions.memberId })
				if (inserted.length > 0) started += 1
			} catch (error) {
				console.error('Loyalty inactive journey could not start', {
					orgId,
					memberId: row.memberId,
					...errorLogFields(error),
				})
			}
		}
		return { started }
	} catch (error) {
		console.error('Loyalty inactive journeys could not run', {
			orgId,
			...errorLogFields(error),
		})
		return { started: 0 }
	}
}
