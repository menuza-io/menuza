import { describe, expect, it } from 'vitest'
import { computeLaborSummary } from './labor-summary.ts'
import {
	laborSummaryTable,
	parseSalesAmount,
	parseSalesCsv,
	parseSalesDate,
	splitCsvRecords,
} from './sales-csv.ts'
import { toCsv } from './csv.ts'

describe('parseSalesAmount', () => {
	it.each([
		['1234.56', 123_456],
		['1,234.56', 123_456],
		['1.234,56', 123_456],
		['1,234', 123_400],
		['1.234.567', 123_456_700],
		['12', 1200],
		['12.5', 1250],
		['.5', 50],
		['0', 0],
		['$ 1,200.00', 120_000],
		['SAR 1 234,50', 123_450],
		['١٢٣٤٫٥٠', 123_450],
		['  99.99  ', 9999],
	])('reads %s as %i minor units', (raw, minor) => {
		expect(parseSalesAmount(raw)).toEqual({ ok: true, minor })
	})

	it('is exact: no float drift', () => {
		expect(parseSalesAmount('0.29')).toEqual({ ok: true, minor: 29 })
		expect(parseSalesAmount('1.15')).toEqual({ ok: true, minor: 115 })
		expect(parseSalesAmount('4.35')).toEqual({ ok: true, minor: 435 })
	})

	it.each([
		['', 'bad_amount'],
		['abc', 'bad_amount'],
		['1,23,456', 'bad_amount'],
		['1.2.3', 'bad_amount'],
		['-50', 'negative_amount'],
		['0.125', 'too_many_decimals'],
		['1.2345', 'too_many_decimals'],
		['99999999999999', 'amount_too_large'],
	])('rejects %s', (raw, code) => {
		expect(parseSalesAmount(raw)).toEqual({ ok: false, code })
	})

	it('reads three digits after the only mark as a thousands group', () => {
		expect(parseSalesAmount('12.345')).toEqual({ ok: true, minor: 1_234_500 })
	})

	it('accepts a zero amount written with a minus sign', () => {
		expect(parseSalesAmount('-0')).toEqual({ ok: true, minor: 0 })
	})
})

describe('parseSalesDate', () => {
	it('reads ISO dates and the chosen day order', () => {
		expect(parseSalesDate('2026-03-02', 'iso')).toBe('2026-03-02')
		expect(parseSalesDate('2026/3/2', 'iso')).toBe('2026-03-02')
		expect(parseSalesDate('03/02/2026', 'mdy')).toBe('2026-03-02')
		expect(parseSalesDate('03/02/2026', 'dmy')).toBe('2026-02-03')
		expect(parseSalesDate('13/02/2026', 'mdy')).toBeNull()
		expect(parseSalesDate('13/02/2026', 'dmy')).toBe('2026-02-13')
	})
	it('refuses a day that does not exist, and slash dates in ISO mode', () => {
		expect(parseSalesDate('2026-02-30', 'iso')).toBeNull()
		expect(parseSalesDate('2025-02-29', 'iso')).toBeNull()
		expect(parseSalesDate('2024-02-29', 'iso')).toBe('2024-02-29')
		expect(parseSalesDate('03/02/2026', 'iso')).toBeNull()
		expect(parseSalesDate('yesterday', 'iso')).toBeNull()
	})
})

describe('splitCsvRecords', () => {
	it('honors quotes, doubled quotes, embedded newlines and every line ending', () => {
		const text = 'a,b\r\n"x, y","he said ""hi"""\n"line\nbreak",z\rlast,1'
		expect(splitCsvRecords(text, ',')).toEqual([
			{ line: 1, cells: ['a', 'b'] },
			{ line: 2, cells: ['x, y', 'he said "hi"'] },
			{ line: 3, cells: ['line\nbreak', 'z'] },
			{ line: 5, cells: ['last', '1'] },
		])
	})
	it('skips blank lines but keeps their line numbers', () => {
		expect(splitCsvRecords('a,b\n\n1,2\n', ',')).toEqual([
			{ line: 1, cells: ['a', 'b'] },
			{ line: 3, cells: ['1', '2'] },
		])
	})
})

