import { normalizePhone } from '@repo/common/phone'
import {
	loyaltyEventKeys,
	type LoyaltyActorKind,
	type LoyaltyChannel,
	type LoyaltyProgramConfig,
	type LoyaltyUnitLabel,
	type LoyaltyWallet,
} from '@repo/loyalty'
import {
	customers,
	loyaltyMembers,
	loyaltyPrograms,
	loyaltyPurchases,
	loyaltyWelcomeGrants,
} from '@repo/tenant-db'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { type LoyaltyReader, type LoyaltyTx } from '../lib/loyalty-write.ts'
import { hmacHash } from '../lib/secrets.ts'
import { recordLoyaltyAudit } from './loyalty-audit.ts'
import { postLedgerEntryInTx } from './loyalty-ledger.ts'
import {
	programVersionAtInTx,
	readProgramInTx,
} from './loyalty-program-service.ts'

/**
 * Computes the org-scoped regional HMAC of a member's verified phone for
 * one-welcome-bonus-per-phone abuse prevention.
 */
export function welcomePhoneHash(orgId: string, rawPhone: string): string {
	const normalized = normalizePhone(rawPhone)
	return hmacHash(`loyalty:welcome:v1:${orgId}:${normalized}`)
}

async function programConfigAtJoinInTx(
	db: LoyaltyReader,
	memberCreatedAt: number,
	fallbackConfig: LoyaltyProgramConfig,
): Promise<LoyaltyProgramConfig> {
	const matched = await programVersionAtInTx(db, memberCreatedAt)
	return matched ? matched.config : fallbackConfig
}

/**
 * Grants a one-time welcome bonus on enrollment (`trigger: 'join'`) or on a
 * member's first completed paid order (`trigger: 'first_order'`).
 *
 * Guarantees:
 * - Refuses suspended, erased, or imported (#130) accounts.
 * - Keyed by `phone_hash` with `onConflictDoNothing`, so re-joining after
 *   account erasure with the same verified phone receives nothing.
 * - Changing the bonus amount affects new members only.
 * - Does not count toward tier progression.
 */
export async function maybeGrantWelcomeBonusInTx(
	tx: LoyaltyTx,
	input: {
		orgId: string
		memberId: string
		trigger: 'join' | 'first_order'
		purchaseId?: string | null
		channel?: LoyaltyChannel | null
		locationId?: string | null
		actorKind?: LoyaltyActorKind
		actorId?: string | null
		now: number
	},
): Promise<{ granted: boolean; points: number }> {
	const active = await readProgramInTx(tx)
	if (!active || active.program.status !== 'active') {
		return { granted: false, points: 0 }
	}
	const currentConfig = active.current.config
	if (!currentConfig.welcomeBonus.enabled) {
		return { granted: false, points: 0 }
	}
	const expectedTrigger = currentConfig.welcomeBonus.afterFirstPaidOrder
		? 'first_order'
		: 'join'
	if (input.trigger !== expectedTrigger) {
		return { granted: false, points: 0 }
	}

	const member = await tx
		.select()
		.from(loyaltyMembers)
		.where(eq(loyaltyMembers.id, input.memberId))
		.get()
	if (
		!member ||
		member.status !== 'active' ||
		member.imported ||
		!member.customerId
	) {
		return { granted: false, points: 0 }
	}

	const joinConfig =
		input.trigger === 'join'
			? currentConfig
			: await programConfigAtJoinInTx(tx, member.createdAt, currentConfig)
	if (!joinConfig.welcomeBonus.enabled || joinConfig.welcomeBonus.points <= 0) {
		return { granted: false, points: 0 }
	}
	const points = joinConfig.welcomeBonus.points

	const customer = await tx
		.select({
			phone: customers.phone,
			phoneVerified: customers.phoneVerified,
		})
		.from(customers)
		.where(eq(customers.id, member.customerId))
		.get()
	if (!customer?.phoneVerified || !customer.phone) {
		return { granted: false, points: 0 }
	}

	if (input.trigger === 'first_order') {
		const priorCompleted = await tx
			.select({ id: loyaltyPurchases.id })
			.from(loyaltyPurchases)
			.where(
				and(
					eq(loyaltyPurchases.memberId, member.id),
					eq(loyaltyPurchases.state, 'completed'),
					input.purchaseId
						? ne(loyaltyPurchases.id, input.purchaseId)
						: ne(loyaltyPurchases.id, ''),
				),
			)
			.get()
		if (priorCompleted) {
			return { granted: false, points: 0 }
		}
	}

	const phoneHash = welcomePhoneHash(input.orgId, customer.phone)
	const inserted = await tx
		.insert(loyaltyWelcomeGrants)
		.values({
			phoneHash,
			memberId: member.id,
			purchaseId: input.purchaseId ?? null,
			points,
			trigger: input.trigger,
			grantedAt: input.now,
		})
		.onConflictDoNothing({ target: loyaltyWelcomeGrants.phoneHash })
		.returning({ phoneHash: loyaltyWelcomeGrants.phoneHash })

	if (inserted.length === 0) {
		return { granted: false, points: 0 }
	}

	await postLedgerEntryInTx(tx, {
		memberId: member.id,
		type: 'welcome',
		delta: points,
		eventKey: loyaltyEventKeys.welcome(member.id),
		purchaseId: input.purchaseId ?? null,
		channel: input.channel ?? null,
		locationId: input.locationId ?? null,
		programVersion: active.current.version,
		actorKind: input.actorKind ?? 'system',
		actorId: input.actorId ?? null,
		at: input.now,
	})

	await recordLoyaltyAudit(tx, {
		actorKind: input.actorKind ?? 'system',
		actorId: input.actorId ?? null,
		locationId: input.locationId ?? null,
		action: 'welcome_bonus.granted',
		entityType: 'member',
		entityId: member.id,
		changes: {
			points,
			trigger: input.trigger,
			purchaseId: input.purchaseId ?? null,
		},
		at: input.now,
	})

	return { granted: true, points }
}

