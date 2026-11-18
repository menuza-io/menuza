import { type FinancialPeriodSummary } from './financial-period-summary.ts'

const headers = ['Metric', 'Amount (minor units)'] as const

function minorRows(summary: FinancialPeriodSummary): string[][] {
	return [
		['Orders', String(summary.orderCount)],
		['Net sales', String(summary.netSalesMinor)],
		['Gross sales', String(summary.grossSalesMinor)],
		['Discounts', String(summary.discountMinor)],
		['Tax', String(summary.taxMinor)],
		['Tips', String(summary.tipMinor)],
		['Service fees', String(summary.serviceFeeMinor)],
		['Packaging fees', String(summary.packagingFeeMinor)],
		['Refunds', String(summary.refundMinor)],
	]
}

/** CSV rows for the financial summary screen (same figures as the page). */
export function financialPeriodToCsv(summary: FinancialPeriodSummary): string {
	const lines: string[][] = [[...headers], ...minorRows(summary)]
	for (const row of summary.taxByRate) {
		lines.push([`Tax @ ${row.rateBp / 100}%`, String(row.taxMinor)])
	}
	return `${lines.map((row) => row.map(escapeCell).join(',')).join('\n')}\n`
}

function escapeCell(value: string): string {
	if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`
	return value
}
