import {
	computeRewardDiscount,
	LOYALTY_RESERVATION_TTL_MS,
	LoyaltyDomainError,
	loyaltyEventKeys,
	type LoyaltyActorKind,
	type LoyaltyCart,
	type LoyaltyChannel,
	type LoyaltyOperatorRedemption,
	type LoyaltyPurchaseSource,
	type LoyaltyReviewReason,
	type LoyaltyRewardQuote,
	type LoyaltyRewardSnapshot,
} from '@repo/loyalty'
import { loyaltyRedemptions } from '@repo/tenant-db'
import { and, eq, ne } from 'drizzle-orm'
import {
	type LoyaltyIdempotency,
	type LoyaltyReader,
	type LoyaltyTx,
	withLoyaltyWrite,
} from '../lib/loyalty-write.ts'
import { recordLoyaltyAudit } from './loyalty-audit.ts'
import {
	holdPointsInTx,
	postLedgerEntryInTx,
	readBalanceViewInTx,
	releaseHeldPointsInTx,
} from './loyalty-ledger.ts'
import {
	locationVisible,
	type MemberRow,
	toOperatorRedemption,
} from './loyalty-member-service.ts'
import { closeParkedSourceInTx } from './loyalty-outbox.ts'
import { readProgramInTx } from './loyalty-program-service.ts'
import { applyRefundsAfterDecisionInTx } from './loyalty-purchase-service.ts'

/**
 * Spending points on a reward.
 *
 *   reserved -> bound -> consumed -> restored
 *            \        \-> released
 *             \-> released      bound -> review -> consumed | released
 *
 * A quote is never binding. Reserving holds the points with one conditional
 * statement, so no two requests can spend the same points. A bound redemption
 * is only consumed or released from what the sale itself says (or by an
 * operator from review), never because a timer ran out.
 */

export type RedemptionRow = typeof loyaltyRedemptions.$inferSelect

export async function readRedemptionInTx(
	db: LoyaltyReader,
	redemptionId: string,
): Promise<RedemptionRow | null> {
	return (
		(await db
			.select()
			.from(loyaltyRedemptions)
			.where(eq(loyaltyRedemptions.id, redemptionId))
			.get()) ?? null
	)
}

/** The redemption occupying a source's single reward slot, if any. */
export async function activeRedemptionForSourceInTx(
	db: LoyaltyReader,
	sourceType: LoyaltyPurchaseSource,
	sourceId: string,
): Promise<RedemptionRow | null> {
	return (
		(await db
			.select()
			.from(loyaltyRedemptions)
			.where(
				and(
					eq(loyaltyRedemptions.sourceType, sourceType),
					eq(loyaltyRedemptions.sourceId, sourceId),
					ne(loyaltyRedemptions.state, 'released'),
				),
			)
			.get()) ?? null
	)
}

export function quoteReward(
	reward: LoyaltyRewardSnapshot,
	cart: LoyaltyCart,
	available: number,
	targetLineId: string | null = null,
): LoyaltyRewardQuote {
	const pointsCost = reward.definition.pointsCost
	const affordable = available >= pointsCost
	const result = computeRewardDiscount(reward, cart, { targetLineId })
	if (!result.ok) {
		return {
			rewardId: reward.rewardId,
			rewardVersion: reward.version,
			applicable: false,
			code: result.code,
			discountMinor: 0,
			pointsCost,
			affordable,
			eligibleLineIds: [],
			lines: [],
			targetLineId: null,
		}
	}
	return {
		rewardId: reward.rewardId,
		rewardVersion: reward.version,
		applicable: true,
		code: affordable ? null : 'insufficient_points',
		discountMinor: result.discountMinor,
		pointsCost,
		affordable,
		eligibleLineIds: result.eligibleLineIds,
		lines: result.lines,
		targetLineId: result.targetLineId,
	}
}

