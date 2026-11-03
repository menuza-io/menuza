import { create } from 'zustand'
import { registerLoyaltyListeners } from './loyalty-hooks.ts'
import {
	buildLoyaltyCart,
	createLoyaltyApi,
	LoyaltyApiError,
	rewardAdjustment,
	spendingAllowed,
	type LoyaltyApi,
	type LoyaltyApproval,
	type LoyaltyMember,
	type LoyaltyReward,
	type SpendRefusal,
} from './loyalty.ts'
import { type Adjustment, type CartLine } from './pricing.ts'
import { usePos } from './store.ts'
import { categoryIdsByItem } from './till-discounts.ts'

/**
 * The loyalty session of the sale on screen: who the member is, the reward
 * being asked for, and the reward on the cart. It lives in memory only. It
 * starts when the cashier identifies a member and ends when the order is
 * cleared (sold, saved as a tab or thrown away), when the cashier forgets the
 * member, or when the till locks.
 *
 *   no member ──identify / join──▶ member ──choose reward──▶ waiting
 *        ▲                           │  ▲                       │
 *        │                           │  └── declined, expired ──┤
 *        └──── forget / order cleared┘                          │ approved
 *                                    reward on the cart ◀───────┘
 *
 * A reward is priced on the cart as it stood, so any change to the lines or to
 * the discounts under it ends the reward and gives the points back (the cart
 * store tells this one through `loyalty-hooks.ts`).
 *
 * Every action takes an `Env`, so it is tested with a fake client and a fake
 * cart; `liveEnv()` reads the real ones.
 */

export type Waiting = {
	approval: LoyaltyApproval
	/** The cashier asked for a code to be texted to the member. */
	otpSent: boolean
}

export type LoyaltyState = {
	member: LoyaltyMember | null
	/** The sale id a reward is approved for; fixed for the sale, renewed when a reward ends. */
	saleId: string | null
	/** A reward being asked for: quoting, or waiting for the member. */
	quoting: string | null
	waiting: Waiting | null
	/** The approved reward on the cart. */
	applied: { approvalId: string; name: string; discountMinor: number } | null
	/** The sale was placed carrying the reward: clearing the order must not give it back. */
	placed: boolean
	/** The region says loyalty is not available here: the entry point hides. */
	unavailable: boolean
}

export const initialLoyaltyState: LoyaltyState = {
	member: null,
	saleId: null,
	quoting: null,
	waiting: null,
	applied: null,
	placed: false,
	unavailable: false,
}

export const useLoyalty = create<LoyaltyState>(() => initialLoyaltyState)

/** What an action needs from outside: the region, and the cart. */
export type Env = {
	api: LoyaltyApi
	cart: () => {
		currency: string
		lines: readonly CartLine[]
		adjustments: readonly Adjustment[]
		categoryIdsByItem: ReadonlyMap<string, readonly string[]>
		/** The tab being added to: a reward is approved for that order's id. */
		activeOrderId: string | null
		online: boolean
		signInRequired: boolean
		session: Parameters<typeof spendingAllowed>[0]['session']
	}
	applyReward: (reward: Adjustment | null) => void
	now: () => number
	uuid: () => string
}

export function liveEnv(): Env {
	const state = () => usePos.getState()
	return {
		api: createLoyaltyApi({
			settings: () => state().settings,
			session: () => state().session,
		}),
		cart: () => {
			const s = state()
			return {
				currency:
					s.location?.currency ??
					s.snapshot?.menu.organization.currency ??
					'USD',
				lines: s.lines,
				adjustments: s.adjustments,
				categoryIdsByItem: categoryIdsByItem(s.categories),
				activeOrderId: s.activeOrderId,
				online: s.online,
				signInRequired: s.settings.signInRequired,
				session: s.session,
			}
		},
		applyReward: (reward) => state().setLoyaltyReward(reward),
		now: () => Date.now(),
		uuid: () => crypto.randomUUID(),
	}
}

const patch = (next: Partial<LoyaltyState>) => useLoyalty.setState(next)

/** A refusal the cashier can read: why a reward cannot be used, or the region's code. */
export class RewardRefusal extends Error {
	constructor(
		readonly reason:
			| SpendRefusal
			| 'not_applicable'
			| 'not_affordable'
			| 'empty_cart'
			| 'no_request',
		readonly code: string | null = null,
	) {
		super(reason)
		this.name = 'RewardRefusal'
	}
}

// ---------------------------------------------------------------------------
// Identifying a member
// ---------------------------------------------------------------------------

/** Loyalty answered "not here": remember it, so the entry point stops offering it. */
function noteUnavailable(error: unknown): void {
	if (error instanceof LoyaltyApiError && error.unavailable) {
		patch({ unavailable: true })
	}
}

