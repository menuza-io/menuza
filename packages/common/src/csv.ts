/**
 * Formula-safe CSV export and delimited text parser, shared across staffing,
 * inventory price-list imports, and accountant exports.
 */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Characters spreadsheet apps may skip before parsing a formula: C0 controls
 * other than tab, line feed, and carriage return, zero-width marks, and BOM.
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
		return Number.isFinite(cell) ? String(cell) : ''
	}
	if (typeof cell === 'boolean') return cell ? 'true' : 'false'
	return neutralizeCsvCell(cell)
}

function escapeCell(text: string): string {
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Build a CSV string (RFC 4180, CRLF line ends). Headers are neutralized too.
 * Pass `bom: true` for UTF-8 BOM so Excel opens Arabic names cleanly.
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
	return `${opts.bom ? '\uFEFF' : ''}${lines.join('\r\n')}\r\n`
}

function detectDelimiter(line: string): string {
	const counts: Array<[string, number]> = [
		['\t', line.split('\t').length],
		[';', line.split(';').length],
		[',', line.split(',').length],
	]
	counts.sort((a, b) => b[1] - a[1])
	return counts[0]![1] > 1 ? counts[0]![0] : ','
}

/** RFC 4180 style split that also handles tab and semicolon separated paste. */
export function parseDelimited(text: string): string[][] {
	const input = text.replace(/^\uFEFF/, '')
	const firstLine = input.split(/\r?\n/, 1)[0] ?? ''
	const delimiter = detectDelimiter(firstLine)
	const rows: string[][] = []
	let row: string[] = []
	let cell = ''
	let quoted = false
	for (let i = 0; i < input.length; i++) {
		const char = input[i]!
		if (quoted) {
			if (char === '"') {
				if (input[i + 1] === '"') {
					cell += '"'
					i++
				} else quoted = false
			} else cell += char
			continue
		}
		if (char === '"' && cell === '') quoted = true
		else if (char === delimiter) {
			row.push(cell)
			cell = ''
		} else if (char === '\n' || char === '\r') {
			if (char === '\r' && input[i + 1] === '\n') i++
			row.push(cell)
			cell = ''
			rows.push(row)
			row = []
		} else cell += char
	}
	row.push(cell)
	rows.push(row)
	return rows
		.map((cells) => cells.map((value) => value.trim()))
		.filter((cells) => cells.some((value) => value !== ''))
}
