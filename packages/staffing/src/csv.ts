/**
 * Formula-safe CSV export. Spreadsheet apps treat a cell that starts with `=`,
 * `+`, `-`, `@`, tab, or carriage return as a formula, so a staff name such as
 * `=HYPERLINK(...)` becomes an attack when a manager opens an export. Every
 * string cell that could start a formula is prefixed with a single quote, which
 * spreadsheet apps display as plain text.
 */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Characters spreadsheet apps may skip before parsing a formula: C0 controls
 * other than tab, line feed, and carriage return (which are handled as
 * triggers or line breaks), zero-width marks, and the byte order mark.
 */
function isInvisibleLeader(char: string): boolean {
	const code = char.charCodeAt(0)
	return (
		(code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
		(code >= 0x200b && code <= 0x200f) ||
		code === 0xfeff
	)
}

export function neutralizeCsvCell(value: string): string {
	let start = 0
	while (start < value.length && isInvisibleLeader(value[start]!)) start++
	const stripped = value.slice(start)
	const first = stripped[0]
	if (first !== undefined && FORMULA_TRIGGERS.has(first)) return `'${stripped}`
	// Leading spaces before a trigger still evaluate in some spreadsheet apps.
	const trimmedFirst = stripped.trimStart()[0]
	if (
		trimmedFirst !== undefined &&
		trimmedFirst !== first &&
		FORMULA_TRIGGERS.has(trimmedFirst)
	) {
		return `'${stripped}`
	}
	return stripped
}

export type CsvCell = string | number | boolean | null | undefined

function formatCell(cell: CsvCell): string {
	if (cell === null || cell === undefined) return ''
	if (typeof cell === 'number') {
		// Numbers are data, not text: a negative number must stay numeric.
		return Number.isFinite(cell) ? String(cell) : ''
	}
	if (typeof cell === 'boolean') return cell ? 'true' : 'false'
	return neutralizeCsvCell(cell)
}

function escapeCell(text: string): string {
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Build a CSV string (RFC 4180, CRLF line ends). Headers are neutralized too,
 * since they are often user-influenced (position names). Pass `bom: true` for
 * files that Excel should open as UTF-8, which Arabic names need.
 */
export function toCsv(
	headers: readonly string[],
	rows: readonly (readonly CsvCell[])[],
	opts: { bom?: boolean } = {},
): string {
	const lines = [
		headers.map((h) => escapeCell(neutralizeCsvCell(h))).join(','),
		...rows.map((row) =>
			row.map((cell) => escapeCell(formatCell(cell))).join(','),
		),
	]
	return `${opts.bom ? '﻿' : ''}${lines.join('\r\n')}\r\n`
}
