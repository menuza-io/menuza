/**
 * Payout reconciliation, "From sales to deposit" bridge, unmatched detection,
 * and tips-by-order-type split (#168).
 *
 * Pure functions operating on opaque provider ids and minor-unit amounts.
 * Rule: the bridge ALWAYS adds up to the deposited amount; when it cannot
 * (e.g. data still arriving), status is `'matching'` and `bridge` is `null`.
 */

export type PayoutReconciliationStatus =
	'matched' | 'matching' | 'could_not_match'

export type PayoutBridgeLineKind =
	| 'period_sales'
	| 'other_payout_sales'
	| 'other_period_refunds'
	| 'provider_fees'
	| 'platform_fees'
	| 'disputes'
	| 'reserves'

export type PayoutBridgeLine = {
	kind: PayoutBridgeLineKind
	label: string
	/** Signed minor-unit amount (positive adds to deposit, negative subtracts). */
	amountCents: number
}

export type PayoutBridge = {
	lines: PayoutBridgeLine[]
	depositedCents: number
}

export type PayoutBridgeInput = {
	/** Total deposited by the provider into the bank account. */
	depositedCents: number
	/** Gross sales in the payout's period. */
	periodSalesCents: number
	/** Sales in the period that were paid out in other payouts (non-negative). */
	otherPayoutSalesCents: number
	/** Net refunds settled in this payout from another period (signed: negative reduces deposit). */
	otherPeriodRefundsCents: number
	/** Provider processing fees deducted in this payout (non-negative). */
	providerFeesCents: number
	/** Platform fees deducted in this payout (non-negative). */
	platformFeesCents: number
	/** Dispute debits/credits in this payout (signed: negative reduces deposit). */
	disputesCents: number
	/** Reserve holds/releases in this payout (signed: negative holds money). */
	reservesCents: number
	/** True when any provider transaction in this payout has no matching Menuza order. */
	hasUnmatched?: boolean
}

export type PayoutBridgeResult = {
	status: PayoutReconciliationStatus
	bridge: PayoutBridge | null
}

export function buildPayoutBridge(
	input: PayoutBridgeInput,
): PayoutBridgeResult {
	const lines: PayoutBridgeLine[] = [
		{
			kind: 'period_sales',
			label: 'Sales in period',
			amountCents: input.periodSalesCents,
		},
	]
	if (input.otherPayoutSalesCents !== 0) {
		lines.push({
			kind: 'other_payout_sales',
			label: 'Sales paid out in other payouts',
			amountCents: -Math.abs(input.otherPayoutSalesCents),
		})
	}
	if (input.otherPeriodRefundsCents !== 0) {
		lines.push({
			kind: 'other_period_refunds',
			label: 'Refunds settled from another period',
			amountCents: input.otherPeriodRefundsCents,
		})
	}
	if (input.providerFeesCents !== 0) {
		lines.push({
			kind: 'provider_fees',
			label: 'Provider processing fees',
			amountCents: -Math.abs(input.providerFeesCents),
		})
	}
	if (input.platformFeesCents !== 0) {
		lines.push({
			kind: 'platform_fees',
			label: 'Platform fees',
			amountCents: -Math.abs(input.platformFeesCents),
		})
	}
	// Rule: reserve and dispute lines appear ONLY when not zero.
	if (input.disputesCents !== 0) {
		lines.push({
			kind: 'disputes',
			label: 'Disputes',
			amountCents: input.disputesCents,
		})
	}
	if (input.reservesCents !== 0) {
		lines.push({
			kind: 'reserves',
			label: 'Reserves',
			amountCents: input.reservesCents,
		})
	}

	const sum = lines.reduce((acc, line) => acc + line.amountCents, 0)
	if (sum !== input.depositedCents) {
		// Never show a bridge that does not add up to the deposited amount.
		return {
			status: 'matching',
			bridge: null,
		}
	}

	return {
		status: input.hasUnmatched ? 'could_not_match' : 'matched',
		bridge: {
			lines,
			depositedCents: input.depositedCents,
		},
	}
}

export const UNMATCHED_ORDER_AGE_MS = 3 * 24 * 60 * 60 * 1000

export type ProviderTransactionRef = {
	id: string
	kind: 'payment' | 'refund' | 'dispute' | 'fee' | 'reserve' | 'adjustment'
	orderId: string | null
	orderType: string | null
	grossCents: number
	currency: string
	createdAt: string
}

export type RegionalPaidOrderRef = {
	id: string
	number: string
	totalCents: number
	currency: string
	paidAt: string | null
}

export function findUnmatchedTransactions(input: {
	providerTransactions: readonly ProviderTransactionRef[]
	regionalPaidOrders: readonly RegionalPaidOrderRef[]
	nowMs?: number
}): {
	unmatchedProvider: ProviderTransactionRef[]
	unmatchedOrders: RegionalPaidOrderRef[]
} {
	const nowMs = input.nowMs ?? Date.now()
	const knownOrderIds = new Set(input.regionalPaidOrders.map((o) => o.id))
	const providerOrderIds = new Set<string>()

	const unmatchedProvider: ProviderTransactionRef[] = []
	for (const txn of input.providerTransactions) {
		if (txn.orderId) {
			providerOrderIds.add(txn.orderId)
		}
		if (
			txn.kind === 'payment' &&
			(!txn.orderId || !knownOrderIds.has(txn.orderId))
		) {
			unmatchedProvider.push(txn)
		}
	}

	const unmatchedOrders: RegionalPaidOrderRef[] = []
	for (const order of input.regionalPaidOrders) {
		if (providerOrderIds.has(order.id)) continue
		if (!order.paidAt) continue
		const paidMs = Date.parse(order.paidAt)
		if (Number.isNaN(paidMs)) continue
		if (nowMs - paidMs >= UNMATCHED_ORDER_AGE_MS) {
			unmatchedOrders.push(order)
		}
	}

	return { unmatchedProvider, unmatchedOrders }
}

export type TipOrderTypeBucket = {
	orderType: string
	tipCents: number
	orderCount: number
}

export function splitTipsByOrderType(
	orders: readonly { orderType: string; tipCents: number }[],
): TipOrderTypeBucket[] {
	const map = new Map<string, { tipCents: number; orderCount: number }>()
	for (const order of orders) {
		if (!order.tipCents || order.tipCents <= 0) continue
		const key = order.orderType || 'online'
		const prev = map.get(key) ?? { tipCents: 0, orderCount: 0 }
		map.set(key, {
			tipCents: prev.tipCents + order.tipCents,
			orderCount: prev.orderCount + 1,
		})
	}
	return [...map.entries()]
		.map(([orderType, stats]) => ({ orderType, ...stats }))
		.sort((a, b) => a.orderType.localeCompare(b.orderType))
}