export type ReserveRedemptionInput = {
	member: MemberRow
	reward: LoyaltyRewardSnapshot
	cart: LoyaltyCart
	/** SHA-256 of the canonical cart, computed before the transaction. */
	cartHash: string
	targetLineId: string | null
	/** The discount the customer was shown; anything else is `cart_changed`. */
	expectedDiscountMinor?: number | null
	channel: LoyaltyChannel
	/** Bind straight to an order, tab or sale. Without one the hold expires. */
	source: { type: LoyaltyPurchaseSource; id: string } | null
	locationId: string | null
	deviceId?: string | null
	approvalId?: string | null
	at: number
}

/**
 * Holds the reward's points and records the redemption, bound to its source
 * when one is given. Throws a loyalty error (and holds nothing) when the
 * member cannot spend, the reward does not apply, or the source already has a
 * reward.
 */
export async function reserveRedemptionInTx(
	tx: LoyaltyTx,
	input: ReserveRedemptionInput,
): Promise<RedemptionRow> {
	if (input.member.status !== 'active') {
		throw new LoyaltyDomainError('member_inactive')
	}
	const result = computeRewardDiscount(input.reward, input.cart, {
		targetLineId: input.targetLineId,
	})
	if (!result.ok) throw new LoyaltyDomainError(result.code)
	if (
		input.expectedDiscountMinor !== undefined &&
		input.expectedDiscountMinor !== null &&
		input.expectedDiscountMinor !== result.discountMinor
	) {
		throw new LoyaltyDomainError('cart_changed', {
			discountMinor: result.discountMinor,
		})
	}
	if (input.source) {
		const taken = await activeRedemptionForSourceInTx(
			tx,
			input.source.type,
			input.source.id,
		)
		if (taken) throw new LoyaltyDomainError('one_reward_per_order')
	}
	const points = input.reward.definition.pointsCost
	const held = await holdPointsInTx(tx, input.member.id, points, input.at)
	if (!held) {
		const balance = await readBalanceViewInTx(tx, input.member.id)
		throw new LoyaltyDomainError('insufficient_points', {
			available: balance.available,
			pointsCost: points,
		})
	}
	const [row] = await tx
		.insert(loyaltyRedemptions)
		.values({
			memberId: input.member.id,
			rewardId: input.reward.rewardId,
			rewardVersion: input.reward.version,
			rewardName: input.reward.definition.name,
			rewardSnapshot: input.reward as unknown as Record<string, unknown>,
			points,
			state: input.source ? 'bound' : 'reserved',
			channel: input.channel,
			sourceType: input.source?.type ?? null,
			sourceId: input.source?.id ?? null,
			locationId: input.locationId,
			deviceId: input.deviceId ?? null,
			approvalId: input.approvalId ?? null,
			currency: input.reward.currency,
			cartHash: input.cartHash,
			discountMinor: result.discountMinor,
			allocation: result.lines,
			targetLineId: result.targetLineId,
			expiresAt: input.source ? null : input.at + LOYALTY_RESERVATION_TTL_MS,
			createdAt: input.at,
			boundAt: input.source ? input.at : null,
			updatedAt: input.at,
		})
		.returning()
	return row!
}

/** Attaches a reserved hold to its order. The cart must be the one quoted. */
export async function bindRedemptionInTx(
	tx: LoyaltyTx,
	redemption: RedemptionRow,
	input: {
		source: { type: LoyaltyPurchaseSource; id: string }
		cartHash: string
		locationId?: string | null
		at: number
	},
): Promise<RedemptionRow> {
	if (
		redemption.state === 'bound' &&
		redemption.sourceType === input.source.type &&
		redemption.sourceId === input.source.id
	) {
		return redemption
	}
	if (redemption.state !== 'reserved') {
		throw new LoyaltyDomainError('invalid_transition')
	}
	if (redemption.expiresAt !== null && redemption.expiresAt <= input.at) {
		await releaseRedemptionInTx(tx, redemption, {
			reason: 'expired',
			at: input.at,
		})
		throw new LoyaltyDomainError('redemption_not_found')
	}
	if (redemption.cartHash !== input.cartHash) {
		throw new LoyaltyDomainError('cart_changed')
	}
	const taken = await activeRedemptionForSourceInTx(
		tx,
		input.source.type,
		input.source.id,
	)
	if (taken && taken.id !== redemption.id) {
		throw new LoyaltyDomainError('one_reward_per_order')
	}
	const [row] = await tx
		.update(loyaltyRedemptions)
		.set({
			state: 'bound',
			sourceType: input.source.type,
			sourceId: input.source.id,
			locationId: input.locationId ?? redemption.locationId,
			expiresAt: null,
			boundAt: input.at,
			updatedAt: input.at,
		})
		.where(eq(loyaltyRedemptions.id, redemption.id))
		.returning()
	return row!
}