describe('parseSalesCsv', () => {
	it('reads a plain file', () => {
		const result = parseSalesCsv(
			'Date,Net Sales,Note\n2026-03-02,"1,234.50",Rainy\n2026-03-03,800,\n',
		)
		expect(result.errors).toEqual([])
		expect(result.rows).toEqual([
			{ line: 2, date: '2026-03-02', netSalesMinor: 123_450, note: 'Rainy' },
			{ line: 3, date: '2026-03-03', netSalesMinor: 80_000, note: null },
		])
	})

	it('handles a byte-order mark, semicolons and a locale amount', () => {
		const result = parseSalesCsv(
			'﻿date;sales\n02/03/2026;1.234,50\n03/03/2026;800,00\n',
			{ dateOrder: 'dmy' },
		)
		expect(result.errors).toEqual([])
		expect(result.rows.map((r) => [r.date, r.netSalesMinor])).toEqual([
			['2026-03-02', 123_450],
			['2026-03-03', 80_000],
		])
	})

	it('reads Arabic headers and Arabic-Indic digits', () => {
		const result = parseSalesCsv('التاريخ,المبيعات\n٢٠٢٦-٠٣-٠٢,١٢٠٠\n')
		expect(result.errors).toEqual([])
		expect(result.rows).toEqual([
			{ line: 2, date: '2026-03-02', netSalesMinor: 120_000, note: null },
		])
	})

	it('reports each bad line with its code and keeps the good ones', () => {
		const result = parseSalesCsv(
			[
				'date,net_sales',
				'2026-03-02,100',
				'not a date,100',
				'2026-03-04,abc',
				'2026-03-05,-5',
				'2026-03-02,200',
				'2026-03-06,1.234',
				'2026-03-07,0.123',
				'2026-03-08',
			].join('\n'),
		)
		expect(result.rows.map((r) => r.date)).toEqual(['2026-03-02', '2026-03-06'])
		expect(result.errors).toEqual([
			{ line: 3, code: 'bad_date' },
			{ line: 4, code: 'bad_amount' },
			{ line: 5, code: 'negative_amount' },
			{ line: 6, code: 'duplicate_date' },
			{ line: 8, code: 'too_many_decimals' },
			{ line: 9, code: 'wrong_column_count' },
		])
	})

	it('names a missing header or column instead of guessing', () => {
		expect(parseSalesCsv('')).toEqual({
			rows: [],
			errors: [{ line: 0, code: 'empty' }],
		})
		expect(parseSalesCsv('foo,bar\n1,2').errors).toEqual([
			{ line: 1, code: 'missing_header' },
		])
		expect(parseSalesCsv('date,foo\n2026-03-02,2').errors).toEqual([
			{ line: 1, code: 'missing_sales_column' },
		])
		expect(parseSalesCsv('sales,foo\n2,2').errors).toEqual([
			{ line: 1, code: 'missing_date_column' },
		])
	})

	it('refuses an oversized file and too many rows', () => {
		expect(parseSalesCsv('x'.repeat(200_001)).errors).toEqual([
			{ line: 0, code: 'too_large' },
		])
		const many = ['date,sales']
		for (let i = 0; i < 400; i++) {
			const d = new Date(Date.UTC(2024, 0, 1 + i))
			many.push(`${d.toISOString().slice(0, 10)},1`)
		}
		expect(parseSalesCsv(many.join('\n')).errors).toEqual([
			{ line: 0, code: 'too_many_rows' },
		])
	})

	it('keeps a hostile note as plain text (the exporter neutralizes it)', () => {
		const result = parseSalesCsv(
			'date,sales,note\n2026-03-02,10,=HYPERLINK("x")\n',
		)
		expect(result.rows[0]!.note).toBe('=HYPERLINK("x")')
		expect(toCsv(['n'], [[result.rows[0]!.note]])).toContain("'=HYPERLINK")
	})

	it('truncates a long note to the stored length', () => {
		const result = parseSalesCsv(
			`date,sales,note\n2026-03-02,10,${'n'.repeat(500)}\n`,
		)
		expect(result.rows[0]!.note).toHaveLength(200)
	})
})

describe('laborSummaryTable', () => {
	const summary = computeLaborSummary({
		scopeId: 'l',
		timeZone: 'America/Chicago',
		from: '2026-03-02',
		to: '2026-03-03',
		salesSource: 'online_orders',
		targetBp: null,
		cards: [
			{
				staffId: 'a',
				date: '2026-03-02',
				paidMinutes: 480,
				overtimeMinutes: 0,
				costUnits: 480 * 1500 * 10_000,
				currency: 'USD',
				unpricedMinutes: 0,
				open: false,
			},
		],
		sales: [{ date: '2026-03-02', currency: 'USD', salesMinor: 80_000 }],
	})

	it('names the sales source on every money row and ends with a total', () => {
		const table = laborSummaryTable(summary, {
			sourceLabel: 'Online orders only',
			includeMoney: true,
		})
		expect(table.headers).toContain('Sales source')
		expect(table.rows[0]).toEqual([
			'2026-03-02',
			8,
			0,
			1,
			'USD',
			120,
			800,
			15,
			100,
			'Online orders only',
		])
		// A day with nothing to report still names the source and leaves the rest blank.
		expect(table.rows[1]).toEqual([
			'2026-03-03',
			0,
			0,
			0,
			'',
			'',
			'',
			'',
			'',
			'Online orders only',
		])
		const last = table.rows.at(-1)!
		expect(last[0]).toBe('Total')
		expect(last.at(-1)).toBe('Online orders only')
	})

	it('leaves every money column out without the labor grant', () => {
		const table = laborSummaryTable(summary, {
			sourceLabel: 'x',
			includeMoney: false,
		})
		expect(table.headers).toEqual([
			'Date',
			'Paid hours',
			'Overtime hours',
			'People',
		])
		expect(table.rows.every((row) => row.length === 4)).toBe(true)
		expect(table.rows.filter((row) => row[0] === 'Total')).toHaveLength(1)
	})
})