/**
 * Reverses a `first_order` welcome bonus if its qualifying order is refunded
 * in full or drops below the program's minimum spend requirement.
 */
export async function maybeReverseWelcomeBonusOnRefundInTx(
	tx: LoyaltyTx,
	input: {
		memberId: string
		purchaseId: string
		fullRefund: boolean
		remainingEligibleMinor: number
		minimumSpendMinor: number
		channel: LoyaltyChannel | null
		locationId: string | null
		programVersion: number | null
		actorKind: LoyaltyActorKind
		actorId?: string | null
		at: number
	},
): Promise<number> {
	if (
		!input.fullRefund &&
		input.remainingEligibleMinor > 0 &&
		input.remainingEligibleMinor >= input.minimumSpendMinor
	) {
		return 0
	}
	const grant = await tx
		.select()
		.from(loyaltyWelcomeGrants)
		.where(
			and(
				eq(loyaltyWelcomeGrants.purchaseId, input.purchaseId),
				eq(loyaltyWelcomeGrants.trigger, 'first_order'),
				isNull(loyaltyWelcomeGrants.reversedAt),
			),
		)
		.get()
	if (!grant) return 0

	const updated = await tx
		.update(loyaltyWelcomeGrants)
		.set({
			reversedAt: input.at,
			reversedPurchaseId: input.purchaseId,
		})
		.where(
			and(
				eq(loyaltyWelcomeGrants.phoneHash, grant.phoneHash),
				isNull(loyaltyWelcomeGrants.reversedAt),
			),
		)
		.returning({ points: loyaltyWelcomeGrants.points })
	if (updated.length === 0) return 0

	await postLedgerEntryInTx(tx, {
		memberId: input.memberId,
		type: 'welcome_reversal',
		delta: -grant.points,
		eventKey: loyaltyEventKeys.welcomeReversal(input.purchaseId),
		purchaseId: input.purchaseId,
		channel: input.channel,
		locationId: input.locationId,
		programVersion: input.programVersion,
		actorKind: input.actorKind,
		actorId: input.actorId ?? null,
		at: input.at,
	})

	await recordLoyaltyAudit(tx, {
		actorKind: input.actorKind,
		actorId: input.actorId ?? null,
		locationId: input.locationId ?? null,
		action: 'welcome_bonus.reversed',
		entityType: 'member',
		entityId: input.memberId,
		changes: { points: grant.points, purchaseId: input.purchaseId },
		at: input.at,
	})

	return grant.points
}

