export type CsvCell = string | number | null | undefined

/** Spreadsheet apps execute cells that start with these characters. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/

export function csvCell(value: CsvCell) {
	if (value === null || value === undefined) return ''
	let text = String(value)
	if (typeof value === 'string' && FORMULA_PREFIX.test(text)) text = `'${text}`
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: readonly (readonly CsvCell[])[]) {
	return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