function adopt(member: LoyaltyMember): LoyaltyMember {
	patch({ member, unavailable: false })
	return member
}

/** A member code from the guest's wallet. Throws `LoyaltyApiError`. */
export async function identifyByCode(
	env: Env,
	code: string,
): Promise<LoyaltyMember> {
	try {
		return adopt(await env.api.identify(code))
	} catch (error) {
		noteUnavailable(error)
		throw error
	}
}

/** Sends the one-time code that proves the guest owns the phone. */
export async function sendJoinCode(env: Env, phone: string) {
	try {
		return await env.api.joinSend(phone)
	} catch (error) {
		noteUnavailable(error)
		throw error
	}
}

/** The guest reads the code back: they are a member (new or existing). */
export async function verifyJoinCode(
	env: Env,
	phone: string,
	code: string,
): Promise<LoyaltyMember> {
	try {
		return adopt(await env.api.joinVerify(phone, code))
	} catch (error) {
		noteUnavailable(error)
		throw error
	}
}

/** Re-reads the balance and rewards (after a reward, or to refresh the screen). */
export async function refreshMember(env: Env): Promise<void> {
	const member = useLoyalty.getState().member
	if (!member) return
	try {
		const fresh = await env.api.member(member.binding)
		patch({ member: { ...fresh, joined: member.joined } })
	} catch {
		/* the held balance stays: it is only for display */
	}
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

/** The sale id a reward is approved for: the tab's own, or one fixed for this sale. */
function ensureSaleId(env: Env, activeOrderId: string | null): string {
	if (activeOrderId) {
		patch({ saleId: activeOrderId })
		return activeOrderId
	}
	const held = useLoyalty.getState().saleId
	if (held) return held
	const saleId = env.uuid()
	patch({ saleId })
	return saleId
}

/**
 * Asks the region to price a reward on this cart and, if it applies and the
 * member can afford it, asks the member to approve it. Resolves to the
 * approval; throws `RewardRefusal` or `LoyaltyApiError`.
 */
export async function chooseReward(
	env: Env,
	reward: LoyaltyReward,
): Promise<LoyaltyApproval> {
	const state = useLoyalty.getState()
	const member = state.member
	const cart = env.cart()
	const allowed = spendingAllowed({
		online: cart.online,
		member,
		signInRequired: cart.signInRequired,
		session: cart.session,
		now: env.now(),
	})
	if (!allowed.ok) throw new RewardRefusal(allowed.reason)
	if (cart.lines.length === 0) throw new RewardRefusal('empty_cart')
	if (state.applied || state.waiting) {
		// One reward per sale: the one on the cart goes first.
		await removeReward(env)
	}
	patch({ quoting: reward.id })
	try {
		const loyaltyCart = buildLoyaltyCart({
			currency: cart.currency,
			lines: cart.lines,
			adjustments: cart.adjustments,
			categoryIdsByItem: cart.categoryIdsByItem,
		})
		const binding = member!.binding
		const priced = await env.api.quote({
			binding,
			rewardId: reward.id,
			cart: loyaltyCart,
		})
		if (!priced.quote.applicable) {
			throw new RewardRefusal('not_applicable', priced.quote.code)
		}
		if (!priced.quote.affordable) {
			throw new RewardRefusal('not_affordable', priced.quote.code)
		}
		const saleId = ensureSaleId(env, cart.activeOrderId)
		const approval = await env.api.requestApproval({
			binding,
			rewardId: reward.id,
			rewardVersion: priced.quote.rewardVersion,
			saleId,
			cart: loyaltyCart,
			targetLineId: priced.quote.targetLineId,
			idempotencyKey: env.uuid(),
		})
		patch({ quoting: null, waiting: { approval, otpSent: false } })
		return settle(env, approval)
	} catch (error) {
		patch({ quoting: null })
		noteUnavailable(error)
		throw error
	}
}

/**
 * Records what the region answered about the approval: an approved reward goes
 * on the cart; a declined, expired or cancelled one ends the request.
 */
function settle(env: Env, approval: LoyaltyApproval): LoyaltyApproval {
	if (approval.status === 'approved') {
		env.applyReward(rewardAdjustment(approval))
		patch({
			waiting: null,
			applied: {
				approvalId: approval.id,
				name: approval.rewardName,
				discountMinor: approval.discountMinor,
			},
		})
	} else if (approval.status !== 'pending') {
		patch({ waiting: null, saleId: null })
	} else {
		const otpSent = useLoyalty.getState().waiting?.otpSent ?? false
		patch({
			waiting: { approval, otpSent: otpSent || approval.otpSentAt !== null },
		})
	}
	return approval
}

/** Asks the region where the approval stands (the till polls while the member decides). */
export async function pollApproval(env: Env): Promise<LoyaltyApproval | null> {
	const waiting = useLoyalty.getState().waiting
	if (!waiting) return null
	const fresh = await env.api.approval(waiting.approval.id)
	// The cashier may have cancelled or the order cleared while this was in flight.
	if (useLoyalty.getState().waiting?.approval.id !== fresh.id) return fresh
	return settle(env, fresh)
}

/** Texts the member a one-time code to approve the spend. */
export async function sendApprovalCode(env: Env): Promise<LoyaltyApproval> {
	const waiting = useLoyalty.getState().waiting
	if (!waiting) throw new RewardRefusal('no_request')
	const approval = await env.api.sendOtp(waiting.approval.id)
	patch({ waiting: { approval, otpSent: true } })
	return approval
}

/** The member read the code back. */
export async function submitApprovalCode(
	env: Env,
	otp: string,
): Promise<LoyaltyApproval> {
	const waiting = useLoyalty.getState().waiting
	if (!waiting) throw new RewardRefusal('no_request')
	return settle(env, await env.api.verifyOtp(waiting.approval.id, otp))
}

/**
 * Takes the reward off: withdraws the request (an approved one gives the points
 * back) and removes the row from the cart. A request that cannot be reached
 * is still dropped here; the region releases it when the sale never carries it.
 */
export async function removeReward(env: Env): Promise<void> {
	const { waiting, applied } = useLoyalty.getState()
	const approvalId = waiting?.approval.id ?? applied?.approvalId ?? null
	patch({ waiting: null, applied: null, quoting: null, saleId: null })
	env.applyReward(null)
	if (approvalId) await env.api.cancelApproval(approvalId).catch(() => null)
	await refreshMember(env)
}

/**
 * The cart store dropped an approved reward because the cart changed: give the
 * points back. Nothing to take off the cart, it is already gone.
 */
export async function handleRewardDropped(
	env: Env,
	approvalId: string,
): Promise<void> {
	const { applied, waiting } = useLoyalty.getState()
	// Only an approval this session made is this till's to give back. A reward
	// that came in on a loaded tab is already stored on that order (and may be
	// held by another terminal that took it over): cancelling it here would
	// return the points while the saved tab still carries the discount.
	const owned =
		applied?.approvalId === approvalId || waiting?.approval.id === approvalId
	if (!owned) return
	if (applied?.approvalId === approvalId) patch({ applied: null, saleId: null })
	if (waiting?.approval.id === approvalId)
		patch({ waiting: null, saleId: null })
	await env.api.cancelApproval(approvalId).catch(() => null)
	await refreshMember(env)
}

/** The sale was placed carrying its reward (and member): clearing the order keeps the reward. */
export function markPlaced(): void {
	patch({ placed: true })
}

/**
 * The cashier forgets the member: the reward goes back, and the terminal tells
 * the region to forget the binding.
 */
export async function forgetMember(env: Env): Promise<void> {
	await endSession(env, { giveBackReward: true })
}

/**
 * The order on screen is gone. A sold or saved order keeps its reward (the
 * region settles it from the upload); anything else gives it back. The binding
 * is forgotten either way, so it cannot be used for the next sale.
 */
export async function handleCleared(env: Env): Promise<void> {
	const { placed } = useLoyalty.getState()
	await endSession(env, { giveBackReward: !placed })
}

async function endSession(
	env: Env,
	options: { giveBackReward: boolean },
): Promise<void> {
	const { member, waiting, applied, unavailable } = useLoyalty.getState()
	// `unavailable` is about the restaurant, not the sale: keep what was learnt.
	useLoyalty.setState({ ...initialLoyaltyState, unavailable }, false)
	const approvalId = waiting?.approval.id ?? applied?.approvalId ?? null
	if (options.giveBackReward && approvalId) {
		env.applyReward(null)
		await env.api.cancelApproval(approvalId).catch(() => null)
	}
	// The order that was sold keeps its own copy of the binding for the upload,
	// and a revoked binding still credits a sale made while it was good. Best
	// effort: it expires on its own after 12 hours.
	if (member) await env.api.revoke(member.binding).catch(() => null)
}

/**
 * Wires the cart store's notices to this session. Called once when the till
 * starts; the environment is read when a notice arrives.
 */
export function listenToCart(makeEnv: () => Env = liveEnv): void {
	registerLoyaltyListeners({
		dropped: (approvalId) => void handleRewardDropped(makeEnv(), approvalId),
		cleared: () => void handleCleared(makeEnv()),
	})
}
