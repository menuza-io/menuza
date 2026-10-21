/**
 * Payment policy math (pure: no I/O, no provider calls, no UI strings).
 *
 * Money is integer minor units. A policy row is snapshotted onto the
 * reservation at booking time (`rsv_reservations.policy_snapshot`); every later
 * decision (cancellation terms, refunds, fees) reads the snapshot, never the
 * live policy, so editing a policy never changes a booking already made.
 */

export const POLICY_KINDS = [
	'none',
	'card_guarantee',
	'deposit',
	'prepay',
] as const
export type PolicyKind = (typeof POLICY_KINDS)[number]
export type PolicyRefundRule = 'full_before_window' | 'none' | 'partial'

/** The columns of an `rsv_policies` row the math needs. */
export type PolicyInput = {
	id: string
	name: string
	kind: string
	amountMinor: number
	perCover: boolean
	currency: string
	freeCancelUntilMin: number
	lateCancelFeeMinor: number
	noShowFeeMinor: number
	feePerCover: boolean
	feeCapMinor: number | null
	refundRule: PolicyRefundRule
	partialRefundBp: number | null
	appliesPartyMin: number | null
	termsVersion: number
	archivedAt?: number | null
}

export type PolicySnapshot = {
	policyId: string
	name: string
	kind: PolicyKind
	termsVersion: number
	partySize: number
	amountMinor: number
	perCover: boolean
	/** What is charged at booking (0 for a card guarantee). */
	totalAmountMinor: number
	currency: string
	freeCancelUntilMin: number
	/** Same number as `freeCancelUntilMin`; the late-cancel check reads this key. */
	cancelCutoffMin: number
	lateCancelFeeMinor: number
	noShowFeeMinor: number
	feePerCover: boolean
	feeCapMinor: number | null
	refundRule: PolicyRefundRule
	partialRefundBp: number | null
}

export type PolicyCandidates = {
	experience?: PolicyInput | null
	service?: PolicyInput | null
	location?: PolicyInput | null
}

function appliesTo(policy: PolicyInput, partySize: number): boolean {
	if (policy.archivedAt) return false
	if (policy.kind === 'none') return false
	return partySize >= (policy.appliesPartyMin ?? 1)
}

/**
 * Precedence: experience policy, then service policy, then the location
 * default. A policy that does not apply to the party (`applies_party_min`) is
 * skipped, so a narrower policy never hides the default for small parties.
 */
export function selectPolicy(
	candidates: PolicyCandidates,
	partySize: number,
): PolicyInput | null {
	for (const policy of [
		candidates.experience,
		candidates.service,
		candidates.location,
	]) {
		if (policy && appliesTo(policy, partySize)) return policy
	}
	return null
}

export function policyRequiresPayment(kind: string): boolean {
	return kind === 'deposit' || kind === 'prepay' || kind === 'card_guarantee'
}

/** Gross charged at booking: per cover or flat; a card guarantee charges nothing. */
export function policyTotalMinor(
	policy: Pick<PolicyInput, 'kind' | 'amountMinor' | 'perCover'>,
	partySize: number,
): number {
	if (policy.kind !== 'deposit' && policy.kind !== 'prepay') return 0
	return policy.perCover ? policy.amountMinor * partySize : policy.amountMinor
}

export function snapshotPolicy(
	policy: PolicyInput,
	partySize: number,
): PolicySnapshot {
	return {
		policyId: policy.id,
		name: policy.name,
		kind: policy.kind as PolicyKind,
		termsVersion: policy.termsVersion,
		partySize,
		amountMinor: policy.amountMinor,
		perCover: policy.perCover,
		totalAmountMinor: policyTotalMinor(policy, partySize),
		currency: policy.currency.toUpperCase(),
		freeCancelUntilMin: policy.freeCancelUntilMin,
		cancelCutoffMin: policy.freeCancelUntilMin,
		lateCancelFeeMinor: policy.lateCancelFeeMinor,
		noShowFeeMinor: policy.noShowFeeMinor,
		feePerCover: policy.feePerCover,
		feeCapMinor: policy.feeCapMinor,
		refundRule: policy.refundRule,
		partialRefundBp: policy.partialRefundBp,
	}
}

export type CancellationTerms = {
	/** The free-cancellation deadline (epoch ms). */
	freeUntilMs: number
	/** Cancelled before the deadline: nothing is forfeited. */
	free: boolean
	lateCancel: boolean
	/** Late-cancel fee the restaurant may charge (guarantee on file), clamped. */
	feeMinor: number
	/** Share of `paidMinor` refunded on a guest cancel at `nowMs`. */
	refundMinor: number
}

function clampFee(
	snapshot: Pick<PolicySnapshot, 'feePerCover' | 'feeCapMinor' | 'partySize'>,
	baseMinor: number,
): number {
	const gross = snapshot.feePerCover
		? baseMinor * snapshot.partySize
		: baseMinor
	const capped =
		snapshot.feeCapMinor !== null && snapshot.feeCapMinor !== undefined
			? Math.min(gross, snapshot.feeCapMinor)
			: gross
	return Math.max(0, capped)
}

