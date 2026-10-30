import {
	EMPTY_LOYALTY_BALANCE,
	isValidLedgerDelta,
	LOYALTY_HOLDING_STATES,
	LoyaltyDomainError,
	rebuildLoyaltyBalance,
	type LoyaltyActorKind,
	type LoyaltyAdjustmentReason,
	type LoyaltyBalance,
	type LoyaltyOperatorBalance,
	type LoyaltyBalanceView,
	type LoyaltyChannel,
	type LoyaltyLedgerType,
} from '@repo/loyalty'
import {
	loyaltyBalances,
	loyaltyLedger,
	loyaltyRedemptions,
} from '@repo/tenant-db'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { inJsonList, MAX_IN_CHUNK, queryInChunks } from '../lib/chunked-in.ts'
import { type LoyaltyReader, type LoyaltyTx } from '../lib/loyalty-write.ts'

/**
 * The points ledger and its balance projection. An entry and the balance
 * change it causes are written in the same transaction; the unique event key
 * makes posting the same fact twice a no-op. `reserved` is the sum of the
 * points held by redemptions that are reserved, bound or in review.
 */

export type LedgerEntryInput = {
	memberId: string
	type: LoyaltyLedgerType
	delta: number
	eventKey: string
	purchaseId?: string | null
	redemptionId?: string | null
	channel?: LoyaltyChannel | null
	locationId?: string | null
	programVersion?: number | null
	reason?: LoyaltyAdjustmentReason | null
	note?: string | null
	actorKind: LoyaltyActorKind
	actorId?: string | null
	at: number
}

export async function ensureBalanceRowInTx(
	tx: LoyaltyTx,
	memberId: string,
	at: number,
): Promise<void> {
	await tx
		.insert(loyaltyBalances)
		.values({ memberId, updatedAt: at })
		.onConflictDoNothing()
}

/**
 * Posts one ledger entry and applies it to the balance. Returns the existing
 * entry, untouched, when the event key was already posted.
 */
export async function postLedgerEntryInTx(
	tx: LoyaltyTx,
	input: LedgerEntryInput,
): Promise<{ id: string; inserted: boolean }> {
	if (!isValidLedgerDelta(input.type, input.delta)) {
		throw new LoyaltyDomainError('adjustment_invalid')
	}
	const inserted = await tx
		.insert(loyaltyLedger)
		.values({
			memberId: input.memberId,
			type: input.type,
			delta: input.delta,
			eventKey: input.eventKey,
			purchaseId: input.purchaseId ?? null,
			redemptionId: input.redemptionId ?? null,
			channel: input.channel ?? null,
			locationId: input.locationId ?? null,
			programVersion: input.programVersion ?? null,
			reason: input.reason ?? null,
			note: input.note ?? null,
			actorKind: input.actorKind,
			actorId: input.actorId ?? null,
			at: input.at,
		})
		.onConflictDoNothing({ target: loyaltyLedger.eventKey })
		.returning({ id: loyaltyLedger.id })
	if (inserted.length === 0) {
		const existing = await tx
			.select({ id: loyaltyLedger.id, memberId: loyaltyLedger.memberId })
			.from(loyaltyLedger)
			.where(eq(loyaltyLedger.eventKey, input.eventKey))
			.get()
		if (!existing || existing.memberId !== input.memberId) {
			throw new LoyaltyDomainError('idempotency_conflict')
		}
		return { id: existing.id, inserted: false }
	}
	const earned =
		input.type === 'earn' || input.type === 'earn_reversal' ? input.delta : 0
	const redeemed =
		input.type === 'redeem' || input.type === 'redeem_restore'
			? -input.delta
			: 0
	await ensureBalanceRowInTx(tx, input.memberId, input.at)
	await tx
		.update(loyaltyBalances)
		.set({
			points: sql`${loyaltyBalances.points} + ${input.delta}`,
			lifetimeEarned: sql`${loyaltyBalances.lifetimeEarned} + ${earned}`,
			lifetimeRedeemed: sql`${loyaltyBalances.lifetimeRedeemed} + ${redeemed}`,
			updatedAt: input.at,
		})
		.where(eq(loyaltyBalances.memberId, input.memberId))
	return { id: inserted[0]!.id, inserted: true }
}