/** The sale was confirmed: the held points are spent. */
export async function consumeRedemptionInTx(
	tx: LoyaltyTx,
	redemption: RedemptionRow,
	input: {
		at: number
		actorKind: LoyaltyActorKind
		actorId?: string | null
		note?: string | null
	},
): Promise<RedemptionRow> {
	if (redemption.state === 'consumed' || redemption.state === 'restored') {
		return redemption
	}
	if (redemption.state !== 'bound' && redemption.state !== 'review') {
		throw new LoyaltyDomainError('invalid_transition')
	}
	const [row] = await tx
		.update(loyaltyRedemptions)
		.set({ state: 'consumed', consumedAt: input.at, updatedAt: input.at })
		.where(eq(loyaltyRedemptions.id, redemption.id))
		.returning()
	await releaseHeldPointsInTx(
		tx,
		redemption.memberId,
		redemption.points,
		input.at,
	)
	await postLedgerEntryInTx(tx, {
		memberId: redemption.memberId,
		type: 'redeem',
		delta: -redemption.points,
		eventKey: loyaltyEventKeys.redeem(redemption.id),
		redemptionId: redemption.id,
		channel: redemption.channel,
		locationId: redemption.locationId,
		note: input.note ?? null,
		actorKind: input.actorKind,
		actorId: input.actorId ?? null,
		at: input.at,
	})
	return row!
}

/** Confirmed unspent (cancelled, unpaid, expired hold): the points come back. */
export async function releaseRedemptionInTx(
	tx: LoyaltyTx,
	redemption: RedemptionRow,
	input: { reason: string; at: number },
): Promise<RedemptionRow> {
	if (redemption.state === 'released') return redemption
	if (
		redemption.state !== 'reserved' &&
		redemption.state !== 'bound' &&
		redemption.state !== 'review'
	) {
		throw new LoyaltyDomainError('invalid_transition')
	}
	const [row] = await tx
		.update(loyaltyRedemptions)
		.set({
			state: 'released',
			releaseReason: input.reason,
			releasedAt: input.at,
			updatedAt: input.at,
		})
		.where(eq(loyaltyRedemptions.id, redemption.id))
		.returning()
	await releaseHeldPointsInTx(
		tx,
		redemption.memberId,
		redemption.points,
		input.at,
	)
	return row!
}

/**
 * Gives back the reward held on a source whose sale dropped it (a tab payment
 * that was stopped, restarted or re-priced). A redemption in review stays for
 * the operator.
 */
export async function releaseSourceRedemptionInTx(
	tx: LoyaltyTx,
	source: { type: LoyaltyPurchaseSource; id: string },
	input: { reason: string; at: number },
): Promise<RedemptionRow | null> {
	const redemption = await activeRedemptionForSourceInTx(
		tx,
		source.type,
		source.id,
	)
	if (
		!redemption ||
		(redemption.state !== 'reserved' && redemption.state !== 'bound')
	) {
		return null
	}
	return releaseRedemptionInTx(tx, redemption, input)
}

/**
 * Like `releaseSourceRedemptionInTx`, for a sale whose old payment page may
 * still charge the discounted amount until `payableUntil`: while it can, the
 * bound reward goes to review instead, so a late payment there cannot keep
 * both the discount and the points.
 */
export async function setAsideSourceRedemptionInTx(
	tx: LoyaltyTx,
	source: { type: LoyaltyPurchaseSource; id: string },
	input: { reason: string; at: number; payableUntil: number | null },
): Promise<RedemptionRow | null> {
	const redemption = await activeRedemptionForSourceInTx(
		tx,
		source.type,
		source.id,
	)
	if (
		redemption?.state === 'bound' &&
		input.payableUntil !== null &&
		input.payableUntil > input.at
	) {
		return reviewRedemptionInTx(tx, redemption, {
			reason: 'payment_uncertain',
			at: input.at,
		})
	}
	return releaseSourceRedemptionInTx(tx, source, input)
}

