import {
	MENU_ORDER_TYPES,
	parseOrderTypePrices,
	type MenuOrderType,
	type OrderTypePrices,
} from '@repo/common/menu-pricing'
import { toCsv } from '@repo/staffing'
import { parseMoneyToMinor } from '#app/utils/money-input.ts'
import { parseDelimited } from '#app/utils/staffing/staff-import.ts'

/**
 * Prices and availability from a spreadsheet (#411). The owner downloads a CSV
 * of every dish (Excel opens it), edits prices and availability, and uploads
 * it. Every row is checked first: one bad row lists its problem and nothing is
 * applied. A blank cell leaves that value as it is. The headers are fixed
 * column keys, so a file in any language still matches the template; a file
 * with other columns is refused.
 *
 * The price column is the dish's base price. The dine-in, pickup and delivery
 * columns are its optional order-type prices (#412): blank keeps them, a dash
 * (-) clears one. Dishes with variations take their prices on the dish page,
 * so their price cells must be left as downloaded.
 */

export const SPREADSHEET_COLUMNS = [
	'id',
	'dish',
	'category',
	'price',
	'dine_in_price',
	'pickup_price',
	'delivery_price',
	'availability',
] as const
export type SpreadsheetColumn = (typeof SPREADSHEET_COLUMNS)[number]

export const SPREADSHEET_MAX_ROWS = 2000
/** Upload size the server reads (about 1 MB). */
export const SPREADSHEET_MAX_BYTES = 1_000_000

const ORDER_TYPE_COLUMN: Record<MenuOrderType, SpreadsheetColumn> = {
	dine_in: 'dine_in_price',
	pickup: 'pickup_price',
	delivery: 'delivery_price',
}

export type SpreadsheetAvailability = 'available' | 'sold_out' | 'hidden'

/** Stored status for each spreadsheet word. */
const STATUS_FOR: Record<SpreadsheetAvailability, string> = {
	available: 'available',
	sold_out: 'unavailable',
	hidden: 'hidden',
}

/** Words accepted in the availability column (English and Arabic). */
const AVAILABILITY_WORDS: Record<string, SpreadsheetAvailability> = {
	available: 'available',
	on: 'available',
	yes: 'available',
	'sold out': 'sold_out',
	sold_out: 'sold_out',
	soldout: 'sold_out',
	unavailable: 'sold_out',
	hidden: 'hidden',
	hide: 'hidden',
	متاح: 'available',
	متوفر: 'available',
	نفد: 'sold_out',
	'نفدت الكمية': 'sold_out',
	'غير متاح': 'sold_out',
	مخفي: 'hidden',
}

export function availabilityWord(status: string): SpreadsheetAvailability {
	if (status === 'hidden') return 'hidden'
	if (status === 'available') return 'available'
	return 'sold_out'
}

export type SpreadsheetDish = {
	id: string
	name: string
	category: string
	price: number
	orderTypePrices: string | null
	availabilityStatus: string
	hasVariations: boolean
}

/** The template: every dish with its current values. */
export function buildMenuSpreadsheet(
	dishes: readonly SpreadsheetDish[],
): string {
	return toCsv(
		SPREADSHEET_COLUMNS,
		dishes.map((dish) => {
			const prices = parseOrderTypePrices(dish.orderTypePrices) ?? {}
			return [
				dish.id,
				dish.name,
				dish.category,
				dish.price.toFixed(2),
				prices.dine_in?.toFixed(2) ?? '',
				prices.pickup?.toFixed(2) ?? '',
				prices.delivery?.toFixed(2) ?? '',
				availabilityWord(dish.availabilityStatus),
			]
		}),
		{ bom: true },
	)
}

export type SpreadsheetProblem =
	| 'unknown_dish'
	| 'duplicate_row'
	| 'bad_price'
	| 'bad_availability'
	| 'variation_price'

export type SpreadsheetRowProblem = {
	/** 1-based row in the file, header included, as a spreadsheet shows it. */
	row: number
	id: string
	problem: SpreadsheetProblem
	column?: SpreadsheetColumn
}

export type SpreadsheetChange = {
	row: number
	itemId: string
	name: string
	before: {
		price: number
		orderTypePrices: OrderTypePrices | null
		availability: SpreadsheetAvailability
	}
	after: {
		price: number
		orderTypePrices: OrderTypePrices | null
		availability: SpreadsheetAvailability
	}
	/** What changed: price, dine_in_price, pickup_price, delivery_price, availability. */
	fields: SpreadsheetColumn[]
	/** Stored values to write. */
	write: {
		price?: number
		orderTypePrices?: string | null
		availabilityStatus?: string
	}
}

export type SpreadsheetPlan =
	| { ok: false; error: 'not_template' | 'empty' | 'too_many_rows' }
	| {
			ok: true
			changes: SpreadsheetChange[]
			problems: SpreadsheetRowProblem[]
			rows: number
	  }

