import { type CsvCell } from './csv.ts'
import {
	type LaborSummaryView,
	SALES_CSV_MAX_BYTES,
	SALES_MAX_BULK_ROWS,
	SALES_MAX_MINOR,
} from './labor-api.ts'

/**
 * Reads a daily sales file (a spreadsheet saved as CSV) into rows the sales
 * bulk endpoint accepts. The browser runs this for the preview and sends the
 * parsed rows, so tenant-api never parses free text and the same function
 * explains every rejected line.
 *
 * Accepted shape: a header row with a date column and a net sales column
 * (names are matched loosely, in English or Arabic), then one row per day.
 * Amounts are read as decimal text, never as floats, so `1,234.50` is exactly
 * 123450 minor units. Nothing is guessed silently: an unreadable date, a
 * negative or over-precise amount, or a repeated date is reported with its
 * line and left out.
 */

export const SALES_CSV_DATE_ORDERS = ['iso', 'mdy', 'dmy'] as const
export type SalesCsvDateOrder = (typeof SALES_CSV_DATE_ORDERS)[number]

export const SALES_CSV_ERROR_CODES = [
	'empty',
	'too_large',
	'missing_header',
	'missing_date_column',
	'missing_sales_column',
	'bad_date',
	'bad_amount',
	'negative_amount',
	'too_many_decimals',
	'amount_too_large',
	'duplicate_date',
	'too_many_rows',
	'wrong_column_count',
] as const
export type SalesCsvErrorCode = (typeof SALES_CSV_ERROR_CODES)[number]

export type SalesCsvRow = {
	/** 1-based line number in the file, for messages. */
	line: number
	date: string
	netSalesMinor: number
	note: string | null
}

export type SalesCsvError = {
	/** 0 for a problem with the file as a whole. */
	line: number
	code: SalesCsvErrorCode
}

export type SalesCsvResult = {
	rows: SalesCsvRow[]
	errors: SalesCsvError[]
}

const DATE_HEADERS = new Set([
	'date',
	'day',
	'business date',
	'business day',
	'trading day',
	'التاريخ',
	'تاريخ',
])
const SALES_HEADERS = new Set([
	'net sales',
	'net_sales',
	'netsales',
	'sales',
	'net',
	'total sales',
	'amount',
	'revenue',
	'المبيعات',
	'صافي المبيعات',
])
const NOTE_HEADERS = new Set(['note', 'notes', 'comment', 'ملاحظة', 'ملاحظات'])

function normalizeHeader(value: string): string {
	return value
		.replace(/^﻿/, '')
		.trim()
		.toLowerCase()
		.replace(/[_\s]+/g, ' ')
}

/** The delimiter the header line uses: comma, semicolon or tab. */
function detectDelimiter(headerLine: string): string {
	const counts = [',', ';', '\t'].map((d) => ({
		d,
		n: headerLine.split(d).length - 1,
	}))
	counts.sort((a, b) => b.n - a.n)
	return counts[0]!.n > 0 ? counts[0]!.d : ','
}

/** Splits CSV text into records, honoring quotes, doubled quotes and any line ending. */
export function splitCsvRecords(
	text: string,
	delimiter: string,
): Array<{ line: number; cells: string[] }> {
	const records: Array<{ line: number; cells: string[] }> = []
	let cells: string[] = []
	let cell = ''
	let quoted = false
	let line = 1
	let recordLine = 1
	let touched = false
	const flushRecord = () => {
		cells.push(cell)
		if (touched || cells.some((c) => c.trim() !== '')) {
			records.push({ line: recordLine, cells })
		}
		cells = []
		cell = ''
		touched = false
	}
	for (let i = 0; i < text.length; i++) {
		const char = text[i]!
		if (quoted) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					cell += '"'
					i++
				} else {
					quoted = false
				}
			} else {
				if (char === '\n') line++
				cell += char
			}
			continue
		}
		if (char === '"' && cell === '') {
			quoted = true
			touched = true
		} else if (char === delimiter) {
			cells.push(cell)
			cell = ''
			touched = true
		} else if (char === '\r' || char === '\n') {
			if (char === '\r' && text[i + 1] === '\n') i++
			flushRecord()
			line++
			recordLine = line
		} else {
			cell += char
		}
	}
	if (cell !== '' || cells.length > 0 || touched) flushRecord()
	return records
}

