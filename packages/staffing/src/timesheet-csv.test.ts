import { describe, expect, it } from 'vitest'
import {
	formatLocalStamp,
	minorToMajor,
	minutesToHours,
	payrollSummaryTable,
	timeCardsTable,
	timesheetTableToCsv,
	type CardCsvRow,
} from './timesheet-csv.ts'
import { type PayrollSummaryRow, type TimesheetCard } from './timesheet-api.ts'

const card = (patch: Partial<TimesheetCard> = {}): TimesheetCard => ({
	id: 'c1',
	staffId: 's1',
	scopeId: 'loc-1',
	positionId: 'p1',
	positionName: 'Cook',
	positionNameAr: null,
	timeZone: 'America/Chicago',
	localDate: '2026-03-02',
	clockInAt: Date.UTC(2026, 2, 2, 15, 0),
	clockOutAt: Date.UTC(2026, 2, 2, 23, 30),
	status: 'closed',
	issues: [],
	reviewed: false,
	edited: false,
	clockOutKind: 'kiosk',
	breaks: [],
	minutes: {
		regularMinutes: 480,
		overtimeMinutes: 30,
		doubleTimeMinutes: 0,
		holidayMinutes: 0,
		paidMinutes: 510,
		unpaidBreakMinutes: 30,
	},
	figuresChanged: false,
	managerNote: null,
	version: 1,
	approvedAt: null,
	lockedAt: null,
	...patch,
})

const row = (
	patch: Partial<CardCsvRow['person']> = {},
	c: Partial<TimesheetCard> = {},
): CardCsvRow => ({
	person: {
		employeeNumber: 'E-1',
		firstName: 'Rana',
		lastName: 'Khalid',
		...patch,
	},
	card: card(c),
})