/**
 * Holds `points` for a redemption when the member can spend them. One
 * conditional statement, so two requests can never both pass the check.
 */
export async function holdPointsInTx(
	tx: LoyaltyTx,
	memberId: string,
	points: number,
	at: number,
): Promise<boolean> {
	if (!Number.isSafeInteger(points) || points <= 0) return false
	await ensureBalanceRowInTx(tx, memberId, at)
	const rows = await tx
		.update(loyaltyBalances)
		.set({
			reserved: sql`${loyaltyBalances.reserved} + ${points}`,
			updatedAt: at,
		})
		.where(
			and(
				eq(loyaltyBalances.memberId, memberId),
				sql`${loyaltyBalances.points} - ${loyaltyBalances.reserved} >= ${points}`,
			),
		)
		.returning({ memberId: loyaltyBalances.memberId })
	return rows.length === 1
}

/** Gives back held points (the hold was consumed, released or restored). */
export async function releaseHeldPointsInTx(
	tx: LoyaltyTx,
	memberId: string,
	points: number,
	at: number,
): Promise<void> {
	await tx
		.update(loyaltyBalances)
		.set({
			reserved: sql`${loyaltyBalances.reserved} - ${points}`,
			updatedAt: at,
		})
		.where(eq(loyaltyBalances.memberId, memberId))
}

function toBalance(
	row: typeof loyaltyBalances.$inferSelect | undefined,
): LoyaltyBalance {
	if (!row) return { ...EMPTY_LOYALTY_BALANCE }
	return {
		points: row.points,
		reserved: row.reserved,
		lifetimeEarned: row.lifetimeEarned,
		lifetimeRedeemed: row.lifetimeRedeemed,
	}
}

export async function readBalanceInTx(
	db: LoyaltyReader,
	memberId: string,
): Promise<LoyaltyBalance> {
	const row = await db
		.select()
		.from(loyaltyBalances)
		.where(eq(loyaltyBalances.memberId, memberId))
		.get()
	return toBalance(row)
}

export function balanceView(balance: LoyaltyBalance): LoyaltyBalanceView {
	return {
		points: balance.points,
		reserved: balance.reserved,
		available: balance.points - balance.reserved,
	}
}

/** The wallet figures plus the lifetime totals, for operator screens. */
export function operatorBalanceView(
	balance: LoyaltyBalance,
): LoyaltyOperatorBalance {
	return {
		...balanceView(balance),
		lifetimeEarned: balance.lifetimeEarned,
		lifetimeRedeemed: balance.lifetimeRedeemed,
	}
}

export async function readOperatorBalanceViewInTx(
	db: LoyaltyReader,
	memberId: string,
): Promise<LoyaltyOperatorBalance> {
	return operatorBalanceView(await readBalanceInTx(db, memberId))
}

export async function readBalanceViewInTx(
	db: LoyaltyReader,
	memberId: string,
): Promise<LoyaltyBalanceView> {
	return balanceView(await readBalanceInTx(db, memberId))
}

export type BalanceCheck = {
	memberId: string
	stored: LoyaltyBalance
	rebuilt: LoyaltyBalance
	matches: boolean
}

function sameBalance(a: LoyaltyBalance, b: LoyaltyBalance): boolean {
	return (
		a.points === b.points &&
		a.reserved === b.reserved &&
		a.lifetimeEarned === b.lifetimeEarned &&
		a.lifetimeRedeemed === b.lifetimeRedeemed
	)
}