/** Reads one date cell in the chosen order. Returns `YYYY-MM-DD` or null. */
export function parseSalesDate(
	raw: string,
	order: SalesCsvDateOrder,
): string | null {
	const text = raw.trim()
	let year: number
	let month: number
	let day: number
	const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text)
	if (iso) {
		year = Number(iso[1])
		month = Number(iso[2])
		day = Number(iso[3])
	} else if (order !== 'iso') {
		const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text)
		if (!parts) return null
		year = Number(parts[3])
		if (order === 'mdy') {
			month = Number(parts[1])
			day = Number(parts[2])
		} else {
			day = Number(parts[1])
			month = Number(parts[2])
		}
	} else {
		return null
	}
	const date = new Date(Date.UTC(year, month - 1, day))
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null
	}
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Arabic-Indic and Persian digits to ASCII, so a file typed in Arabic reads. */
function asciiDigits(value: string): string {
	return value
		.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
		.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
		.replace(/٫/g, '.')
		.replace(/٬/g, ',')
}

export type AmountResult =
	{ ok: true; minor: number } | { ok: false; code: SalesCsvErrorCode }

/**
 * An amount in decimal text to minor units (two decimals), exactly. Currency
 * marks and spaces are ignored. The last `.` or `,` is the decimal mark when one
 * or two digits follow it; with three digits it is a thousands mark.
 */
export function parseSalesAmount(raw: string): AmountResult {
	let text = asciiDigits(raw)
		.replace(/[\s  ]/g, '')
		.replace(/^[^\d\-+.,]+/, '')
		.replace(/[^\d.,]+$/, '')
	if (text === '') return { ok: false, code: 'bad_amount' }
	let negative = false
	if (text.startsWith('-')) {
		negative = true
		text = text.slice(1)
	} else if (text.startsWith('+')) {
		text = text.slice(1)
	}
	if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) {
		return { ok: false, code: 'bad_amount' }
	}
	const lastMark = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','))
	let whole = text
	let fraction = ''
	if (lastMark >= 0) {
		const after = text.length - lastMark - 1
		if (after === 3 && !text.startsWith('0')) {
			// A thousands mark: every mark must then sit before groups of three.
			whole = text
		} else {
			whole = text.slice(0, lastMark)
			fraction = text.slice(lastMark + 1)
		}
	}
	// Only groups of exactly three digits may follow a thousands mark.
	if (/[.,]/.test(whole)) {
		if (!/^\d{1,3}([.,]\d{3})+$/.test(whole)) {
			return { ok: false, code: 'bad_amount' }
		}
		whole = whole.replace(/[.,]/g, '')
	}
	if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) {
		return { ok: false, code: 'bad_amount' }
	}
	if (fraction.length > 2) return { ok: false, code: 'too_many_decimals' }
	if (whole === '' && fraction === '') return { ok: false, code: 'bad_amount' }
	const minor =
		Number(whole === '' ? '0' : whole) * 100 +
		Number(fraction.padEnd(2, '0') || '0')
	if (!Number.isSafeInteger(minor) || minor > SALES_MAX_MINOR) {
		return { ok: false, code: 'amount_too_large' }
	}
	if (negative && minor !== 0) return { ok: false, code: 'negative_amount' }
	return { ok: true, minor }
}

