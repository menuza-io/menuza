import { type PolicyMode } from './config.ts'

export type ReservationPolicyRuleInput = {
	id: string
	name: string
	mode: PolicyMode
	amountMinor?: number
	amount_minor?: number
	perCover?: boolean | number
	per_cover?: boolean | number
	currency: string
	minParty?: number
	min_party?: number
	serviceId?: string | null
	service_id?: string | null
	daysOfWeek?: readonly number[] | null
	days_of_week?: readonly number[] | null
	windowStartMin?: number | null
	window_start_min?: number | null
	windowEndMin?: number | null
	window_end_min?: number | null
	cancelCutoffMin?: number
	cancel_cutoff_min?: number
	noShowFeeMinor?: number | null
	no_show_fee_minor?: number | null
	priority?: number
	active?: boolean | number
}

export type PolicySelectionContext = {
	serviceId?: string | null
	dayOfWeek: number
	slotMin: number
	partySize: number
}

export type PolicySnapshot = {
	policyId: string
	name: string
	mode: PolicyMode
	amountMinor: number
	perCover: boolean
	partySize: number
	totalAmountMinor: number
	currency: string
	cancelCutoffMin: number
	noShowFeeMinor: number
}

function toBool(v: boolean | number | undefined, fallback = true): boolean {
	if (v === undefined) return fallback
	return v === true || v === 1
}

/**
 * Select the most specific active policy rule matching `{ serviceId, dayOfWeek, slotMin, partySize }`.
 * Higher `priority` wins; ties break by specificity (service match, window match, higher `minParty`) and `id`.
 */
export function selectPolicy(
	rules: readonly ReservationPolicyRuleInput[],
	context: PolicySelectionContext,
): ReservationPolicyRuleInput | null {
	const matching = rules.filter((r) => {
		if (!toBool(r.active, true)) return false
		const minParty = r.minParty ?? r.min_party ?? 1
		if (context.partySize < minParty) return false

		const sId = r.serviceId ?? r.service_id ?? null
		if (sId !== null && sId !== context.serviceId) return false

		const dows = r.daysOfWeek ?? r.days_of_week ?? null
		if (dows && dows.length > 0 && !dows.includes(context.dayOfWeek)) {
			return false
		}

		const wStart = r.windowStartMin ?? r.window_start_min ?? null
		const wEnd = r.windowEndMin ?? r.window_end_min ?? null
		if (wStart !== null && context.slotMin < wStart) return false
		if (wEnd !== null && context.slotMin >= wEnd) return false

		return true
	})

	if (matching.length === 0) return null

	matching.sort((a, b) => {
		const prioA = a.priority ?? 0
		const prioB = b.priority ?? 0
		if (prioA !== prioB) return prioB - prioA

		const specA =
			((a.serviceId ?? a.service_id) ? 4 : 0) +
			((a.windowStartMin ?? a.window_start_min) !== null ? 2 : 0) +
			(a.minParty ?? a.min_party ?? 1)
		const specB =
			((b.serviceId ?? b.service_id) ? 4 : 0) +
			((b.windowStartMin ?? b.window_start_min) !== null ? 2 : 0) +
			(b.minParty ?? b.min_party ?? 1)
		if (specA !== specB) return specB - specA

		return a.id.localeCompare(b.id)
	})

	return matching[0] ?? null
}

/**
 * Build an immutable `PolicySnapshot` stored on `reservation.policy_snapshot` at booking time.
 */
export function snapshotPolicy(
	rule: ReservationPolicyRuleInput,
	partySize: number,
): PolicySnapshot {
	const amountMinor = rule.amountMinor ?? rule.amount_minor ?? 0
	const perCover = toBool(rule.perCover ?? rule.per_cover, true)
	const totalAmountMinor =
		rule.mode === 'none' ? 0 : perCover ? amountMinor * partySize : amountMinor
	const rawNoShow = rule.noShowFeeMinor ?? rule.no_show_fee_minor
	const noShowBase =
		rawNoShow !== undefined && rawNoShow !== null ? rawNoShow : amountMinor
	const noShowFeeMinor =
		rule.mode === 'none' ? 0 : perCover ? noShowBase * partySize : noShowBase

	return {
		policyId: rule.id,
		name: rule.name,
		mode: rule.mode,
		amountMinor,
		perCover,
		partySize,
		totalAmountMinor,
		currency: rule.currency.toUpperCase(),
		cancelCutoffMin: rule.cancelCutoffMin ?? rule.cancel_cutoff_min ?? 0,
		noShowFeeMinor,
	}
}

