import { type PosPaymentLineShare } from './pos-orders.ts'

/**
 * Pure split-check-by-item math for Station (#289).
 *
 * Guarantees:
 * - Every line's shares across checks sum to 1 (100%).
 * - A shared dish divides to the cent with any remainder on the FIRST check
 *   that holds a share of that dish.
 * - Item-level discounts stay with their item; order-level discounts apportion
 *   in proportion to each check's net subtotal (remainder on first check).
 * - Tax, service charge, and delivery fee follow the items in proportion, with
 *   remainder reconciliation so the sum of all checks' totals ALWAYS equals
 *   the order total to the cent.
 * - Each check carries ONLY its own items for its receipt, its own tip, and
 *   its own optional loyalty customer id.
 */

export type SplitCheckLine = {
	id: string
	name: string
	quantity: number
	totalCents: number
	taxableCents: number
	/** Item-level discount that stays with this item. */
	itemDiscountCents?: number
}

export type SplitCheckAssignment = {
	lineId: string
	shareNum: number
	shareDen: number
}

export type SplitCheckSpec = {
	checkNumber: number
	assignments: SplitCheckAssignment[]
	tipCents?: number
	loyaltyCustomerId?: string | null
}

export type SplitCheckReceiptLine = {
	lineId: string
	name: string
	quantity: number
	shareNum: number
	shareDen: number
	amountCents: number
	itemDiscountCents: number
}

export type SplitCheckResult = {
	checkNumber: number
	items: SplitCheckReceiptLine[]
	lineShares: PosPaymentLineShare[]
	subtotalCents: number
	itemDiscountCents: number
	orderDiscountCents: number
	discountCents: number
	serviceChargeCents: number
	deliveryFeeCents: number
	taxCents: number
	tipCents: number
	totalCents: number
	loyaltyCustomerId: string | null
}

export type SplitCheckPlan = {
	checks: SplitCheckResult[]
	orderSubtotalCents: number
	orderDiscountCents: number
	orderServiceChargeCents: number
	orderDeliveryFeeCents: number
	orderTaxCents: number
	orderTotalWithoutTipCents: number
	totalTipsCents: number
	grandTotalWithTipsCents: number
}

/**
 * Apportions `totalCents` across `weights` to the exact cent, placing any
 * rounding remainder on the first bucket with positive weight (or index 0).
 */
export function apportionCents(
	totalCents: number,
	weights: number[],
): number[] {
	const n = weights.length
	if (n === 0) return []
	if (totalCents === 0) return Array.from({ length: n }, () => 0)
	const totalWeight = weights.reduce((s, w) => s + Math.max(0, w), 0)
	if (totalWeight <= 0) {
		const out = Array.from({ length: n }, () => 0)
		out[0] = totalCents
		return out
	}
	const shares = weights.map((w) =>
		Math.floor((totalCents * Math.max(0, w)) / totalWeight),
	)
	const allocated = shares.reduce((s, v) => s + v, 0)
	const remainder = totalCents - allocated
	if (remainder !== 0) {
		const firstPositive = weights.findIndex((w) => w > 0)
		const idx = firstPositive >= 0 ? firstPositive : 0
		shares[idx] = (shares[idx] ?? 0) + remainder
	}
	return shares
}

