import { type I18n } from '@lingui/core'
import {
	costMicroFromPackPrice,
	INVENTORY_CATEGORIES,
	STANDARD_UNIT_SPECS,
	type StandardUnit,
	thousandthsPerUnit,
} from '@repo/inventory'
import { parseMoneyToMinor } from '#app/utils/money-input.ts'
import { parseDelimited } from '#app/utils/staffing/staff-import.ts'
import { CATEGORY_LABELS, customCategory, isBuiltInCategory } from './labels.ts'
import { type BulkItemInput } from './starter-lists.ts'

/**
 * "Paste from a spreadsheet": parse, check and convert rows of name,
 * category, unit and price per unit. Nothing here talks to the network: the
 * browser checks every row, the owner reviews and fixes them, and only Add
 * posts the good ones to `POST /items/bulk`.
 */

export const BULK_MAX_ROWS = 200
const NAME_MAX = 80
const CATEGORY_MAX = 40
const CONTROL_CHARS = /\p{Cc}/u

export type BulkProblem =
	| 'name_required'
	| 'name_too_long'
	| 'name_invalid'
	| 'duplicate'
	| 'unit_required'
	| 'bad_price'
	| 'category_too_long'

export type BulkDraft = {
	/** Stable id for React keys and edits. */
	id: number
	name: string
	/** The category as stored: a built-in key or `custom:text`. */
	category: string
	/** A standard unit key, or empty while the typed unit was not understood. */
	unit: StandardUnit | ''
	/** Price of one unit as typed, or empty. */
	price: string
}

export type ReviewedBulkRow = BulkDraft & {
	/** 1-based position among the data rows, for "Row 3" messages. */
	row: number
	problems: BulkProblem[]
}

type Column = 'name' | 'category' | 'unit' | 'price'

const HEADER_ALIASES: Record<string, Column> = {
	name: 'name',
	item: 'name',
	'item name': 'name',
	الاسم: 'name',
	الصنف: 'name',
	category: 'category',
	type: 'category',
	group: 'category',
	الفئة: 'category',
	unit: 'unit',
	units: 'unit',
	'measured in': 'unit',
	الوحدة: 'unit',
	price: 'price',
	cost: 'price',
	'unit price': 'price',
	'unit cost': 'price',
	'price per unit': 'price',
	'cost per unit': 'price',
	السعر: 'price',
}

const UNIT_WORDS: Record<string, StandardUnit> = {
	kg: 'kg',
	kgs: 'kg',
	kilo: 'kg',
	kilos: 'kg',
	kilogram: 'kg',
	kilograms: 'kg',
	كجم: 'kg',
	كيلو: 'kg',
	g: 'g',
	gr: 'g',
	gram: 'g',
	grams: 'g',
	غ: 'g',
	جرام: 'g',
	l: 'l',
	lt: 'l',
	ltr: 'l',
	liter: 'l',
	litre: 'l',
	liters: 'l',
	litres: 'l',
	لتر: 'l',
	ml: 'ml',
	milliliter: 'ml',
	millilitre: 'ml',
	مل: 'ml',
	lb: 'lb',
	lbs: 'lb',
	pound: 'lb',
	pounds: 'lb',
	oz: 'oz',
	ounce: 'oz',
	ounces: 'oz',
	gal: 'gal',
	gallon: 'gal',
	gallons: 'gal',
	'fl oz': 'fl_oz',
	floz: 'fl_oz',
	qt: 'qt',
	quart: 'qt',
	quarts: 'qt',
	piece: 'piece',
	pieces: 'piece',
	pc: 'piece',
	pcs: 'piece',
	each: 'piece',
	ea: 'piece',
	unit: 'piece',
	units: 'piece',
	count: 'piece',
	حبة: 'piece',
	قطعة: 'piece',
}

/** A unit as typed ("Kg", "litres", "pcs") as a standard unit, or null. */
export function parseUnitText(text: string): StandardUnit | null {
	const key = text.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ')
	if (key === '') return null
	if (Object.hasOwn(STANDARD_UNIT_SPECS, key)) return key as StandardUnit
	return Object.hasOwn(UNIT_WORDS, key) ? UNIT_WORDS[key]! : null
}