/** Rebuilds balances from the ledger and the open holds of up to 90 members. */
async function rebuildChunk(
	db: LoyaltyReader,
	memberIds: readonly string[],
): Promise<Map<string, LoyaltyBalance>> {
	const sums = await db
		.select({
			memberId: loyaltyLedger.memberId,
			type: loyaltyLedger.type,
			total: sql<number>`sum(${loyaltyLedger.delta})`,
		})
		.from(loyaltyLedger)
		.where(inJsonList(loyaltyLedger.memberId, memberIds))
		.groupBy(loyaltyLedger.memberId, loyaltyLedger.type)
		.all()
	const held = await db
		.select({
			memberId: loyaltyRedemptions.memberId,
			total: sql<number>`sum(${loyaltyRedemptions.points})`,
		})
		.from(loyaltyRedemptions)
		.where(
			and(
				inJsonList(loyaltyRedemptions.memberId, memberIds),
				inArray(loyaltyRedemptions.state, [...LOYALTY_HOLDING_STATES]),
			),
		)
		.groupBy(loyaltyRedemptions.memberId)
		.all()
	const out = new Map<string, LoyaltyBalance>()
	for (const memberId of memberIds) {
		const entries = sums
			.filter((row) => row.memberId === memberId)
			.map((row) => ({ type: row.type, delta: Number(row.total) }))
		const holds = held
			.filter((row) => row.memberId === memberId)
			.map((row) => Number(row.total))
		out.set(memberId, rebuildLoyaltyBalance(entries, holds))
	}
	return out
}

export async function checkMemberBalanceInTx(
	db: LoyaltyReader,
	memberId: string,
): Promise<BalanceCheck> {
	const stored = await readBalanceInTx(db, memberId)
	const rebuilt = (await rebuildChunk(db, [memberId])).get(memberId)!
	return { memberId, stored, rebuilt, matches: sameBalance(stored, rebuilt) }
}

/**
 * Pages through every balance and returns the ones that differ from their
 * rebuild. `afterMemberId` continues from the previous page.
 */
export async function findBalanceMismatches(
	db: LoyaltyReader,
	options: { afterMemberId?: string | null; limit?: number } = {},
): Promise<{ mismatches: BalanceCheck[]; nextMemberId: string | null }> {
	const limit = Math.min(
		Math.max(options.limit ?? MAX_IN_CHUNK, 1),
		MAX_IN_CHUNK,
	)
	const rows = await db
		.select()
		.from(loyaltyBalances)
		.where(
			options.afterMemberId
				? gt(loyaltyBalances.memberId, options.afterMemberId)
				: undefined,
		)
		.orderBy(asc(loyaltyBalances.memberId))
		.limit(limit)
		.all()
	if (rows.length === 0) return { mismatches: [], nextMemberId: null }
	const rebuilt = await rebuildChunk(
		db,
		rows.map((row) => row.memberId),
	)
	const mismatches: BalanceCheck[] = []
	for (const row of rows) {
		const stored = toBalance(row)
		const expected = rebuilt.get(row.memberId)!
		if (!sameBalance(stored, expected)) {
			mismatches.push({
				memberId: row.memberId,
				stored,
				rebuilt: expected,
				matches: false,
			})
		}
	}
	return {
		mismatches,
		nextMemberId: rows.length < limit ? null : rows[rows.length - 1]!.memberId,
	}
}

/** Overwrites a projection with its rebuild. The ledger is never touched. */
export async function repairMemberBalanceInTx(
	tx: LoyaltyTx,
	memberId: string,
	at: number,
): Promise<BalanceCheck> {
	const check = await checkMemberBalanceInTx(tx, memberId)
	if (check.matches) return check
	await ensureBalanceRowInTx(tx, memberId, at)
	await tx
		.update(loyaltyBalances)
		.set({
			points: check.rebuilt.points,
			reserved: check.rebuilt.reserved,
			lifetimeEarned: check.rebuilt.lifetimeEarned,
			lifetimeRedeemed: check.rebuilt.lifetimeRedeemed,
			updatedAt: at,
		})
		.where(eq(loyaltyBalances.memberId, memberId))
	return check
}
