import {
	type TimesheetCsvTable,
	payrollSummaryTable,
	timeCardsTable,
	timesheetTableToCsv,
} from '@repo/staffing'
import { describe, expect, it } from 'vitest'
import { buildExportCsv, safeFilename } from './timesheet-export.ts'
import { card, person } from './timesheet-fixtures.ts'
import { type ExportData } from './timesheet-types.ts'

function exportOf(
	table: TimesheetCsvTable,
	kind: ExportData['kind'] = 'cards',
	filename = 'cards.csv',
): ExportData {
	return {
		filename,
		kind,
		rowCount: table.rows.length,
		includesMoney: false,
		headers: table.headers,
		rows: table.rows.map((row) => row.map((cell) => cell ?? null)),
		csv: timesheetTableToCsv(table),
	}
}

describe('browser CSV', () => {
	it('swaps workplace ids for names and keeps the formula guard', () => {
		const evil = person(
			{ firstName: '=HYPERLINK("http://x")', lastName: '+SUM(A1)' },
			[card({ managerNote: '@cmd' })],
		)
		const table = timeCardsTable([{ person: evil, card: evil.cards[0]! }], {
			includeMoney: false,
		})
		const built = buildExportCsv(exportOf(table), {
			scopeNames: new Map([['loc-1', 'Downtown']]),
			fallbackName: 'fallback.csv',
		})
		expect(built.csv).toContain('Downtown')
		expect(built.csv).not.toContain('loc-1')
		// Every formula leader is neutralized, once.
		expect(built.csv).toContain("'=HYPERLINK")
		expect(built.csv).toContain("'+SUM(A1)")
		expect(built.csv).toContain("'@cmd")
		expect(built.csv).not.toContain("''")
		expect(built.csv.startsWith('﻿')).toBe(true)
		expect(built.rowCount).toBe(1)
	})

	it('falls back to the id when a name is unknown', () => {
		const p = person()
		const table = timeCardsTable([{ person: p, card: p.cards[0]! }], {
			includeMoney: false,
		})
		const built = buildExportCsv(exportOf(table), { fallbackName: 'f.csv' })
		expect(built.csv).toContain('loc-1')
	})

	it('keeps only the chosen summary columns, in server order', () => {
		const table = payrollSummaryTable(
			[
				{
					staffId: 's1',
					employeeNumber: 'E1',
					firstName: 'Rana',
					lastName: 'Khalid',
					cards: 2,
					regularMinutes: 900,
					overtimeMinutes: 60,
					doubleTimeMinutes: 0,
					holidayMinutes: 0,
					paidMinutes: 960,
					unpaidBreakMinutes: 30,
					unapprovedCards: 1,
				},
			],
			{ includeMoney: false },
		)
		const built = buildExportCsv(exportOf(table, 'summary', 'summary.csv'), {
			keepHeaders: ['Paid hours', 'First name', 'Last name'],
			fallbackName: 'f.csv',
		})
		const [head, row] = built.csv.replace('﻿', '').split('\r\n')
		expect(head).toBe('First name,Last name,Paid hours')
		expect(row).toBe('Rana,Khalid,16')
		expect(built.filename).toBe('summary.csv')
	})

	it('only accepts a safe file name', () => {
		expect(safeFilename('../../etc/passwd', 'x.csv')).toBe('x.csv')
		expect(safeFilename('time cards 2026.csv', 'x.csv')).toBe(
			'time-cards-2026.csv',
		)
		expect(safeFilename('.csv', 'x.csv')).toBe('x.csv')
	})
})