/** Reads welcome-bonus display state for the signed-in customer wallet. */
export async function readWelcomeBonusForWalletInTx(
	db: LoyaltyReader,
	input: {
		orgId: string | null
		member: typeof loyaltyMembers.$inferSelect
		config: LoyaltyProgramConfig
	},
): Promise<LoyaltyWallet['welcomeBonus']> {
	let grant = await db
		.select()
		.from(loyaltyWelcomeGrants)
		.where(eq(loyaltyWelcomeGrants.memberId, input.member.id))
		.get()

	if (!grant && input.orgId && input.member.customerId) {
		const customer = await db
			.select({
				phone: customers.phone,
				phoneVerified: customers.phoneVerified,
			})
			.from(customers)
			.where(eq(customers.id, input.member.customerId))
			.get()
		if (customer?.phoneVerified && customer.phone) {
			const hash = welcomePhoneHash(input.orgId, customer.phone)
			grant = await db
				.select()
				.from(loyaltyWelcomeGrants)
				.where(eq(loyaltyWelcomeGrants.phoneHash, hash))
				.get()
		}
	}

	if (grant) {
		if (grant.reversedAt !== null) {
			return { status: 'ineligible', points: 0, grantedAt: null }
		}
		if (grant.memberId === input.member.id) {
			return {
				status: 'granted',
				points: grant.points,
				grantedAt: grant.grantedAt,
			}
		}
		// Previously granted to another member sharing this verified phone hash (e.g. post-erasure).
		return { status: 'ineligible', points: 0, grantedAt: null }
	}

	if (input.member.imported || input.member.status !== 'active') {
		return { status: 'ineligible', points: 0, grantedAt: null }
	}

	if (
		!input.config.welcomeBonus.enabled ||
		!input.config.welcomeBonus.afterFirstPaidOrder
	) {
		return null
	}

	const joinConfig = await programConfigAtJoinInTx(
		db,
		input.member.createdAt,
		input.config,
	)
	if (
		!joinConfig.welcomeBonus.enabled ||
		!joinConfig.welcomeBonus.afterFirstPaidOrder ||
		joinConfig.welcomeBonus.points <= 0
	) {
		return null
	}

	const anyCompleted = await db
		.select({ id: loyaltyPurchases.id })
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.memberId, input.member.id),
				eq(loyaltyPurchases.state, 'completed'),
			),
		)
		.get()
	if (anyCompleted) {
		return { status: 'none', points: 0, grantedAt: null }
	}
	return {
		status: 'pending_first_order',
		points: joinConfig.welcomeBonus.points,
		grantedAt: null,
	}
}

/**
 * Looks up any welcome bonus unlocked on `orderId` (either attached to this
 * order's `first_order` purchase or granted on checkout join for this order).
 */
export async function welcomeBonusForOrderReceipt(
	db: LoyaltyReader,
	input: {
		orderId: string
		customerId: string | null
		orderCreatedAt: number
	},
): Promise<{ points: number; unitLabel: LoyaltyUnitLabel } | null> {
	if (!input.customerId) return null
	const active = await readProgramInTx(db)
	if (!active) return null
	const member = await db
		.select({ id: loyaltyMembers.id })
		.from(loyaltyMembers)
		.where(eq(loyaltyMembers.customerId, input.customerId))
		.get()
	if (!member) return null

	const purchase = await db
		.select({ id: loyaltyPurchases.id })
		.from(loyaltyPurchases)
		.where(
			and(
				eq(loyaltyPurchases.sourceType, 'restaurant_order'),
				eq(loyaltyPurchases.sourceId, input.orderId),
			),
		)
		.get()

	const grant = await db
		.select()
		.from(loyaltyWelcomeGrants)
		.where(
			and(
				eq(loyaltyWelcomeGrants.memberId, member.id),
				isNull(loyaltyWelcomeGrants.reversedAt),
			),
		)
		.get()
	if (!grant) return null

	const matchesOrderPurchase = purchase && grant.purchaseId === purchase.id
	const grantedDuringCheckout =
		grant.trigger === 'join' &&
		grant.grantedAt >= input.orderCreatedAt - 15 * 60_000 &&
		grant.grantedAt <= input.orderCreatedAt + 15 * 60_000
	if (!matchesOrderPurchase && !grantedDuringCheckout) return null

	const progRow = await db
		.select({ id: loyaltyPrograms.id })
		.from(loyaltyPrograms)
		.get()
	if (!progRow) return null
	return {
		points: grant.points,
		unitLabel: active.current.config.unitLabel,
	}
}
