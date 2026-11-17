import {
	type FinancialSaleRow,
	summarizeFinancialPeriod,
	type FinancialPeriodSummary,
} from '@repo/common/financial-period-summary'
import { type SalesBasis } from '@repo/common/sales-report-facts'
import {
	createReportDefinition,
	getSubject,
	type ReportDefinition,
	type TimeframePreset,
} from '@repo/reports'
import { activeReportCatalog } from '../restaurant/staffing-report-catalog.ts'
import {
	loadSalesRecords,
	loadOrderRefundRecords,
	type SalesReportContext,
} from './sales-report-records.ts'

function taxRateBpFromPercent(ratePercent: number | null | undefined): number {
	if (ratePercent == null || !Number.isFinite(ratePercent)) return 0
	return Math.round(ratePercent * 100)
}

function saleRowFromRecord(
	record: Record<string, unknown>,
	salesBasis: SalesBasis,
): FinancialSaleRow | null {
	if (record.entry === 'refund') return null
	const netSales = Number(record.netSales ?? 0)
	if (!Number.isFinite(netSales)) return null
	const tax = Number(record.tax ?? 0)
	const tips = Number(record.tips ?? 0)
	const discounts = Number(record.discounts ?? 0)
	const serviceFee = Number(record.serviceFee ?? 0)
	const packagingFee = Number(record.packagingFee ?? 0)
	const gross =
		salesBasis === 'gross'
			? netSales + discounts
			: netSales + discounts + (Number(record.rewards ?? 0) || 0)
	const taxMinor = Math.round(tax * 100)
	const rateBp = taxRateBpFromPercent(
		typeof record.taxRatePercent === 'number' ? record.taxRatePercent : null,
	)
	return {
		netMinor: Math.round(netSales * 100),
		grossMinor: Math.round(gross * 100),
		discountMinor: Math.round(discounts * 100),
		taxMinor,
		tipMinor: Math.round(tips * 100),
		serviceFeeMinor: Math.round(serviceFee * 100),
		packagingFeeMinor: Math.round(packagingFee * 100),
		refundMinor: 0,
		taxByRateBp:
			taxMinor > 0 && rateBp > 0
				? [{ rateBp, taxMinor }]
				: taxMinor > 0
					? [{ rateBp: 0, taxMinor }]
					: [],
	}
}

const salesDefinition = (preset: TimeframePreset): ReportDefinition =>
	createReportDefinition({
		subject: 'sales',
		timeframe: { field: 'occurredAt', preset },
		visualization: { chartStyle: 'table' },
		settings: { title: 'Sales', timezone: 'organization' },
	})

export async function loadFinancialPeriodSummary(
	ctx: SalesReportContext,
	preset: ReportDefinition['timeframe']['preset'],
	salesBasis: SalesBasis,
): Promise<FinancialPeriodSummary> {
	const catalog = activeReportCatalog()
	const subject = getSubject(catalog, 'sales')
	if (!subject) {
		return summarizeFinancialPeriod([])
	}
	const definition = salesDefinition(preset)
	const { records: sales } = await loadSalesRecords(ctx, subject, definition)
	const { records: refunds } = await loadOrderRefundRecords(ctx, definition)
	const rows: FinancialSaleRow[] = []
	for (const record of sales) {
		const row = saleRowFromRecord(record, salesBasis)
		if (row) rows.push(row)
	}
	let refundTotal = 0
	for (const record of refunds) {
		const amount = Number(record.refunds ?? 0)
		if (Number.isFinite(amount)) refundTotal += Math.round(amount * 100)
	}
	if (rows.length > 0 && refundTotal > 0) {
		const first = rows[0]!
		rows[0] = { ...first, refundMinor: refundTotal }
	} else if (refundTotal > 0) {
		rows.push({
			netMinor: 0,
			grossMinor: 0,
			discountMinor: 0,
			taxMinor: 0,
			tipMinor: 0,
			serviceFeeMinor: 0,
			packagingFeeMinor: 0,
			refundMinor: refundTotal,
			taxByRateBp: [],
		})
	}
	return summarizeFinancialPeriod(rows)
}
