import { describe, expect, it } from 'vitest'
import {
	buildSingleNumberSvg,
	canExportReport,
	clampExportSize,
	composeExportSvg,
	EXPORT_MAX_SIZE,
	EXPORT_MIN_SIZE,
	jpegToPdf,
	reportToCsv,
	slugFilename,
	TITLE_BAR_HEIGHT,
} from './export.ts'
import { type ReportResult, createReportDefinition } from './dsl.ts'

function tableDefinition() {
	return createReportDefinition({
		subject: 'customers',
		timeframe: { field: 'createdAt', preset: 'all_time' },
		groupBy: [],
		columns: ['name', 'email'],
		visualization: {
			chartStyle: 'table',
			measure: 'count',
			sortBy: 'none',
			hideCounts: false,
		},
		settings: { title: 'Customer list', notes: '', timezone: 'UTC' },
	})
}

describe('slugFilename', () => {
	it('slugifies the report title', () => {
		expect(slugFilename('Customers by week', 'png')).toBe(
			'customers-by-week.png',
		)
	})

	it('falls back when the title has no latin characters', () => {
		expect(slugFilename('!!!', 'csv')).toBe('report.csv')
	})
})

describe('reportToCsv', () => {
	it('writes list-table columns and escapes quotes', () => {
		const csv = reportToCsv(tableDefinition(), {
			total: 1,
			segments: [],
			columns: [
				{ id: 'name', label: 'Name' },
				{ id: 'email', label: 'Email' },
			],
			rows: [{ name: 'Ada "Lovelace"', email: 'ada@example.com' }],
			refreshedAt: '2026-08-24T18:00:00.000Z',
		})
		expect(csv).toBe('Name,Email\n"Ada ""Lovelace""",ada@example.com\n')
	})

	it('writes aggregated segment rows', () => {
		const definition = createReportDefinition({
			subject: 'notes',
			timeframe: { field: 'createdAt', preset: 'all_time' },
			groupBy: ['status'],
			visualization: {
				chartStyle: 'table',
				measure: 'count',
				sortBy: 'none',
				hideCounts: false,
			},
			settings: { title: 'Notes', notes: '', timezone: 'UTC' },
		})
		const csv = reportToCsv(definition, {
			total: 3,
			segments: [
				{ key: 'todo', label: 'Todo', count: 2, percent: 66.666 },
				{ key: 'done', label: 'Done', count: 1, percent: 33.333 },
			],
			refreshedAt: '2026-08-24T18:00:00.000Z',
		})
		expect(csv).toBe('Segment,Count,Percent\nTodo,2,66.7%\nDone,1,33.3%\n')
	})

	function salesDefinition(measure: 'sum' | 'average', hideCounts = false) {
		return createReportDefinition({
			subject: 'shop_orders',
			timeframe: { field: 'createdAt', preset: 'all_time' },
			groupBy: ['productName'],
			visualization: {
				chartStyle: 'table',
				measure,
				valueField: 'amount',
				sortBy: 'none',
				hideCounts,
			},
			settings: { title: 'Shop sales', notes: '', timezone: 'UTC' },
		})
	}

	const salesResult = (measure: 'sum' | 'average'): ReportResult => ({
		total: 4,
		value: measure === 'sum' ? 40 : 10,
		valueInfo: {
			measure,
			field: 'amount',
			label: measure === 'sum' ? 'Shop sales' : 'Average shop order',
			type: 'currency',
			currency: 'USD',
		},
		segments: [
			{ key: 'h', label: 'Hoodie', count: 1, percent: 25, value: 30 },
			{ key: 'm', label: 'Mug', count: 3, percent: 75, value: 10 },
		],
		refreshedAt: '2026-08-24T18:00:00.000Z',
	})

	it('writes sums as plain amounts with their share of the total', () => {
		expect(reportToCsv(salesDefinition('sum'), salesResult('sum'))).toBe(
			'Segment,Count,Shop sales (USD),Percent\nHoodie,1,30.00,75.0%\nMug,3,10.00,25.0%\n',
		)
		expect(reportToCsv(salesDefinition('sum', true), salesResult('sum'))).toBe(
			'Segment,Shop sales (USD),Percent\nHoodie,30.00,75.0%\nMug,10.00,25.0%\n',
		)
	})

	it('writes averages without a percent column', () => {
		const result = salesResult('average')
		// No order in this segment had an amount to average.
		result.segments[1] = { key: 'm', label: 'Mug', count: 3, percent: 75 }
		expect(reportToCsv(salesDefinition('average'), result)).toBe(
			'Segment,Count,Average shop order (USD)\nHoodie,1,30.00\nMug,3,\n',
		)
	})

	it('writes counts when amounts are in more than one currency', () => {
		const result: ReportResult = {
			total: 4,
			valueInfo: {
				measure: 'sum',
				field: 'amount',
				label: 'Shop sales',
				type: 'currency',
				mixedCurrencies: true,
			},
			segments: [
				{ key: 'h', label: 'Hoodie', count: 1, percent: 25 },
				{ key: 'm', label: 'Mug', count: 3, percent: 75 },
			],
			refreshedAt: '2026-08-24T18:00:00.000Z',
		}
		expect(reportToCsv(salesDefinition('sum'), result)).toBe(
			'Segment,Count,Percent\nHoodie,1,25.0%\nMug,3,75.0%\n',
		)
	})
})