export function splitCheckByItem(input: {
	lines: SplitCheckLine[]
	checks: SplitCheckSpec[]
	/** Order-level discount (shared proportionally across checks). */
	orderDiscountCents?: number
	taxRatePercent: number
	taxInclusive: boolean
	taxExempt?: boolean
	/** Order-level service charge (before tax if exclusive). */
	serviceChargeCents?: number
	serviceChargeTaxCents?: number
	deliveryFeeCents?: number
}): SplitCheckPlan {
	const { lines, checks } = input
	if (checks.length === 0) {
		throw new Error('At least one check is required')
	}

	const lineMap = new Map(lines.map((l) => [l.id, l]))

	// Validate that every line's shares sum to 1 (within rational tolerance)
	// and divide each line's amount + itemDiscount + taxable to the cent with
	// remainder on the FIRST check holding a share of that line.
	type LineAlloc = {
		checkIndex: number
		shareNum: number
		shareDen: number
		amountCents: number
		itemDiscountCents: number
		taxableCents: number
	}
	const perCheckItems: SplitCheckReceiptLine[][] = checks.map(() => [])
	const perCheckLineShares: PosPaymentLineShare[][] = checks.map(() => [])
	const perCheckSubtotals = Array.from({ length: checks.length }, () => 0)
	const perCheckItemDiscounts = Array.from({ length: checks.length }, () => 0)
	const perCheckTaxables = Array.from({ length: checks.length }, () => 0)

	for (const line of lines) {
		const holders: Array<{
			checkIndex: number
			shareNum: number
			shareDen: number
			weight: number
		}> = []
		let fractionSum = 0
		for (let i = 0; i < checks.length; i++) {
			for (const a of checks[i]!.assignments) {
				if (a.lineId === line.id) {
					if (a.shareNum <= 0 || a.shareDen <= 0) {
						throw new Error(`Invalid share for line ${line.id}`)
					}
					const w = a.shareNum / a.shareDen
					fractionSum += w
					holders.push({
						checkIndex: i,
						shareNum: a.shareNum,
						shareDen: a.shareDen,
						weight: w,
					})
				}
			}
		}
		if (holders.length === 0 || Math.abs(fractionSum - 1) > 1e-6) {
			throw new Error(
				`Line ${line.id} shares must sum to 1 (got ${fractionSum})`,
			)
		}

		const weights = holders.map((h) => h.weight)
		const amounts = apportionCents(line.totalCents, weights)
		const itemDiscounts = apportionCents(line.itemDiscountCents ?? 0, weights)
		const taxables = apportionCents(line.taxableCents, weights)

		const allocs: LineAlloc[] = holders.map((h, idx) => ({
			checkIndex: h.checkIndex,
			shareNum: h.shareNum,
			shareDen: h.shareDen,
			amountCents: amounts[idx]!,
			itemDiscountCents: itemDiscounts[idx]!,
			taxableCents: taxables[idx]!,
		}))

		for (const alloc of allocs) {
			perCheckItems[alloc.checkIndex]!.push({
				lineId: line.id,
				name: line.name,
				quantity: line.quantity,
				shareNum: alloc.shareNum,
				shareDen: alloc.shareDen,
				amountCents: alloc.amountCents,
				itemDiscountCents: alloc.itemDiscountCents,
			})
			perCheckLineShares[alloc.checkIndex]!.push({
				lineId: line.id,
				shareNum: alloc.shareNum,
				shareDen: alloc.shareDen,
				amountCents: alloc.amountCents,
			})
			perCheckSubtotals[alloc.checkIndex]! += alloc.amountCents
			perCheckItemDiscounts[alloc.checkIndex]! += alloc.itemDiscountCents
			perCheckTaxables[alloc.checkIndex]! += alloc.taxableCents
		}
	}

	// Verify no unknown lineIds were assigned.
	for (const check of checks) {
		for (const a of check.assignments) {
			if (!lineMap.has(a.lineId)) {
				throw new Error(`Unknown lineId ${a.lineId}`)
			}
		}
	}

	const orderSubtotalCents = lines.reduce((s, l) => s + l.totalCents, 0)
	const totalItemDiscountCents = lines.reduce(
		(s, l) => s + (l.itemDiscountCents ?? 0),
		0,
	)
	const netAfterItemDiscounts = perCheckSubtotals.map((sub, i) =>
		Math.max(0, sub - perCheckItemDiscounts[i]!),
	)
	const maxOrderDiscount = Math.max(
		0,
		orderSubtotalCents - totalItemDiscountCents,
	)
	const orderLevelDiscountCents = Math.min(
		maxOrderDiscount,
		Math.max(0, input.orderDiscountCents ?? 0),
	)
	const perCheckOrderDiscounts = apportionCents(
		orderLevelDiscountCents,
		netAfterItemDiscounts,
	)

	const perCheckNetBase = netAfterItemDiscounts.map((net, i) =>
		Math.max(0, net - perCheckOrderDiscounts[i]!),
	)
	const orderServiceChargeCents = Math.max(0, input.serviceChargeCents ?? 0)
	const perCheckServiceCharges = apportionCents(
		orderServiceChargeCents,
		perCheckNetBase,
	)
	const orderDeliveryFeeCents = Math.max(0, input.deliveryFeeCents ?? 0)
	const perCheckDeliveryFees = apportionCents(
		orderDeliveryFeeCents,
		perCheckNetBase,
	)

	// Compute authoritative order-level tax, then apportion by each check's taxable weight
	// so sum(check.taxCents) === orderTaxCents to the exact cent.
	const rate = Math.max(0, Math.min(100, input.taxRatePercent || 0))
	const orderTaxableRaw = lines.reduce((s, l) => s + l.taxableCents, 0)
	const orderTotalDiscount = totalItemDiscountCents + orderLevelDiscountCents
	const orderTaxBase = Math.max(0, orderTaxableRaw - orderTotalDiscount)
	const orderLineTaxCents = input.taxExempt
		? 0
		: input.taxInclusive
			? Math.round((orderTaxBase * rate) / (100 + rate))
			: Math.round((orderTaxBase * rate) / 100)
	const serviceChargeTaxCents = input.taxExempt
		? 0
		: Math.max(0, input.serviceChargeTaxCents ?? 0)
	const orderTaxCents = orderLineTaxCents + serviceChargeTaxCents

	const perCheckTaxWeights = perCheckTaxables.map((t, i) =>
		Math.max(0, t - perCheckItemDiscounts[i]! - perCheckOrderDiscounts[i]!),
	)
	const perCheckTaxes = apportionCents(orderTaxCents, perCheckTaxWeights)

	const results: SplitCheckResult[] = checks.map((check, i) => {
		const subtotalCents = perCheckSubtotals[i]!
		const itemDiscountCents = perCheckItemDiscounts[i]!
		const orderDiscountCents = perCheckOrderDiscounts[i]!
		const discountCents = itemDiscountCents + orderDiscountCents
		const serviceChargeCents = perCheckServiceCharges[i]!
		const deliveryFeeCents = perCheckDeliveryFees[i]!
		const taxCents = perCheckTaxes[i]!
		const tipCents = Math.max(0, check.tipCents ?? 0)
		const totalCents =
			subtotalCents -
			discountCents +
			serviceChargeCents +
			deliveryFeeCents +
			(input.taxInclusive ? 0 : taxCents) +
			tipCents
		return {
			checkNumber: check.checkNumber,
			items: perCheckItems[i]!,
			lineShares: perCheckLineShares[i]!,
			subtotalCents,
			itemDiscountCents,
			orderDiscountCents,
			discountCents,
			serviceChargeCents,
			deliveryFeeCents,
			taxCents,
			tipCents,
			totalCents,
			loyaltyCustomerId: check.loyaltyCustomerId ?? null,
		}
	})

	const orderTotalWithoutTipCents =
		orderSubtotalCents -
		orderTotalDiscount +
		orderServiceChargeCents +
		orderDeliveryFeeCents +
		(input.taxInclusive ? 0 : orderTaxCents)
	const totalTipsCents = results.reduce((s, c) => s + c.tipCents, 0)
	const grandTotalWithTipsCents = results.reduce((s, c) => s + c.totalCents, 0)

	return {
		checks: results,
		orderSubtotalCents,
		orderDiscountCents: orderTotalDiscount,
		orderServiceChargeCents,
		orderDeliveryFeeCents,
		orderTaxCents,
		orderTotalWithoutTipCents,
		totalTipsCents,
		grandTotalWithTipsCents,
	}
}