/** A category as typed as the stored value: a built-in key, else the typed text as a custom one. */
export function resolveCategoryText(
	text: string,
	i18n: Pick<I18n, '_'>,
): string {
	const typed = text.trim()
	if (typed === '') return 'other'
	const lowered = typed.toLowerCase()
	const normalized = lowered.replace(/[\s-]+/g, '_')
	if (isBuiltInCategory(normalized)) return normalized
	for (const key of INVENTORY_CATEGORIES) {
		if (i18n._(CATEGORY_LABELS[key]).toLowerCase() === lowered) return key
	}
	return customCategory(typed)
}

function headerColumns(cells: string[]): Array<Column | null> | null {
	const mapped = cells.map(
		(cell) => HEADER_ALIASES[cell.toLowerCase().replace(/[_-]+/g, ' ')] ?? null,
	)
	// A header row names the name column and at least one other known column.
	return mapped.includes('name') && mapped.filter(Boolean).length >= 2
		? mapped
		: null
}

export type ParsedBulkText = {
	drafts: BulkDraft[]
	/** More than `BULK_MAX_ROWS` rows were pasted; the rest were left out. */
	truncated: boolean
}

/**
 * Rows from pasted text (tab, comma or semicolon separated). A first row that
 * names columns (Name, Category, Unit, Price) sets the order; without one the
 * order is name, category, unit, price.
 */
export function parseBulkText(
	text: string,
	i18n: Pick<I18n, '_'>,
): ParsedBulkText {
	const rows = parseDelimited(text)
	if (rows.length === 0) return { drafts: [], truncated: false }
	const header = headerColumns(rows[0]!)
	const columns: Array<Column | null> = header ?? [
		'name',
		'category',
		'unit',
		'price',
	]
	const data = header ? rows.slice(1) : rows
	const drafts: BulkDraft[] = []
	for (const [index, cells] of data.entries()) {
		if (index >= BULK_MAX_ROWS) break
		const pick = (column: Column) => {
			const at = columns.indexOf(column)
			return at === -1 ? '' : (cells[at] ?? '').trim()
		}
		const unitText = pick('unit')
		drafts.push({
			id: index,
			name: pick('name'),
			category: resolveCategoryText(pick('category'), i18n),
			unit: unitText === '' ? 'piece' : (parseUnitText(unitText) ?? ''),
			price: pick('price'),
		})
	}
	return { drafts, truncated: data.length > BULK_MAX_ROWS }
}

/** Mark each row with what is wrong with it (nothing wrong means it will be added). */
export function reviewBulkDrafts(
	drafts: readonly BulkDraft[],
	{ currency }: { currency: string },
): ReviewedBulkRow[] {
	const seen = new Set<string>()
	return drafts.map((draft, index) => {
		const problems: BulkProblem[] = []
		const name = draft.name.trim()
		if (name === '') problems.push('name_required')
		else if (name.length > NAME_MAX) problems.push('name_too_long')
		else if (CONTROL_CHARS.test(name)) problems.push('name_invalid')
		else {
			const key = name.toLowerCase()
			if (seen.has(key)) problems.push('duplicate')
			seen.add(key)
		}
		if (draft.unit === '') problems.push('unit_required')
		if (
			draft.price.trim() !== '' &&
			parseMoneyToMinor(draft.price, { currency, min: 0 }) === null
		) {
			problems.push('bad_price')
		}
		if (
			draft.category.startsWith('custom:') &&
			draft.category.length - 'custom:'.length > CATEGORY_MAX
		) {
			problems.push('category_too_long')
		}
		return { ...draft, row: index + 1, problems }
	})
}

/** The `POST /items/bulk` entries for rows without problems. */
export function toBulkItems(
	rows: readonly ReviewedBulkRow[],
	{ currency }: { currency: string },
): BulkItemInput[] {
	return rows
		.filter((row) => row.problems.length === 0 && row.unit !== '')
		.map((row) => {
			const unit = row.unit as StandardUnit
			const spec = STANDARD_UNIT_SPECS[unit]
			const priceMinor =
				row.price.trim() === ''
					? null
					: parseMoneyToMinor(row.price, { currency, min: 0 })
			const perUnit = thousandthsPerUnit({ kind: 'standard', unit }, spec.base)
			return {
				name: row.name.trim(),
				category: row.category,
				kind: 'bought' as const,
				baseUnit: spec.base,
				countUnit: unit,
				...(priceMinor === null
					? {}
					: {
							// The price is for one unit, so a "pack" of one unit.
							costMicro: costMicroFromPackPrice(
								priceMinor,
								Math.max(1, Math.round(perUnit)),
							),
							currency,
						}),
			}
		})
}
