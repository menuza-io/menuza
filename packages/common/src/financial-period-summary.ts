/**
 * Financial period totals for accounting summary (#391). Pure aggregation.
 */

export type FinancialSaleRow = {
	netMinor: number
	grossMinor: number
	discountMinor: number
	taxMinor: number
	tipMinor: number
	serviceFeeMinor: number
	packagingFeeMinor: number
	refundMinor: number
	taxByRateBp: ReadonlyArray<{ rateBp: number; taxMinor: number }>
}

export type FinancialPeriodSummary = {
	orderCount: number
	netSalesMinor: number
	grossSalesMinor: number
	discountMinor: number
	taxMinor: number
	tipMinor: number
	serviceFeeMinor: number
	packagingFeeMinor: number
	refundMinor: number
	taxByRate: Array<{ rateBp: number; taxMinor: number }>
}

export function summarizeFinancialPeriod(
	rows: readonly FinancialSaleRow[],
): FinancialPeriodSummary {
	const taxMap = new Map<number, number>()
	let orderCount = 0
	let net = 0
	let gross = 0
	let discount = 0
	let tax = 0
	let tip = 0
	let serviceFee = 0
	let packagingFee = 0
	let refund = 0
	for (const row of rows) {
		orderCount += 1
		net += row.netMinor
		gross += row.grossMinor
		discount += row.discountMinor
		tax += row.taxMinor
		tip += row.tipMinor
		serviceFee += row.serviceFeeMinor
		packagingFee += row.packagingFeeMinor
		refund += row.refundMinor
		for (const part of row.taxByRateBp) {
			taxMap.set(part.rateBp, (taxMap.get(part.rateBp) ?? 0) + part.taxMinor)
		}
	}
	return {
		orderCount,
		netSalesMinor: net,
		grossSalesMinor: gross,
		discountMinor: discount,
		taxMinor: tax,
		tipMinor: tip,
		serviceFeeMinor: serviceFee,
		packagingFeeMinor: packagingFee,
		refundMinor: refund,
		taxByRate: [...taxMap.entries()]
			.map(([rateBp, taxMinor]) => ({ rateBp, taxMinor }))
			.sort((a, b) => a.rateBp - b.rateBp),
	}
}
