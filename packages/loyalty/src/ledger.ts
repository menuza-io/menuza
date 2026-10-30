import { z } from 'zod'
import { LOYALTY_MAX_POINTS } from './money.ts'

/**
 * The points ledger: append-only signed deltas. A balance is a projection kept
 * in the same transaction as each entry and can always be rebuilt from the
 * ledger plus the redemptions still holding points. A balance may go negative
 * (points debt) when a refund takes back points that were already spent.
 */

export const LOYALTY_LEDGER_TYPES = [
	'earn',
	'earn_reversal',
	'redeem',
	'redeem_restore',
	'adjust',
] as const
export type LoyaltyLedgerType = (typeof LOYALTY_LEDGER_TYPES)[number]

export const LOYALTY_ADJUSTMENT_REASONS = [
	'goodwill',
	'correction',
	'service_recovery',
	'fraud',
	'other',
] as const
/**
 * Largest absolute points delta of one operator adjustment. Enforced by the
 * route schema and again by the service, so no caller can move more per call;
 * larger removals take several recorded, audited calls.
 */
export const LOYALTY_MAX_ADJUSTMENT_DELTA = 1_000_000
/**
 * Most points one operator may add by manual adjustment in any
 * LOYALTY_ADJUSTMENT_CREDIT_WINDOW_MS. Never below the per-call limit, so one
 * mistaken removal can always be undone the same day. Removals have no daily
 * limit: they never create value.
 */
export const LOYALTY_MAX_DAILY_ADJUSTMENT_CREDIT = 1_000_000
export const LOYALTY_ADJUSTMENT_CREDIT_WINDOW_MS = 24 * 60 * 60_000
export type LoyaltyAdjustmentReason =
	(typeof LOYALTY_ADJUSTMENT_REASONS)[number]

export const LOYALTY_ACTOR_KINDS = [
	'system',
	'operator',
	'customer',
	'station',
] as const
export type LoyaltyActorKind = (typeof LOYALTY_ACTOR_KINDS)[number]

export const LOYALTY_CHANNELS = ['web', 'pos', 'qr', 'native'] as const
export type LoyaltyChannel = (typeof LOYALTY_CHANNELS)[number]

/** Which sign each entry type must have. */
export function isValidLedgerDelta(
	type: LoyaltyLedgerType,
	delta: number,
): boolean {
	if (!Number.isSafeInteger(delta) || delta === 0) return false
	if (Math.abs(delta) > LOYALTY_MAX_POINTS) return false
	switch (type) {
		case 'earn':
		case 'redeem_restore':
			return delta > 0
		case 'earn_reversal':
		case 'redeem':
			return delta < 0
		case 'adjust':
			return true
	}
}

/** Unique event keys: the same fact can never be posted twice. */
export const loyaltyEventKeys = {
	earn: (purchaseId: string) => `earn:${purchaseId}`,
	reversal: (purchaseId: string, refundKey: string) =>
		`reverse:${purchaseId}:${refundKey}`,
	redeem: (redemptionId: string) => `redeem:${redemptionId}`,
	restore: (redemptionId: string) => `restore:${redemptionId}`,
	adjust: (memberId: string, idempotencyKey: string) =>
		`adjust:${memberId}:${idempotencyKey}`,
} as const

export type LoyaltyBalance = {
	points: number
	reserved: number
	/** Earned net of reversals. */
	lifetimeEarned: number
	/** Spent on consumed rewards, net of restores. */
	lifetimeRedeemed: number
}

export const EMPTY_LOYALTY_BALANCE: Readonly<LoyaltyBalance> = Object.freeze({
	points: 0,
	reserved: 0,
	lifetimeEarned: 0,
	lifetimeRedeemed: 0,
})

export function applyLedgerEntry(
	balance: LoyaltyBalance,
	entry: { type: LoyaltyLedgerType; delta: number },
): LoyaltyBalance {
	const next = { ...balance, points: balance.points + entry.delta }
	if (entry.type === 'earn' || entry.type === 'earn_reversal') {
		next.lifetimeEarned += entry.delta
	} else if (entry.type === 'redeem' || entry.type === 'redeem_restore') {
		next.lifetimeRedeemed -= entry.delta
	}
	return next
}

/** Rebuild a balance from its ledger and the points its open redemptions hold. */
export function rebuildLoyaltyBalance(
	entries: Iterable<{ type: LoyaltyLedgerType; delta: number }>,
	heldRedemptionPoints: Iterable<number>,
): LoyaltyBalance {
	let balance: LoyaltyBalance = { ...EMPTY_LOYALTY_BALANCE }
	for (const entry of entries) balance = applyLedgerEntry(balance, entry)
	let reserved = 0
	for (const points of heldRedemptionPoints) reserved += points
	return { ...balance, reserved }
}

/** Spendable now: points minus what open redemptions hold. Negative in debt. */
export function availableLoyaltyPoints(
	balance: Pick<LoyaltyBalance, 'points' | 'reserved'>,
): number {
	return balance.points - balance.reserved
}

export function canSpendLoyaltyPoints(
	balance: Pick<LoyaltyBalance, 'points' | 'reserved'>,
	cost: number,
): boolean {
	return cost > 0 && availableLoyaltyPoints(balance) >= cost
}

export const loyaltyAdjustmentRequestSchema = z
	.object({
		delta: z
			.number()
			.int()
			.min(-LOYALTY_MAX_ADJUSTMENT_DELTA)
			.max(LOYALTY_MAX_ADJUSTMENT_DELTA)
			.refine((value) => value !== 0, 'An adjustment cannot be zero'),
		reason: z.enum(LOYALTY_ADJUSTMENT_REASONS),
		/** Required: why the points moved. Kept on the audit record. */
		note: z.string().trim().min(3).max(280),
	})
	.strict()
export type LoyaltyAdjustmentRequest = z.infer<
	typeof loyaltyAdjustmentRequestSchema
>
