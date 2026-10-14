import { normalizePhone } from './staff-format.ts'

/**
 * Parsing and row validation for "Bulk add" (paste or CSV). Nothing here talks
 * to the network: the browser parses and checks every row first, the manager
 * reviews them, and only Confirm posts the valid ones to the regional API.
 */

export const IMPORT_MAX_ROWS = 200
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type ImportProblem =
	| 'name_required'
	| 'last_name_required'
	| 'contact_required'
	| 'bad_email'
	| 'bad_phone'
	| 'duplicate'
	| 'name_too_long'

export type ImportRow = {
	/** 1-based position among the data rows, for "Row 3" messages. */
	row: number
	firstName: string
	lastName: string
	email: string
	phone: string
	problems: ImportProblem[]
	/** Row number this one repeats, when `problems` includes `duplicate`. */
	duplicateOf?: number
}

/** RFC 4180 style split that also handles tab and semicolon separated paste. */
export function parseDelimited(text: string): string[][] {
	const input = text.replace(/^﻿/, '')
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

function detectDelimiter(line: string): string {
	const counts: Array<[string, number]> = [
		['\t', line.split('\t').length],
		[';', line.split(';').length],
		[',', line.split(',').length],
	]
	counts.sort((a, b) => b[1] - a[1])
	return counts[0]![1] > 1 ? counts[0]![0] : ','
}

type Column = 'name' | 'firstName' | 'lastName' | 'email' | 'phone'

const HEADER_ALIASES: Record<string, Column> = {
	name: 'name',
	'full name': 'name',
	fullname: 'name',
	'staff name': 'name',
	'first name': 'firstName',
	firstname: 'firstName',
	first: 'firstName',
	'given name': 'firstName',
	'last name': 'lastName',
	lastname: 'lastName',
	last: 'lastName',
	surname: 'lastName',
	'family name': 'lastName',
	email: 'email',
	'e-mail': 'email',
	'email address': 'email',
	phone: 'phone',
	mobile: 'phone',
	'phone number': 'phone',
	cell: 'phone',
	tel: 'phone',
}

function headerColumns(cells: string[]): Array<Column | null> | null {
	const mapped = cells.map(
		(cell) => HEADER_ALIASES[cell.toLowerCase().replace(/[_-]+/g, ' ')] ?? null,
	)
	const known = mapped.filter((column): column is Column => column !== null)
	// A header row names a name column and at least one other known column.
	const hasName = known.some((column) =>
		['name', 'firstName', 'lastName'].includes(column),
	)
	return hasName && known.length >= 2 ? mapped : null
}

function looksLikePhone(value: string): boolean {
	const stripped = value.replace(/[\s().-]/g, '')
	return /^\+?[\d٠-٩۰-۹]{6,16}$/.test(stripped)
}

export function splitName(full: string): {
	firstName: string
	lastName: string
} {
	const parts = full.trim().split(/\s+/).filter(Boolean)
	if (parts.length === 0) return { firstName: '', lastName: '' }
	if (parts.length === 1) return { firstName: parts[0]!, lastName: '' }
	return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') }
}

export type ParseResult = {
	rows: ImportRow[]
	/** True when more than `IMPORT_MAX_ROWS` rows were pasted; extras are dropped. */
	truncated: boolean
	hadHeader: boolean
}

/**
 * Turns pasted text into reviewable rows. With a header row, columns follow the
 * header. Without one, each cell is classified by its content (an `@` is an
 * email, a long run of digits is a phone, the rest is the name), which is what
 * people paste from a phone's contact list or a quick note.
 */
export function parseStaffText(
	text: string,
	options: { defaultDialCode?: '1' | '966' | null } = {},
): ParseResult {
	const table = parseDelimited(text)
	if (table.length === 0)
		return { rows: [], truncated: false, hadHeader: false }

	const header = headerColumns(table[0]!)
	const body = header ? table.slice(1) : table
	const truncated = body.length > IMPORT_MAX_ROWS
	const rows: ImportRow[] = body.slice(0, IMPORT_MAX_ROWS).map((cells, i) => {
		let name = ''
		let firstName = ''
		let lastName = ''
		let email = ''
		let phone = ''
		if (header) {
			cells.forEach((value, index) => {
				switch (header[index]) {
					case 'name':
						name = value
						break
					case 'firstName':
						firstName = value
						break
					case 'lastName':
						lastName = value
						break
					case 'email':
						email = value
						break
					case 'phone':
						phone = value
						break
				}
			})
		} else {
			const nameCells: string[] = []
			for (const value of cells) {
				if (!value) continue
				if (value.includes('@') && !email) email = value
				else if (looksLikePhone(value) && !phone) phone = value
				else nameCells.push(value)
			}
			name = nameCells.join(' ')
		}
		if (!firstName && !lastName && name) {
			;({ firstName, lastName } = splitName(name))
		}
		return validateRow(
			{
				row: i + 1,
				firstName: firstName.trim(),
				lastName: lastName.trim(),
				email: email.trim().toLowerCase(),
				phone: phone.trim(),
				problems: [],
			},
			options.defaultDialCode ?? null,
		)
	})
	return {
		rows: markDuplicates(rows, options.defaultDialCode ?? null),
		truncated,
		hadHeader: Boolean(header),
	}
}

export function validateRow(
	row: ImportRow,
	dialCode: '1' | '966' | null = null,
): ImportRow {
	const problems: ImportProblem[] = []
	if (!row.firstName) problems.push('name_required')
	else if (!row.lastName) problems.push('last_name_required')
	if (row.firstName.length > 80 || row.lastName.length > 80) {
		problems.push('name_too_long')
	}
	if (row.email && !EMAIL.test(row.email)) problems.push('bad_email')
	if (row.phone && !normalizePhone(row.phone, dialCode)) {
		problems.push('bad_phone')
	}
	if (!row.email && !row.phone) problems.push('contact_required')
	return { ...row, problems }
}

/** Marks a later row that repeats an earlier row's email or phone. */
export function markDuplicates(
	rows: ImportRow[],
	dialCode: '1' | '966' | null = null,
): ImportRow[] {
	const seen = new Map<string, number>()
	return rows.map((row) => {
		const keys = [
			row.email ? `e:${row.email}` : null,
			row.phone
				? `p:${normalizePhone(row.phone, dialCode) ?? row.phone}`
				: null,
		].filter((key): key is string => key !== null)
		const original = keys
			.map((key) => seen.get(key))
			.find((value) => value !== undefined)
		for (const key of keys) if (!seen.has(key)) seen.set(key, row.row)
		if (original === undefined) return row
		return {
			...row,
			problems: row.problems.includes('duplicate')
				? row.problems
				: [...row.problems, 'duplicate'],
			duplicateOf: original,
		}
	})
}

/** The API payload for a valid row, or null when the row has problems. */
export function toCreatePayload(
	row: ImportRow,
	scopeId: string | null,
	dialCode: '1' | '966' | null = null,
) {
	if (row.problems.length > 0) return null
	return {
		firstName: row.firstName,
		lastName: row.lastName,
		...(row.email ? { email: row.email } : {}),
		...(row.phone ? { phone: normalizePhone(row.phone, dialCode)! } : {}),
		assignments: scopeId ? [{ scopeId, isPrimary: true as const }] : [],
	}
}

/** A row being reviewed: the editable fields, before problems are derived. */
export type DraftRow = {
	id: string
	firstName: string
	lastName: string
	email: string
	phone: string
	/** Control-plane user id when the row comes from "Import current members". */
	userId?: string
}

export type ReviewedRow = ImportRow & { id: string; userId?: string }

/**
 * Re-derives every row's problems from its current fields, so editing one
 * cell updates its own message and any duplicate it created or cleared.
 */
export function reviewDrafts(
	drafts: readonly DraftRow[],
	dialCode: '1' | '966' | null = null,
): ReviewedRow[] {
	const validated = drafts.map((draft, index) =>
		validateRow(
			{
				row: index + 1,
				firstName: draft.firstName.trim(),
				lastName: draft.lastName.trim(),
				email: draft.email.trim().toLowerCase(),
				phone: draft.phone.trim(),
				problems: [],
			},
			dialCode,
		),
	)
	return markDuplicates(validated, dialCode).map((row, index) => ({
		...row,
		id: drafts[index]!.id,
		...(drafts[index]!.userId ? { userId: drafts[index]!.userId } : {}),
	}))
}

export function draftsFromRows(rows: readonly ImportRow[]): DraftRow[] {
	return rows.map((row, index) => ({
		id: `row-${index}-${row.row}`,
		firstName: row.firstName,
		lastName: row.lastName,
		email: row.email,
		phone: row.phone,
	}))
}