export function parseSalesCsv(
	text: string,
	options: { dateOrder?: SalesCsvDateOrder } = {},
): SalesCsvResult {
	const order = options.dateOrder ?? 'iso'
	if (text.trim() === '')
		return { rows: [], errors: [{ line: 0, code: 'empty' }] }
	if (text.length > SALES_CSV_MAX_BYTES) {
		return { rows: [], errors: [{ line: 0, code: 'too_large' }] }
	}
	const clean = text.replace(/^﻿/, '')
	const firstLine = clean.split(/\r\n|\r|\n/, 1)[0] ?? ''
	const delimiter = detectDelimiter(firstLine)
	const records = splitCsvRecords(clean, delimiter)
	const header = records[0]
	if (!header)
		return { rows: [], errors: [{ line: 0, code: 'missing_header' }] }

	const names = header.cells.map(normalizeHeader)
	const dateColumn = names.findIndex((name) => DATE_HEADERS.has(name))
	const salesColumn = names.findIndex((name) => SALES_HEADERS.has(name))
	const noteColumn = names.findIndex((name) => NOTE_HEADERS.has(name))
	if (dateColumn < 0 && salesColumn < 0) {
		return { rows: [], errors: [{ line: header.line, code: 'missing_header' }] }
	}
	if (dateColumn < 0) {
		return {
			rows: [],
			errors: [{ line: header.line, code: 'missing_date_column' }],
		}
	}
	if (salesColumn < 0) {
		return {
			rows: [],
			errors: [{ line: header.line, code: 'missing_sales_column' }],
		}
	}

	const rows: SalesCsvRow[] = []
	const errors: SalesCsvError[] = []
	const seen = new Set<string>()
	for (const record of records.slice(1)) {
		if (record.cells.length !== header.cells.length) {
			errors.push({ line: record.line, code: 'wrong_column_count' })
			continue
		}
		const date = parseSalesDate(
			asciiDigits(record.cells[dateColumn] ?? ''),
			order,
		)
		if (!date) {
			errors.push({ line: record.line, code: 'bad_date' })
			continue
		}
		const amount = parseSalesAmount(record.cells[salesColumn] ?? '')
		if (!amount.ok) {
			errors.push({ line: record.line, code: amount.code })
			continue
		}
		if (seen.has(date)) {
			errors.push({ line: record.line, code: 'duplicate_date' })
			continue
		}
		seen.add(date)
		const note =
			noteColumn >= 0
				? (record.cells[noteColumn] ?? '').trim().slice(0, 200)
				: ''
		rows.push({
			line: record.line,
			date,
			netSalesMinor: amount.minor,
			note: note === '' ? null : note,
		})
	}
	if (rows.length > SALES_MAX_BULK_ROWS) {
		return { rows: [], errors: [{ line: 0, code: 'too_many_rows' }] }
	}
	return { rows, errors }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type LaborCsvTable = { headers: string[]; rows: CsvCell[][] }

/** Minor units to a major-unit number with two decimals (USD, CAD, SAR). */
function major(minor: number | null): number | null {
	return minor === null ? null : Math.round(minor) / 100
}

function hours(minutes: number): number {
	return Math.round((minutes / 60) * 100) / 100
}

function percent(bp: number | null): number | null {
	return bp === null ? null : Math.round(bp) / 100
}

/**
 * The labor summary as a table, one row per day and currency, with the sales
 * source named on every row so a file passed around never loses it. The share
 * is left blank, not zero, where no sales are known.
 */
export function laborSummaryTable(
	summary: LaborSummaryView,
	options: { sourceLabel: string; includeMoney: boolean },
): LaborCsvTable {
	const headers = [
		'Date',
		'Paid hours',
		'Overtime hours',
		'People',
		...(options.includeMoney
			? [
					'Currency',
					'Estimated labor cost',
					'Sales',
					'Labor share (%)',
					'Sales per labor hour',
					'Sales source',
				]
			: []),
	]
	const rows: CsvCell[][] = []
	for (const day of summary.days) {
		const base = [
			day.date,
			hours(day.paidMinutes),
			hours(day.overtimeMinutes),
			day.people,
		]
		if (!options.includeMoney) {
			rows.push(base)
			continue
		}
		if (day.money.length === 0) {
			rows.push([...base, '', '', '', '', '', options.sourceLabel])
			continue
		}
		for (const money of day.money) {
			rows.push([
				...base,
				money.currency,
				major(money.costMinor),
				major(money.salesMinor),
				percent(money.laborBp),
				major(money.salesPerLaborHourMinor),
				options.sourceLabel,
			])
		}
	}
	const totalBase = [
		'Total',
		hours(summary.totals.paidMinutes),
		hours(summary.totals.overtimeMinutes),
		'',
	]
	if (!options.includeMoney) {
		rows.push(totalBase)
	} else if (summary.totals.money.length === 0) {
		rows.push([...totalBase, '', '', '', '', '', options.sourceLabel])
	} else {
		for (const money of summary.totals.money) {
			rows.push([
				...totalBase,
				money.currency,
				major(money.costMinor),
				major(money.salesMinor),
				percent(money.laborBp),
				major(money.salesPerLaborHourMinor),
				options.sourceLabel,
			])
		}
	}
	return { headers, rows }
}