describe('timeCardsTable', () => {
	it('writes hours as decimals and times in the card zone', () => {
		const table = timeCardsTable([row()], { includeMoney: false })
		expect(table.headers).not.toContain('Estimated pay')
		const [r] = table.rows
		expect(r).toContain(8)
		expect(r).toContain(0.5)
		expect(r).toContain(8.5)
		expect(r).toContain('2026-03-02 09:00')
		expect(r).toContain('2026-03-02 17:30')
		expect(table.headers).toHaveLength(r!.length)
	})

	it('leaves money columns out unless asked, and fills them when asked', () => {
		const money = {
			estimate: true as const,
			currency: 'USD',
			rateMinor: 1500,
			payMinor: 12_375,
			cashTipsMinor: 2_000,
			creditTipsMinor: 0,
		}
		const without = timeCardsTable([row({}, { money })], {
			includeMoney: false,
		})
		expect(JSON.stringify(without)).not.toContain('12.38')
		expect(JSON.stringify(without)).not.toContain('123.75')
		const withMoney = timeCardsTable([row({}, { money })], {
			includeMoney: true,
		})
		expect(withMoney.headers).toContain('Estimated pay')
		expect(withMoney.rows[0]).toContain(123.75)
		expect(withMoney.rows[0]).toContain(15)
		expect(withMoney.rows[0]).toContain(20)
		expect(withMoney.headers).toHaveLength(withMoney.rows[0]!.length)
	})

	it('uses scope names the caller supplies and falls back to the id', () => {
		const names = new Map([['loc-1', 'Downtown']])
		expect(
			timeCardsTable([row()], { includeMoney: false, scopeNames: names })
				.rows[0],
		).toContain('Downtown')
		expect(timeCardsTable([row()], { includeMoney: false }).rows[0]).toContain(
			'loc-1',
		)
	})

	it('neutralizes formulas in every user-influenced cell, headers included', () => {
		const hostile = row(
			{
				employeeNumber: '=1+1',
				firstName: '=HYPERLINK("http://x","y")',
				lastName: '+SUM(A1)',
			},
			{
				positionName: '@cmd',
				managerNote: '-2+3\t=evil',
				issues: [],
			},
		)
		const csv = timesheetTableToCsv(
			timeCardsTable([hostile], { includeMoney: false }),
		)
		const cells = csv.split('\r\n')[1]!
		expect(cells).toContain("'=1+1")
		expect(cells).toContain(`'=HYPERLINK`)
		expect(cells).toContain("'+SUM(A1)")
		expect(cells).toContain("'@cmd")
		expect(cells).toContain("'-2+3")
		for (const line of csv.split('\r\n').slice(1)) {
			for (const cell of line.split(',')) {
				expect(/^["]?[=+\-@]/.test(cell) && !/^-?\d/.test(cell)).toBe(false)
			}
		}
	})

	it('starts with a byte order mark so Excel reads Arabic names as UTF-8', () => {
		const csv = timesheetTableToCsv(
			timeCardsTable([row({ firstName: 'رنا' })], { includeMoney: false }),
		)
		expect(csv.charCodeAt(0)).toBe(0xfeff)
		expect(csv).toContain('رنا')
	})
})

describe('payrollSummaryTable', () => {
	const summary = (
		patch: Partial<PayrollSummaryRow> = {},
	): PayrollSummaryRow => ({
		staffId: 's1',
		employeeNumber: 'E-1',
		firstName: 'Rana',
		lastName: 'Khalid',
		cards: 5,
		regularMinutes: 2400,
		overtimeMinutes: 120,
		doubleTimeMinutes: 0,
		holidayMinutes: 0,
		paidMinutes: 2520,
		unpaidBreakMinutes: 150,
		unapprovedCards: 0,
		...patch,
	})

	it('omits money entirely without the grant, even if the row has it', () => {
		const table = payrollSummaryTable(
			[
				summary({
					money: {
						estimate: true,
						ratesMinor: [{ currency: 'USD', rateMinor: 1500 }],
						payMinorByCurrency: { USD: 66_000 },
						cashTipsMinorByCurrency: {},
						creditTipsMinorByCurrency: {},
						unpricedMinutes: 0,
					},
				}),
			],
			{ includeMoney: false },
		)
		expect(table.headers).not.toContain('Currency')
		expect(JSON.stringify(table)).not.toContain('660')
		expect(table.rows[0]).toContain(42)
	})

	it('writes one row per currency and the hours only once', () => {
		const table = payrollSummaryTable(
			[
				summary({
					money: {
						estimate: true,
						ratesMinor: [
							{ currency: 'USD', rateMinor: 1500 },
							{ currency: 'USD', rateMinor: 1800 },
							{ currency: 'CAD', rateMinor: 2000 },
						],
						payMinorByCurrency: { USD: 50_000, CAD: 10_000 },
						cashTipsMinorByCurrency: { USD: 1_000 },
						creditTipsMinorByCurrency: {},
						unpricedMinutes: 0,
					},
				}),
			],
			{ includeMoney: true },
		)
		expect(table.rows).toHaveLength(2)
		const hoursColumn = table.headers.indexOf('Paid hours')
		expect(table.rows[0]![hoursColumn]).toBe(42)
		expect(table.rows[1]![hoursColumn]).toBe('')
		const rate = table.headers.indexOf('Hourly rate')
		// Two rates in one currency are shown as a range, not summed or averaged.
		expect(table.rows[1]![rate]).toBe('15.00 / 18.00')
		expect(table.rows[0]![rate]).toBe(20)
		const pay = table.headers.indexOf('Estimated pay')
		expect(table.rows.map((r) => r[pay])).toEqual([100, 500])
	})

	it('keeps people with no money rows as a single line', () => {
		const table = payrollSummaryTable(
			[
				summary({
					money: {
						estimate: true,
						ratesMinor: [],
						payMinorByCurrency: {},
						cashTipsMinorByCurrency: {},
						creditTipsMinorByCurrency: {},
						unpricedMinutes: 2520,
					},
				}),
			],
			{ includeMoney: true },
		)
		expect(table.rows).toHaveLength(1)
		expect(table.rows[0]).toHaveLength(table.headers.length)
	})
})

describe('number helpers', () => {
	it('rounds to two places without drifting', () => {
		expect(minutesToHours(450)).toBe(7.5)
		expect(minutesToHours(20)).toBe(0.33)
		expect(minorToMajor(12_375)).toBe(123.75)
		expect(
			formatLocalStamp(Date.UTC(2026, 2, 8, 8, 30), 'America/Chicago'),
		).toBe('2026-03-08 03:30')
	})
})