function cell(value: string | undefined): string {
	// A cell exported as `'=…` (formula guard) reads back without the guard.
	return (value ?? '').trim().replace(/^'/, '').trim()
}

function samePrices(a: OrderTypePrices | null, b: OrderTypePrices | null) {
	return MENU_ORDER_TYPES.every(
		(type) => (a?.[type] ?? null) === (b?.[type] ?? null),
	)
}

/**
 * Reads an uploaded file against the current dishes. Never writes: the caller
 * applies `changes` only when `problems` is empty.
 */
export function planMenuSpreadsheet(
	text: string,
	dishes: ReadonlyMap<string, SpreadsheetDish>,
): SpreadsheetPlan {
	const rows = parseDelimited(text)
	if (rows.length === 0) return { ok: false, error: 'empty' }
	const header = rows[0]!.map((value) =>
		cell(value)
			.toLowerCase()
			.replace(/[\s-]+/g, '_'),
	)
	const known = new Set<string>(SPREADSHEET_COLUMNS)
	if (
		!header.includes('id') ||
		header.some((name) => name && !known.has(name)) ||
		new Set(header.filter(Boolean)).size !== header.filter(Boolean).length
	) {
		return { ok: false, error: 'not_template' }
	}
	if (rows.length - 1 > SPREADSHEET_MAX_ROWS)
		return { ok: false, error: 'too_many_rows' }
	const column = (name: SpreadsheetColumn) => header.indexOf(name)

	const changes: SpreadsheetChange[] = []
	const problems: SpreadsheetRowProblem[] = []
	const seen = new Set<string>()
	rows.slice(1).forEach((values, index) => {
		const row = index + 2
		const read = (name: SpreadsheetColumn) => {
			const at = column(name)
			return at === -1 ? '' : cell(values[at])
		}
		const id = read('id')
		const dish = dishes.get(id)
		if (!dish) {
			problems.push({ row, id, problem: 'unknown_dish', column: 'id' })
			return
		}
		if (seen.has(id)) {
			problems.push({ row, id, problem: 'duplicate_row', column: 'id' })
			return
		}
		seen.add(id)

		const beforePrices = parseOrderTypePrices(dish.orderTypePrices)
		const before = {
			price: dish.price,
			orderTypePrices: beforePrices,
			availability: availabilityWord(dish.availabilityStatus),
		}
		const after = {
			...before,
			orderTypePrices: beforePrices ? { ...beforePrices } : null,
		}
		const fields: SpreadsheetColumn[] = []
		let bad = false

		const priceText = read('price')
		if (priceText) {
			const minor = parseMoneyToMinor(priceText, { max: 99_999_999 })
			if (minor === null) {
				problems.push({ row, id, problem: 'bad_price', column: 'price' })
				bad = true
			} else if (Math.round(dish.price * 100) !== minor) {
				if (dish.hasVariations) {
					problems.push({
						row,
						id,
						problem: 'variation_price',
						column: 'price',
					})
					bad = true
				} else {
					after.price = minor / 100
					fields.push('price')
				}
			}
		}

		for (const type of MENU_ORDER_TYPES) {
			const name = ORDER_TYPE_COLUMN[type]
			const text = read(name)
			if (!text) continue
			const current = beforePrices?.[type] ?? null
			let next: number | null
			if (text === '-' || text === '–' || text === '—') {
				next = null
			} else {
				const minor = parseMoneyToMinor(text, { max: 99_999_999 })
				if (minor === null) {
					problems.push({ row, id, problem: 'bad_price', column: name })
					bad = true
					continue
				}
				next = minor / 100
			}
			if (next === current) continue
			if (dish.hasVariations) {
				problems.push({ row, id, problem: 'variation_price', column: name })
				bad = true
				continue
			}
			const prices: OrderTypePrices = { ...after.orderTypePrices }
			if (next === null) delete prices[type]
			else prices[type] = next
			after.orderTypePrices = Object.keys(prices).length ? prices : null
			fields.push(name)
		}

		const availabilityText = read('availability')
		if (availabilityText) {
			const word =
				AVAILABILITY_WORDS[
					availabilityText.toLowerCase().replace(/[_-]+/g, ' ')
				] ?? AVAILABILITY_WORDS[availabilityText.toLowerCase()]
			if (!word) {
				problems.push({
					row,
					id,
					problem: 'bad_availability',
					column: 'availability',
				})
				bad = true
			} else if (word !== before.availability) {
				after.availability = word
				fields.push('availability')
			}
		}

		if (bad || fields.length === 0) return
		changes.push({
			row,
			itemId: id,
			name: dish.name,
			before,
			after,
			fields,
			write: {
				...(fields.includes('price') ? { price: after.price } : {}),
				...(!samePrices(before.orderTypePrices, after.orderTypePrices)
					? {
							orderTypePrices: after.orderTypePrices
								? JSON.stringify(after.orderTypePrices)
								: null,
						}
					: {}),
				...(fields.includes('availability')
					? { availabilityStatus: STATUS_FOR[after.availability] }
					: {}),
			},
		})
	})
	return { ok: true, changes, problems, rows: rows.length - 1 }
}
