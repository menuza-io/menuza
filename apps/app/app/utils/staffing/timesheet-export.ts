import { type CsvCell, toCsv } from '@repo/staffing'
import { type ExportData } from './timesheet-types.ts'

/**
 * The browser builds the CSV file. The regional node answers an export request
 * with the table (and writes the audit row); this module rebuilds the file from
 * it so the Scope column can carry names, which only the App knows, and so a
 * payroll summary can leave out the columns the manager unticked. Every cell
 * goes through the shared `toCsv`, which neutralizes spreadsheet formulas, and
 * that step is idempotent, so cells the server already made safe stay as they
 * are.
 *
 * Headers stay in English on purpose: a payroll tool maps columns by name, and
 * the file should not change shape with the language of the screen.
 */

export type SummaryColumn = {
	id: string
	/** The header the export carries. */
	header: string
	/** Money columns exist only for a viewer with the pay grant. */
	money?: boolean
}

export const SUMMARY_COLUMNS: readonly SummaryColumn[] = [
	{ id: 'employeeId', header: 'Employee ID' },
	{ id: 'firstName', header: 'First name' },
	{ id: 'lastName', header: 'Last name' },
	{ id: 'cards', header: 'Cards' },
	{ id: 'regular', header: 'Regular hours' },
	{ id: 'overtime', header: 'Overtime hours' },
	{ id: 'doubleTime', header: 'Double-time hours' },
	{ id: 'holiday', header: 'Holiday hours' },
	{ id: 'paid', header: 'Paid hours' },
	{ id: 'unapproved', header: 'Unapproved cards' },
	{ id: 'currency', header: 'Currency', money: true },
	{ id: 'rate', header: 'Hourly rate', money: true },
	{ id: 'pay', header: 'Estimated pay', money: true },
	{ id: 'cashTips', header: 'Cash tips', money: true },
	{ id: 'creditTips', header: 'Credit tips', money: true },
]

/** What a payroll clerk wants first: who, and the hours that are paid. */
export const DEFAULT_SUMMARY_COLUMNS: readonly string[] = [
	'employeeId',
	'firstName',
	'lastName',
	'regular',
	'overtime',
	'paid',
	'unapproved',
	'rate',
	'pay',
]

export function safeFilename(name: string, fallback: string): string {
	const cleaned = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
	return cleaned.toLowerCase().endsWith('.csv') && cleaned.length > 4
		? cleaned
		: fallback
}

export type BuiltCsv = { filename: string; csv: string; rowCount: number }

/**
 * Rebuilds an export for download. `scopeNames` swaps the id the node holds
 * for the name; `keepHeaders` (summary only) keeps just those columns, in the
 * order the server wrote them.
 */
export function buildExportCsv(
	data: ExportData,
	options: {
		scopeNames?: ReadonlyMap<string, string>
		keepHeaders?: readonly string[] | null
		fallbackName: string
	},
): BuiltCsv {
	const scopeColumn = data.headers.indexOf('Scope')
	const keep = options.keepHeaders ? new Set(options.keepHeaders) : null
	const indexes = data.headers
		.map((header, index) => ({ header, index }))
		.filter(({ header }) => !keep || keep.has(header))
		.map(({ index }) => index)

	const headers = indexes.map((index) => data.headers[index]!)
	const rows: CsvCell[][] = data.rows.map((row) =>
		indexes.map((index) => {
			const cell = row[index] ?? null
			if (index === scopeColumn && typeof cell === 'string') {
				return options.scopeNames?.get(cell) ?? cell
			}
			return cell
		}),
	)
	return {
		filename: safeFilename(data.filename, options.fallbackName),
		csv: toCsv(headers, rows, { bom: true }),
		rowCount: rows.length,
	}
}