/** The sale is uncertain: the points stay held until someone decides. */
export async function reviewRedemptionInTx(
	tx: LoyaltyTx,
	redemption: RedemptionRow,
	input: { reason: LoyaltyReviewReason; at: number },
): Promise<RedemptionRow> {
	if (redemption.state !== 'bound') return redemption
	const [row] = await tx
		.update(loyaltyRedemptions)
		.set({
			state: 'review',
			reviewReason: input.reason,
			reviewAt: input.at,
			updatedAt: input.at,
		})
		.where(eq(loyaltyRedemptions.id, redemption.id))
		.returning()
	return row!
}

/** A confirmed full refund gives the reward's points back, once. */
export async function restoreRedemptionInTx(
	tx: LoyaltyTx,
	redemption: RedemptionRow,
	input: { at: number; actorKind: LoyaltyActorKind; actorId?: string | null },
): Promise<RedemptionRow> {
	if (redemption.state === 'restored') return redemption
	if (redemption.state !== 'consumed') {
		throw new LoyaltyDomainError('invalid_transition')
	}
	const [row] = await tx
		.update(loyaltyRedemptions)
		.set({ state: 'restored', restoredAt: input.at, updatedAt: input.at })
		.where(eq(loyaltyRedemptions.id, redemption.id))
		.returning()
	await postLedgerEntryInTx(tx, {
		memberId: redemption.memberId,
		type: 'redeem_restore',
		delta: redemption.points,
		eventKey: loyaltyEventKeys.restore(redemption.id),
		redemptionId: redemption.id,
		channel: redemption.channel,
		locationId: redemption.locationId,
		actorKind: input.actorKind,
		actorId: input.actorId ?? null,
		at: input.at,
	})
	return row!
}

/**
 * An operator decides a redemption waiting in review: the sale did happen
 * with the discount (consume) or it did not (release).
 */
export async function resolveRedemption(
	orgId: string,
	input: {
		redemptionId: string
		action: 'consume' | 'release'
		note: string
		actorId: string
		locationIds: readonly string[] | null
		now?: number
		idempotency?: LoyaltyIdempotency
	},
): Promise<LoyaltyOperatorRedemption> {
	return withLoyaltyWrite(
		{ orgId, now: input.now, idempotency: input.idempotency },
		async (tx, ctx) => {
			const redemption = await readRedemptionInTx(tx, input.redemptionId)
			if (!redemption) throw new LoyaltyDomainError('redemption_not_found')
			if (!locationVisible(input.locationIds, redemption.locationId)) {
				throw new LoyaltyDomainError('location_forbidden')
			}
			ctx.linkMember(redemption.memberId)
			if (redemption.state !== 'review') {
				throw new LoyaltyDomainError('invalid_transition')
			}
			let next =
				input.action === 'consume'
					? await consumeRedemptionInTx(tx, redemption, {
							at: ctx.now,
							actorKind: 'operator',
							actorId: input.actorId,
							note: input.note,
						})
					: await releaseRedemptionInTx(tx, redemption, {
							reason: 'operator',
							at: ctx.now,
						})
			if (redemption.sourceType && redemption.sourceId) {
				const source = { type: redemption.sourceType, id: redemption.sourceId }
				await applyRefundsAfterDecisionInTx(tx, source, ctx.now)
				next = (await readRedemptionInTx(tx, redemption.id)) ?? next
				await closeParkedSourceInTx(tx, source, ctx.now)
			}
			await recordLoyaltyAudit(tx, {
				actorKind: 'operator',
				actorId: input.actorId,
				locationId: redemption.locationId,
				action:
					input.action === 'consume'
						? 'redemption.consumed'
						: 'redemption.released',
				entityType: 'redemption',
				entityId: redemption.id,
				changes: {
					reviewReason: redemption.reviewReason,
					points: redemption.points,
					note: input.note,
				},
				at: ctx.now,
			})
			return toOperatorRedemption(next)
		},
	)
}