export type CancellationTermsResult = {
	freeCancelDeadlineMs: number
	withinFreeWindow: boolean
	refundableMinor: number
	forfeitedMinor: number
}

/**
 * Evaluate cancellation window and refund/forfeiture terms at `nowMs`.
 */
export function cancellationTerms(input: {
	snapshot: PolicySnapshot
	startAtMs: number
	nowMs: number
	capturedMinor?: number
}): CancellationTermsResult {
	const { snapshot, startAtMs, nowMs } = input
	const captured =
		input.capturedMinor ??
		(snapshot.mode === 'deposit' || snapshot.mode === 'prepay'
			? snapshot.totalAmountMinor
			: 0)
	const freeCancelDeadlineMs = startAtMs - snapshot.cancelCutoffMin * 60_000
	const withinFreeWindow = nowMs <= freeCancelDeadlineMs

	if (snapshot.mode === 'none') {
		return {
			freeCancelDeadlineMs,
			withinFreeWindow: true,
			refundableMinor: 0,
			forfeitedMinor: 0,
		}
	}

	if (withinFreeWindow) {
		return {
			freeCancelDeadlineMs,
			withinFreeWindow: true,
			refundableMinor: captured,
			forfeitedMinor: 0,
		}
	}

	return {
		freeCancelDeadlineMs,
		withinFreeWindow: false,
		refundableMinor: 0,
		forfeitedMinor:
			snapshot.mode === 'card_hold' ? snapshot.noShowFeeMinor : captured,
	}
}

/**
 * Compute refund amount in minor units on cancellation.
 */
export function refundAmount(input: {
	snapshot: PolicySnapshot
	capturedMinor: number
	startAtMs: number
	nowMs: number
	overrideFullRefund?: boolean
}): number {
	if (input.capturedMinor <= 0) return 0
	if (input.overrideFullRefund) return input.capturedMinor
	const terms = cancellationTerms({
		snapshot: input.snapshot,
		startAtMs: input.startAtMs,
		nowMs: input.nowMs,
		capturedMinor: input.capturedMinor,
	})
	return terms.withinFreeWindow ? input.capturedMinor : 0
}

/**
 * Compute off-session charge (`amountToChargeMinor`) or retained deposit (`amountRetainedMinor`)
 * when a reservation is marked `no_show`.
 */
export function noShowFee(input: {
	snapshot: PolicySnapshot
	capturedMinor: number
}): {
	amountToChargeMinor: number
	amountRetainedMinor: number
} {
	const { snapshot, capturedMinor } = input
	if (snapshot.mode === 'none') {
		return { amountToChargeMinor: 0, amountRetainedMinor: 0 }
	}
	if (snapshot.mode === 'card_hold') {
		return {
			amountToChargeMinor: Math.max(0, snapshot.noShowFeeMinor - capturedMinor),
			amountRetainedMinor: capturedMinor,
		}
	}
	return {
		amountToChargeMinor: 0,
		amountRetainedMinor: capturedMinor,
	}
}

/**
 * Compute platform application fee in minor units (`Math.floor(grossMinor * feeBp / 10_000)`) (`VAL-PAY-051`).
 */
export function platformFeeMinor(grossMinor: number, feeBp: number): number {
	if (grossMinor <= 0 || feeBp <= 0) return 0
	const clampedBp = Math.max(0, Math.min(10_000, Math.trunc(feeBp)))
	return Math.floor((Math.trunc(grossMinor) * clampedBp) / 10_000)
}

/**
 * Compute proportional platform fee refund on full or partial refunds (`VAL-PAY-051`).
 */
export function proportionalFeeRefund(
	originalFeeMinor: number,
	refundMinor: number,
	grossMinor: number,
): number {
	if (originalFeeMinor <= 0 || refundMinor <= 0 || grossMinor <= 0) return 0
	if (refundMinor >= grossMinor) return originalFeeMinor
	return Math.min(
		originalFeeMinor,
		Math.floor((originalFeeMinor * refundMinor) / grossMinor),
	)
}

const CURRENCY_MINIMUM_MINOR: Readonly<Record<string, number>> = {
	USD: 50,
	EUR: 50,
	GBP: 30,
	CAD: 50,
	AUD: 50,
	SAR: 200,
	AED: 200,
	KWD: 150,
	BHD: 200,
	QAR: 200,
}

/**
 * Return the minimum chargeable minor units for `currency` (`VAL-PAY-051`).
 */
export function currencyMinimum(currency: string): number {
	return CURRENCY_MINIMUM_MINOR[currency.toUpperCase()] ?? 50
}