/**
 * Terms of a GUEST cancellation at `nowMs` (a restaurant cancellation is
 * always a full refund: see `refundOnCancel`). Free until
 * `start - freeCancelUntilMin`; inside the window the refund follows the rule:
 * `none` and `full_before_window` refund nothing, `partial` refunds
 * `partialRefundBp` of what was paid (floor).
 */
export function cancellationTerms(input: {
	snapshot: PolicySnapshot
	startAtMs: number
	nowMs: number
	paidMinor?: number
}): CancellationTerms {
	const { snapshot, startAtMs, nowMs } = input
	const paid = Math.max(0, input.paidMinor ?? 0)
	const freeUntilMs = startAtMs - snapshot.cancelCutoffMin * 60_000
	const free = nowMs <= freeUntilMs
	let refundMinor = 0
	if (free) refundMinor = paid
	else if (snapshot.refundRule === 'partial' && snapshot.partialRefundBp) {
		refundMinor = Math.floor(
			(paid * Math.min(10_000, snapshot.partialRefundBp)) / 10_000,
		)
	}
	return {
		freeUntilMs,
		free,
		lateCancel: !free,
		feeMinor: free ? 0 : clampFee(snapshot, snapshot.lateCancelFeeMinor),
		refundMinor,
	}
}

/** Refund on cancellation: the restaurant always refunds in full. */
export function refundOnCancel(input: {
	snapshot: PolicySnapshot
	startAtMs: number
	nowMs: number
	paidMinor: number
	cancelledBy: 'guest' | 'restaurant' | 'system' | string
}): number {
	if (input.paidMinor <= 0) return 0
	if (input.cancelledBy !== 'guest') return input.paidMinor
	return cancellationTerms(input).refundMinor
}

/** The no-show fee: per cover or flat, clamped to the cap. */
export function noShowFee(snapshot: PolicySnapshot): number {
	return clampFee(snapshot, snapshot.noShowFeeMinor)
}

export function currencyMinimum(currency: string): number {
	return CURRENCY_MINIMUM_MINOR[currency.toUpperCase()] ?? 50
}

const CURRENCY_MINIMUM_MINOR: Readonly<Record<string, number>> = {
	USD: 50,
	CAD: 50,
	EUR: 50,
	GBP: 30,
	AUD: 50,
	SAR: 200,
	AED: 200,
	KWD: 150,
	BHD: 200,
	QAR: 200,
}

export type FeeAmountResult =
	| { ok: true; amountMinor: number }
	| { ok: false; code: 'fee_not_allowed' | 'invalid'; reason: string }

/**
 * The amount to charge for a fee: the snapshot amount, or a LOWER amount the
 * operator chose. Never higher, never below the currency minimum, never zero.
 */
export function resolveFeeAmount(input: {
	snapshot: PolicySnapshot
	kind: 'no_show_fee' | 'late_cancel_fee'
	requestedMinor?: number | null
}): FeeAmountResult {
	const maxMinor =
		input.kind === 'no_show_fee'
			? noShowFee(input.snapshot)
			: clampFee(input.snapshot, input.snapshot.lateCancelFeeMinor)
	if (maxMinor <= 0) {
		return { ok: false, code: 'fee_not_allowed', reason: 'no_fee_configured' }
	}
	const amount = input.requestedMinor ?? maxMinor
	if (!Number.isInteger(amount) || amount <= 0) {
		return { ok: false, code: 'invalid', reason: 'amount_invalid' }
	}
	if (amount > maxMinor) {
		return { ok: false, code: 'fee_not_allowed', reason: 'above_policy_fee' }
	}
	if (amount < currencyMinimum(input.snapshot.currency)) {
		return { ok: false, code: 'fee_not_allowed', reason: 'below_minimum' }
	}
	return { ok: true, amountMinor: amount }
}

/**
 * Platform fee on a gross amount in basis points: `floor(gross * bp / 10000)`.
 * Always rounds down, so the platform never takes more than the stated rate.
 */
export function platformFeeMinor(grossMinor: number, feeBp: number): number {
	if (grossMinor <= 0 || feeBp <= 0) return 0
	const clampedBp = Math.max(0, Math.min(10_000, Math.trunc(feeBp)))
	return Math.floor((Math.trunc(grossMinor) * clampedBp) / 10_000)
}

/**
 * Fee reversed by one refund, from the cumulative share refunded so far:
 * `round(fee * refundedAfter / gross) - alreadyReversed`. Rounding half up on
 * the cumulative amount makes the parts sum to exactly the snapshot once the
 * payment is fully refunded (333 on 3333: 167 for 1667, then 166 for 1666).
 */
export function proportionalFeeRefund(
	originalFeeMinor: number,
	refundMinor: number,
	grossMinor: number,
	refundedBeforeMinor = 0,
	feeReversedBeforeMinor = 0,
): number {
	if (originalFeeMinor <= 0 || refundMinor <= 0 || grossMinor <= 0) return 0
	const refundedAfter = Math.min(grossMinor, refundedBeforeMinor + refundMinor)
	const target =
		refundedAfter >= grossMinor
			? originalFeeMinor
			: Math.round((originalFeeMinor * refundedAfter) / grossMinor)
	return Math.max(
		0,
		Math.min(originalFeeMinor, target) - Math.max(0, feeReversedBeforeMinor),
	)
}