describe('canExportReport', () => {
	it('allows a single-number report even when the total is zero', () => {
		const definition = createReportDefinition({
			subject: 'customers',
			timeframe: { field: 'createdAt', preset: 'all_time' },
			groupBy: [],
			visualization: {
				chartStyle: 'single_number',
				measure: 'count',
				sortBy: 'none',
				hideCounts: false,
			},
			settings: { title: 'Count', notes: '', timezone: 'UTC' },
		})
		expect(
			canExportReport(
				definition,
				{
					total: 0,
					segments: [],
					refreshedAt: '2026-08-24T18:00:00.000Z',
				},
				null,
			),
		).toBe(true)
	})

	it('blocks an empty list table', () => {
		expect(
			canExportReport(
				tableDefinition(),
				{
					total: 0,
					segments: [],
					columns: [{ id: 'name', label: 'Name' }],
					rows: [],
					refreshedAt: '2026-08-24T18:00:00.000Z',
				},
				null,
			),
		).toBe(false)
	})
})

describe('buildSingleNumberSvg', () => {
	it('embeds the total without a title', () => {
		const svg = buildSingleNumberSvg({
			text: '12',
			background: '#ffffff',
			foreground: '#0f172a',
		})
		expect(svg).toContain('>12</text>')
		expect(svg).toContain('font-size="88"')
		expect(svg).not.toContain('Customer count')
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
	})

	it('shrinks long amounts to fit and escapes them', () => {
		const svg = buildSingleNumberSvg({
			text: 'SAR 12,345,678,901.25 <x>',
			background: '#ffffff',
			foreground: '#0f172a',
		})
		expect(svg).not.toContain('font-size="88"')
		expect(svg).toContain('SAR 12,345,678,901.25 &lt;x&gt;')
	})
})

describe('composeExportSvg', () => {
	const chart =
		'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80"><rect width="100" height="80" fill="#eee"/></svg>'

	it('adds the title when requested', () => {
		const svg = composeExportSvg({
			chartSvg: chart,
			width: 400,
			height: 300,
			title: 'Phone verification',
			includeTitle: true,
			background: '#ffffff',
			foreground: '#0f172a',
		})
		expect(svg).toContain('Phone verification')
		expect(svg).toContain('width="400"')
		expect(svg).toContain(`translate(0 ${TITLE_BAR_HEIGHT})`)
	})

	it('omits the title bar when includeTitle is false', () => {
		const svg = composeExportSvg({
			chartSvg: chart,
			width: 400,
			height: 300,
			title: 'Phone verification',
			includeTitle: false,
			background: '#ffffff',
			foreground: '#0f172a',
		})
		expect(svg).not.toContain('Phone verification')
		expect(svg).toContain('translate(0 0)')
	})
})

describe('jpegToPdf', () => {
	it('wraps JPEG bytes in a one-page PDF', () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
		const pdf = jpegToPdf(jpeg, 200, 100)
		const text = new TextDecoder().decode(pdf)
		expect(text.startsWith('%PDF-1.4')).toBe(true)
		expect(text).toContain('/DCTDecode')
		expect(text).toContain('/MediaBox [0 0 200 100]')
		expect(text).toContain('%%EOF')
	})
})

describe('clampExportSize', () => {
	it('clamps to the allowed range', () => {
		expect(clampExportSize(10)).toBe(EXPORT_MIN_SIZE)
		expect(clampExportSize(99999)).toBe(EXPORT_MAX_SIZE)
		expect(clampExportSize(800)).toBe(800)
	})
})
