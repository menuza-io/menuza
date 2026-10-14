import { type CsvCell, toCsv } from './csv.ts'
import {
	type PayrollSummaryRow,
	type TimesheetCard,
	type TimesheetPerson,
} from './timesheet-api.ts'
import { formatDate, localParts } from './tz.ts'

/**
 * Timesheet export tables. One builder shared by tenant-api (which sends the
 * CSV text) and the browser (which can rebuild it with scope names the
 * regional node does not hold). Every text cell passes through `toCsv`, which
 * neutralizes spreadsheet formulas; numbers stay numbers. Money columns exist
 * only when the caller says the viewer holds the pay grant.
 */

export type TimesheetCsvTable = {
	headers: string[]
	rows: CsvCell[][]
}

/** Decimal hours to two places: 450 minutes is 7.5. */
export function minutesToHours(minutes: number): number {
	return Math.round((minutes / 60) * 100) / 100
}

/** Minor units to a major-unit number with two decimals (USD, CAD, SAR). */
export function minorToMajor(minor: number): number {
	return Math.round(minor) / 100
}

/** `YYYY-MM-DD HH:mm` in `timeZone`: what a payroll clerk reads. */
export function formatLocalStamp(ms: number, timeZone: string): string {
	const p = localParts(ms, timeZone)
	const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
	return `${formatDate(p.year, p.month, p.day)} ${time}`
}

export type CardCsvRow = {
	person: Pick<TimesheetPerson, 'employeeNumber' | 'firstName' | 'lastName'>
	card: TimesheetCard
}

export type CardCsvOptions = {
	includeMoney: boolean
	/** Scope names the caller knows; the id is exported when one is missing. */
	scopeNames?: ReadonlyMap<string, string>
}

export function timeCardsTable(
	rows: readonly CardCsvRow[],
	options: CardCsvOptions,
): TimesheetCsvTable {
	const headers = [
		'Employee ID',
		'First name',
		'Last name',
		'Scope',
		'Position',
		'Date',
		'Clock in',
		'Clock out',
		'Unpaid break (min)',
		'Regular hours',
		'Overtime hours',
		'Double-time hours',
		'Holiday hours',
		'Paid hours',
		...(options.includeMoney
			? ['Currency', 'Hourly rate', 'Estimated pay', 'Cash tips', 'Credit tips']
			: []),
		'Status',
		'Issues',
		'Note',
	]
	const body = rows.map(({ person, card }) => {
		const money = card.money
		return [
			person.employeeNumber,
			person.firstName,
			person.lastName,
			options.scopeNames?.get(card.scopeId) ?? card.scopeId,
			card.positionName,
			card.localDate,
			formatLocalStamp(card.clockInAt, card.timeZone),
			card.clockOutAt === null
				? ''
				: formatLocalStamp(card.clockOutAt, card.timeZone),
			card.minutes.unpaidBreakMinutes,
			minutesToHours(card.minutes.regularMinutes),
			minutesToHours(card.minutes.overtimeMinutes),
			minutesToHours(card.minutes.doubleTimeMinutes),
			minutesToHours(card.minutes.holidayMinutes),
			minutesToHours(card.minutes.paidMinutes),
			...(options.includeMoney
				? [
						money?.currency ?? '',
						money?.rateMinor == null ? '' : minorToMajor(money.rateMinor),
						money?.payMinor == null ? '' : minorToMajor(money.payMinor),
						money ? minorToMajor(money.cashTipsMinor) : '',
						money ? minorToMajor(money.creditTipsMinor) : '',
					]
				: []),
			card.status,
			card.issues.join(' '),
			card.managerNote,
		] satisfies CsvCell[]
	})
	return { headers, rows: body }
}

export function payrollSummaryTable(
	rows: readonly PayrollSummaryRow[],
	options: { includeMoney: boolean },
): TimesheetCsvTable {
	const headers = [
		'Employee ID',
		'First name',
		'Last name',
		'Cards',
		'Regular hours',
		'Overtime hours',
		'Double-time hours',
		'Holiday hours',
		'Paid hours',
		'Unapproved cards',
		...(options.includeMoney
			? ['Currency', 'Hourly rate', 'Estimated pay', 'Cash tips', 'Credit tips']
			: []),
	]
	const body: CsvCell[][] = []
	for (const row of rows) {
		const base: CsvCell[] = [
			row.employeeNumber,
			row.firstName,
			row.lastName,
			row.cards,
			minutesToHours(row.regularMinutes),
			minutesToHours(row.overtimeMinutes),
			minutesToHours(row.doubleTimeMinutes),
			minutesToHours(row.holidayMinutes),
			minutesToHours(row.paidMinutes),
			row.unapprovedCards,
		]
		if (!options.includeMoney || !row.money) {
			body.push(base)
			continue
		}
		const { money } = row
		const currencies = [
			...new Set([
				...Object.keys(money.payMinorByCurrency),
				...Object.keys(money.cashTipsMinorByCurrency),
				...Object.keys(money.creditTipsMinorByCurrency),
				...money.ratesMinor.map((rate) => rate.currency),
			]),
		].sort()
		if (currencies.length === 0) {
			body.push([...base, '', '', '', '', ''])
			continue
		}
		currencies.forEach((currency, index) => {
			const rates = money.ratesMinor
				.filter((rate) => rate.currency === currency)
				.map((rate) => rate.rateMinor)
				.sort((a, b) => a - b)
			const rateCell: CsvCell =
				rates.length === 0
					? ''
					: rates.length === 1
						? minorToMajor(rates[0]!)
						: rates.map((rate) => minorToMajor(rate).toFixed(2)).join(' / ')
			// Hours are written once, on the person's first row, so summing the
			// hour columns never counts them twice.
			const lead: CsvCell[] =
				index === 0
					? base
					: [
							row.employeeNumber,
							row.firstName,
							row.lastName,
							'',
							'',
							'',
							'',
							'',
							'',
							'',
						]
			body.push([
				...lead,
				currency,
				rateCell,
				minorToMajor(money.payMinorByCurrency[currency] ?? 0),
				minorToMajor(money.cashTipsMinorByCurrency[currency] ?? 0),
				minorToMajor(money.creditTipsMinorByCurrency[currency] ?? 0),
			])
		})
	}
	return { headers, rows: body }
}

/** CSV text for a table: RFC 4180, formula-safe, UTF-8 with a byte order mark. */
export function timesheetTableToCsv(table: TimesheetCsvTable): string {
	return toCsv(table.headers, table.rows, { bom: true })
}
