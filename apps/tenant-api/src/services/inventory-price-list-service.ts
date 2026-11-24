import { createHash } from 'node:crypto'
import { parseDelimited } from '@repo/common/csv'
import { parseXlsxToRows } from '@repo/common/xlsx'
import {
	INVENTORY_CATEGORIES,
	INVENTORY_LIMITS,
	INVENTORY_MAX_MINOR,
	MAX_ENTRY_QUANTITY,
	MAX_PRICE_LIST_LINES,
	STANDARD_UNIT_SPECS,
	toBaseQuantity,
	type InventoryBaseUnit,
	type InventoryCategory,
	type PriceHistoryEntry,
	type PriceListApplyResult,
	type PriceListGoneProduct,
	type PriceListParseResult,
	type PriceListProposalLine,
	type StandardUnit,
} from '@repo/inventory'
import {
	invDeliveries,
	invDeliveryLines,
	invItems,
	invLocationSettings,
	invSupplierProductPrices,
	invSupplierProducts,
	invSuppliers,
} from '@repo/tenant-db'
import { and, count, desc, eq, isNull, ne, or } from 'drizzle-orm'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import {
	isInvoiceReaderConfigured,
	parseInvoiceNumber,
	readPriceListDocument,
} from '../lib/invoice-reader.ts'
import {
	getCachedVisionRead,
	setCachedVisionRead,
	takeVisionReadSlot,
} from '../lib/vision-read-limit.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { badRequest, newId, notFound } from './inventory-common.ts'
import { type InventoryCaller } from './inventory-items-service.ts'
import { ORG_DEFAULT_LOCATION } from './inventory-location-settings.ts'

const MAX_IMPORT_BYTES = 7_500_000

const UNIT_ALIASES: Record<string, StandardUnit> = {
	g: 'g',
	gr: 'g',
	gm: 'g',
	gram: 'g',
	grams: 'g',
	kg: 'kg',
	kgs: 'kg',
	kilo: 'kg',
	kilos: 'kg',
	kilogram: 'kg',
	kilograms: 'kg',
	ml: 'ml',
	milliliter: 'ml',
	milliliters: 'ml',
	millilitre: 'ml',
	millilitres: 'ml',
	l: 'l',
	lt: 'l',
	ltr: 'l',
	liter: 'l',
	liters: 'l',
	litre: 'l',
	litres: 'l',
	oz: 'oz',
	ounce: 'oz',
	ounces: 'oz',
	lb: 'lb',
	lbs: 'lb',
	pound: 'lb',
	pounds: 'lb',
	floz: 'fl_oz',
	'fl oz': 'fl_oz',
	fl_oz: 'fl_oz',
	'fl-oz': 'fl_oz',
	qt: 'qt',
	quart: 'qt',
	quarts: 'qt',
	gal: 'gal',
	gallon: 'gal',
	gallons: 'gal',
	pc: 'piece',
	pcs: 'piece',
	piece: 'piece',
	pieces: 'piece',
	ea: 'piece',
	each: 'piece',
	unit: 'piece',
	units: 'piece',
}

const UNIT_PATTERN =
	'fl[\\s_-]?oz|kgs?|kilos?|kilograms?|grams?|gr|gm|g|milliliters?|millilitres?|ml|liters?|litres?|ltr|lt|l|ounces?|oz|lbs?|pounds?|quarts?|qt|gallons?|gal|pieces?|pcs?|ea|each|units?'
const MULTI_PACK_RE = new RegExp(
	`(\\d+(?:[.,]\\d+)?)\\s*[xX×*]\\s*(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`,
	'i',
)
const SINGLE_PACK_RE = new RegExp(
	`(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`,
	'i',
)
const BARE_UNIT_RE = new RegExp(`^(${UNIT_PATTERN})$`, 'i')

const cleanText = (value: string, max: number): string =>
	value
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max)

export function decodeBase64Bytes(base64: string): Uint8Array {
	const cleaned = base64.replace(/\s+/g, '')
	if (
		cleaned.length === 0 ||
		cleaned.length % 4 === 1 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)
	) {
		throw badRequest('invalid_base64')
	}
	let binary: string
	try {
		binary = atob(cleaned)
	} catch {
		throw badRequest('invalid_base64')
	}
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORT_BYTES) {
		throw badRequest('file_too_large')
	}
	return bytes
}

export function detectImportFileKind(
	fileName: string,
	contentType: string,
): 'csv' | 'xlsx' | 'pdf' | 'image' {
	const ct = contentType.toLowerCase().split(';')[0]!.trim()
	const ext = fileName.toLowerCase().split('.').pop() ?? ''
	if (
		ct === 'text/csv' ||
		ct === 'text/tab-separated-values' ||
		ct === 'application/csv' ||
		(ct === 'text/plain' && (ext === 'csv' || ext === 'tsv')) ||
		ext === 'csv' ||
		ext === 'tsv'
	) {
		return 'csv'
	}
	if (
		ct ===
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
		ext === 'xlsx'
	) {
		return 'xlsx'
	}
	if (ct === 'application/pdf' || ext === 'pdf') {
		return 'pdf'
	}
	if (
		ct.startsWith('image/') &&
		(ct === 'image/jpeg' ||
			ct === 'image/jpg' ||
			ct === 'image/png' ||
			ct === 'image/webp' ||
			ct === 'image/gif' ||
			ext === 'jpg' ||
			ext === 'jpeg' ||
			ext === 'png' ||
			ext === 'webp' ||
			ext === 'gif')
	) {
		return 'image'
	}
	throw badRequest('unsupported_file_type')
}

function resolveStandardUnit(raw: string): StandardUnit | null {
	const key = raw
		.toLowerCase()
		.replace(/[\s_-]+/g, ' ')
		.trim()
	return UNIT_ALIASES[key] ?? UNIT_ALIASES[key.replace(/\s+/g, '')] ?? null
}

export type ParsedPackSpec = {
	packName: string
	packBaseQuantity: number
	baseUnit: InventoryBaseUnit
	recognizedUnit: boolean
	strippedItemName: string | null
}

function tryMatchPackText(text: string): {
	packBaseQuantity: number
	baseUnit: InventoryBaseUnit
	matchedFragment: string
	formattedPack: string
} | null {
	const multi = text.match(MULTI_PACK_RE)
	if (multi) {
		const countVal = parseInvoiceNumber(multi[1]!)
		const sizeVal = parseInvoiceNumber(multi[2]!)
		const stdUnit = resolveStandardUnit(multi[3]!)
		if (
			countVal !== null &&
			sizeVal !== null &&
			countVal > 0 &&
			sizeVal > 0 &&
			stdUnit
		) {
			const spec = STANDARD_UNIT_SPECS[stdUnit]
			const baseQty = toBaseQuantity(
				countVal * sizeVal,
				{ kind: 'standard', unit: stdUnit },
				spec.base,
			)
			if (baseQty >= 1 && baseQty <= MAX_ENTRY_QUANTITY) {
				return {
					packBaseQuantity: baseQty,
					baseUnit: spec.base,
					matchedFragment: multi[0],
					formattedPack: `${countVal}x${sizeVal} ${stdUnit}`,
				}
			}
		}
	}

	const single = text.match(SINGLE_PACK_RE)
	if (single) {
		const amount = parseInvoiceNumber(single[1]!)
		const stdUnit = resolveStandardUnit(single[2]!)
		if (amount !== null && amount > 0 && stdUnit) {
			const spec = STANDARD_UNIT_SPECS[stdUnit]
			const baseQty = toBaseQuantity(
				amount,
				{ kind: 'standard', unit: stdUnit },
				spec.base,
			)
			if (baseQty >= 1 && baseQty <= MAX_ENTRY_QUANTITY) {
				return {
					packBaseQuantity: baseQty,
					baseUnit: spec.base,
					matchedFragment: single[0],
					formattedPack: `${amount} ${stdUnit}`,
				}
			}
		}
	}

	const bare = text.trim().match(BARE_UNIT_RE)
	if (bare) {
		const stdUnit = resolveStandardUnit(bare[1]!)
		if (stdUnit) {
			const spec = STANDARD_UNIT_SPECS[stdUnit]
			const baseQty = toBaseQuantity(
				1,
				{ kind: 'standard', unit: stdUnit },
				spec.base,
			)
			return {
				packBaseQuantity: baseQty,
				baseUnit: spec.base,
				matchedFragment: bare[0],
				formattedPack: `1 ${stdUnit}`,
			}
		}
	}

	return null
}

function stripFragment(name: string, fragment: string): string | null {
	const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const cleaned = cleanText(
		name
			.replace(new RegExp(`[\\(\\[]?\\s*${escaped}\\s*[\\)\\]]?`, 'i'), ' ')
			.replace(/^[-–—,\s]+|[-–—,\s]+$/g, ''),
		80,
	)
	return cleaned || null
}

export function parsePackSpec(input: {
	packSizeText?: string | null
	unit?: string | null
	itemName?: string | null
	fallbackBaseUnit?: InventoryBaseUnit
}): ParsedPackSpec {
	const packRaw = input.packSizeText ? cleanText(input.packSizeText, 80) : ''
	const unitRaw = input.unit ? cleanText(input.unit, 40) : ''
	const itemRaw = input.itemName ? cleanText(input.itemName, 120) : ''

	// Combine plain numeric packSize with unit (e.g. "6" + "kg" -> "6 kg").
	const combined =
		packRaw && unitRaw && /^\d+(?:[.,]\d+)?$/.test(packRaw)
			? `${packRaw} ${unitRaw}`
			: packRaw && unitRaw
				? `${packRaw} ${unitRaw}`
				: ''

	const fromPack =
		(packRaw ? tryMatchPackText(packRaw) : null) ??
		(combined ? tryMatchPackText(combined) : null)
	if (fromPack) {
		const packName = cleanText(
			packRaw && !/^\d+(?:[.,]\d+)?$/.test(packRaw)
				? packRaw
				: fromPack.formattedPack,
			80,
		)
		return {
			packName: packName || fromPack.formattedPack,
			packBaseQuantity: fromPack.packBaseQuantity,
			baseUnit: fromPack.baseUnit,
			recognizedUnit: true,
			strippedItemName: null,
		}
	}

	const fromUnit = unitRaw ? tryMatchPackText(unitRaw) : null
	if (fromUnit) {
		return {
			packName: packRaw || fromUnit.formattedPack,
			packBaseQuantity: fromUnit.packBaseQuantity,
			baseUnit: fromUnit.baseUnit,
			recognizedUnit: true,
			strippedItemName: null,
		}
	}

	const fromName = itemRaw ? tryMatchPackText(itemRaw) : null
	if (fromName) {
		return {
			packName: packRaw || fromName.formattedPack,
			packBaseQuantity: fromName.packBaseQuantity,
			baseUnit: fromName.baseUnit,
			recognizedUnit: true,
			strippedItemName: stripFragment(itemRaw, fromName.matchedFragment),
		}
	}

	const fallbackBase: InventoryBaseUnit = input.fallbackBaseUnit ?? 'piece'
	return {
		packName:
			packRaw ||
			unitRaw ||
			(fallbackBase === 'g'
				? '1 kg'
				: fallbackBase === 'ml'
					? '1 L'
					: '1 piece'),
		packBaseQuantity: fallbackBase === 'piece' ? 1000 : 1_000_000,
		baseUnit: fallbackBase,
		recognizedUnit: false,
		strippedItemName: null,
	}
}

export function normalizeItemText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim()
}

function singularizeWord(word: string): string {
	if (word.length <= 3) return word
	if (word.endsWith('ies') && word.length > 4) {
		return `${word.slice(0, -3)}y`
	}
	if (word.endsWith('oes') && word.length > 4) {
		return word.slice(0, -2)
	}
	if (/(?:ches|shes|xes|zes|ses)$/.test(word) && word.length > 4) {
		return word.slice(0, -2)
	}
	if (
		word.endsWith('s') &&
		!word.endsWith('ss') &&
		!word.endsWith('us') &&
		!word.endsWith('is')
	) {
		return word.slice(0, -1)
	}
	return word
}

/**
 * Canonical item key for deduplicating similar names like "Tomato 6kg" and
 * "Tomatoes 6 kg" (removes pack spec if embedded, normalizes whitespace, and
 * singularizes basic English plurals).
 */
export function canonicalItemKey(value: string): string {
	const normalizedSpacing = value.replace(/(\d)([a-zA-Z])/g, '$1 $2')
	const norm = normalizeItemText(normalizedSpacing)
	if (!norm) return ''
	return norm.split(' ').filter(Boolean).map(singularizeWord).join(' ')
}

const CATEGORY_SET = new Set<string>(INVENTORY_CATEGORIES)

export function guessInventoryCategory(
	rawCategory: string | null | undefined,
	itemName: string,
): InventoryCategory {
	if (rawCategory) {
		const cleaned = cleanText(rawCategory, 40)
		const normalized = cleaned.toLowerCase().replace(/[\s-]+/g, '_')
		if (CATEGORY_SET.has(normalized)) return normalized as InventoryCategory
		if (/^custom:.{1,40}$/su.test(cleaned)) return cleaned as InventoryCategory
		if (/veg|fruit|produce|herb/.test(normalized)) return 'produce'
		if (/meat|poultry|beef|chicken|lamb/.test(normalized)) return 'meat'
		if (/sea|fish|shrimp/.test(normalized)) return 'seafood'
		if (/dairy|milk|cheese/.test(normalized)) return 'dairy'
		if (/dry|grain|spice|flour|rice/.test(normalized)) return 'dry_goods'
		if (/bak|bread|pastry/.test(normalized)) return 'bakery'
		if (/sauce|oil|condiment/.test(normalized)) return 'sauces'
		if (/drink|bev|juice|coffee|tea/.test(normalized)) return 'drinks'
		if (/pack|box|bag|cup/.test(normalized)) return 'packaging'
		if (/clean|hygiene|sanit/.test(normalized)) return 'cleaning'
	}
	const lower = itemName.toLowerCase()
	if (
		/\b(tomato|tomatoes|onion|onions|potato|potatoes|lettuce|lemon|garlic|cucumber|pepper|apple|banana|mint|parsley|cilantro)\b/.test(
			lower,
		)
	) {
		return 'produce'
	}
	if (/\b(chicken|beef|lamb|steak|burger|veal|turkey|meat)\b/.test(lower)) {
		return 'meat'
	}
	if (/\b(salmon|shrimp|fish|tuna|crab|prawn|seafood)\b/.test(lower)) {
		return 'seafood'
	}
	if (
		/\b(milk|cheese|butter|cream|yogurt|mozzarella|cheddar|parmesan)\b/.test(
			lower,
		)
	) {
		return 'dairy'
	}
	if (/\b(flour|rice|sugar|salt|pasta|beans|lentil|spice)\b/.test(lower)) {
		return 'dry_goods'
	}
	if (/\b(bread|bun|buns|croissant|roll|tortilla|pita)\b/.test(lower)) {
		return 'bakery'
	}
	if (/\b(sauce|oil|vinegar|ketchup|mayo|mustard|tahini)\b/.test(lower)) {
		return 'sauces'
	}
	if (/\b(water|juice|soda|cola|coffee|tea|espresso|syrup)\b/.test(lower)) {
		return 'drinks'
	}
	if (
		/\b(cup|cups|box|boxes|napkin|napkins|bag|foil|wrap|container)\b/.test(
			lower,
		)
	) {
		return 'packaging'
	}
	if (/\b(soap|detergent|bleach|sanitizer|cleaner|sponge)\b/.test(lower)) {
		return 'cleaning'
	}
	return 'other'
}

export type SpreadsheetLine = {
	name: string
	sku: string | null
	packSizeText: string | null
	unit: string | null
	price: number | null
	quantity: number | null
	lineTotal: number | null
	category: string | null
	supplierName: string | null
	pricedByWeight: boolean
}

export type ParsedSpreadsheet = {
	supplierName: string | null
	lines: SpreadsheetLine[]
}

const HEADER_MATCHERS = {
	name: /^(item|item[\s_-]*name|product|product[\s_-]*name|description|material|name|الاسم|الصنف|المنتج|اسم الصنف)$/i,
	sku: /^(sku|code|item[\s_-]*code|product[\s_-]*code|part[\s_-]*no|barcode|رمز|كود)$/i,
	packSize: /^(pack|pack[\s_-]*size|size|packaging|uom|التعبئة|الحجم)$/i,
	unit: /^(unit|units|measure|الوحدة)$/i,
	price:
		/^(price|unit[\s_-]*price|pack[\s_-]*price|cost|rate|amount|السعر|سعر)$/i,
	quantity: /^(qty|quantity|count|الكمية)$/i,
	lineTotal: /^(total|line[\s_-]*total|ext[\s_-]*price|المجموع|الاجمالي)$/i,
	category: /^(category|group|الفئة|التصنيف)$/i,
	supplier: /^(supplier|vendor|merchant|المورد)$/i,
	pricedByWeight:
		/^(by[\s_-]*weight|priced[\s_-]*by[\s_-]*weight|catch[\s_-]*weight)$/i,
} as const

type ColumnMap = Partial<Record<keyof typeof HEADER_MATCHERS, number>>

function detectHeaderRow(rows: string[][]): {
	headerIndex: number
	columns: ColumnMap
} | null {
	const maxCheck = Math.min(rows.length, 5)
	for (let r = 0; r < maxCheck; r++) {
		const row = rows[r]!
		const columns: ColumnMap = {}
		let hits = 0
		for (let c = 0; c < row.length; c++) {
			const cell = cleanText(row[c] ?? '', 60)
			if (!cell) continue
			for (const [key, regex] of Object.entries(HEADER_MATCHERS)) {
				const colKey = key as keyof typeof HEADER_MATCHERS
				if (columns[colKey] === undefined && regex.test(cell)) {
					columns[colKey] = c
					hits++
					break
				}
			}
		}
		if (
			hits >= 2 ||
			(hits === 1 &&
				(columns.name !== undefined || columns.price !== undefined))
		) {
			return { headerIndex: r, columns }
		}
	}
	return null
}

function inferPositionalColumns(rows: string[][]): ColumnMap {
	const sample = rows[0] ?? []
	const colCount = sample.length
	if (colCount <= 1) return { name: 0 }
	if (colCount === 2) return { name: 0, price: 1 }
	// Look for rightmost numeric price column across first few rows.
	let priceCol = colCount - 1
	for (let c = colCount - 1; c >= 1; c--) {
		const numericCount = rows
			.slice(0, 5)
			.filter((r) => parseInvoiceNumber(r[c] ?? '') !== null).length
		if (numericCount > 0) {
			priceCol = c
			break
		}
	}
	const columns: ColumnMap = { name: 0, price: priceCol }
	if (priceCol >= 2) {
		// Check if col 1 looks like SKU or packSize.
		const col1Sample = rows
			.slice(0, 5)
			.map((r) => r[1] ?? '')
			.join(' ')
		if (SINGLE_PACK_RE.test(col1Sample) || MULTI_PACK_RE.test(col1Sample)) {
			columns.packSize = 1
		} else if (priceCol >= 3) {
			columns.sku = 1
			columns.packSize = 2
		} else {
			columns.packSize = 1
		}
	}
	return columns
}

export function parseSpreadsheetRows(rows: string[][]): ParsedSpreadsheet {
	const nonEmpty = rows.filter((r) => r.some((cell) => cell.trim() !== ''))
	if (nonEmpty.length === 0) return { supplierName: null, lines: [] }

	let fileSupplier: string | null = null
	let dataStart = 0
	const detected = detectHeaderRow(nonEmpty)
	let columns: ColumnMap
	if (detected) {
		for (let r = 0; r < detected.headerIndex; r++) {
			const row = nonEmpty[r]!
			const first = cleanText(row[0] ?? '', 80)
			if (/^supplier\b|^vendor\b/i.test(first)) {
				const second = cleanText(row[1] ?? '', 120)
				if (second) fileSupplier = second
				else if (first.includes(':')) {
					fileSupplier =
						cleanText(first.split(':').slice(1).join(':'), 120) || null
				}
			}
		}
		columns = detected.columns
		dataStart = detected.headerIndex + 1
	} else {
		columns = inferPositionalColumns(nonEmpty)
	}

	const nameCol = columns.name ?? 0
	const lines: SpreadsheetLine[] = []
	for (let r = dataStart; r < nonEmpty.length; r++) {
		const row = nonEmpty[r]!
		const rawName = cleanText(row[nameCol] ?? '', 120)
		if (!rawName) continue
		const sku =
			columns.sku !== undefined
				? cleanText(row[columns.sku] ?? '', 60) || null
				: null
		const packSizeText =
			columns.packSize !== undefined
				? cleanText(row[columns.packSize] ?? '', 60) || null
				: null
		const unit =
			columns.unit !== undefined
				? cleanText(row[columns.unit] ?? '', 20) || null
				: null
		const rawPrice =
			columns.price !== undefined
				? parseInvoiceNumber(row[columns.price] ?? '')
				: null
		const rawQty =
			columns.quantity !== undefined
				? parseInvoiceNumber(row[columns.quantity] ?? '')
				: null
		const rawLineTotal =
			columns.lineTotal !== undefined
				? parseInvoiceNumber(row[columns.lineTotal] ?? '')
				: null
		const price =
			rawPrice !== null && rawPrice >= 0 && rawPrice <= 1_000_000_000
				? rawPrice
				: null
		const quantity =
			rawQty !== null && rawQty >= 0 && rawQty <= 1_000_000_000 ? rawQty : null
		const lineTotal =
			rawLineTotal !== null &&
			rawLineTotal >= 0 &&
			rawLineTotal <= 1_000_000_000
				? rawLineTotal
				: null
		const category =
			columns.category !== undefined
				? cleanText(row[columns.category] ?? '', 40) || null
				: null
		const rowSupplier =
			columns.supplier !== undefined
				? cleanText(row[columns.supplier] ?? '', 120) || null
				: null
		const byWeightText =
			columns.pricedByWeight !== undefined
				? cleanText(row[columns.pricedByWeight] ?? '', 16).toLowerCase()
				: ''
		const pricedByWeight =
			byWeightText === 'true' ||
			byWeightText === 'yes' ||
			byWeightText === '1' ||
			byWeightText === 'y'

		lines.push({
			name: rawName,
			sku,
			packSizeText,
			unit,
			price,
			quantity,
			lineTotal,
			category,
			supplierName: rowSupplier ?? fileSupplier,
			pricedByWeight,
		})
	}

	return { supplierName: fileSupplier, lines }
}

export function toMinorClamped(
	major: number | null | undefined,
): number | null {
	if (major === null || major === undefined || !Number.isFinite(major)) {
		return null
	}
	const minor = Math.round(major * 100)
	return minor >= 0 && minor <= INVENTORY_MAX_MINOR ? minor : null
}

export function parseEffectiveDateUtcNoon(
	isoDate: string | undefined,
	fallbackMs: number,
): number {
	if (!isoDate) return fallbackMs
	const ms = Date.parse(`${isoDate}T12:00:00.000Z`)
	return Number.isFinite(ms) ? ms : fallbackMs
}

export async function getOrgDefaultCurrency(
	db: InventoryReader,
): Promise<string> {
	const rows = await db.select().from(invLocationSettings)
	const orgRow = rows.find((r) => r.locationId === ORG_DEFAULT_LOCATION)
	if (orgRow?.currency) return orgRow.currency
	const locRow = rows.find((r) => Boolean(r.currency))
	if (locRow?.currency) return locRow.currency
	const supRow = await db
		.select({ currency: invSuppliers.currency })
		.from(invSuppliers)
		.where(isNull(invSuppliers.archivedAt))
		.limit(1)
		.get()
	return supRow?.currency ?? ''
}

export async function parseSupplierPriceList(
	caller: InventoryCaller,
	input: {
		supplierId: string
		body: { fileName: string; contentType: string; contentBase64: string }
	},
): Promise<PriceListParseResult> {
	const db = await import('@repo/tenant-db').then((m) =>
		m.getTenantDb(caller.orgId),
	)
	const supplier = await db
		.select()
		.from(invSuppliers)
		.where(
			and(
				eq(invSuppliers.id, input.supplierId),
				isNull(invSuppliers.archivedAt),
			),
		)
		.get()
	if (!supplier) throw notFound()

	const fileKind = detectImportFileKind(
		input.body.fileName,
		input.body.contentType,
	)
	const bytes = decodeBase64Bytes(input.body.contentBase64)
	const readerConfigured = isInvoiceReaderConfigured()

	let rawLines: SpreadsheetLine[] = []
	if (fileKind === 'csv') {
		const text = new TextDecoder('utf-8').decode(bytes)
		rawLines = parseSpreadsheetRows(parseDelimited(text)).lines
	} else if (fileKind === 'xlsx') {
		let rows: string[][]
		try {
			rows = await parseXlsxToRows(bytes)
		} catch {
			throw badRequest('invalid_spreadsheet')
		}
		rawLines = parseSpreadsheetRows(rows).lines
	} else {
		if (!readerConfigured) {
			throw new InventoryError('reader_not_configured', 503)
		}
		const now = Date.now()
		const digest = createHash('sha256').update(bytes).digest('hex')
		const cacheKey = `pricelist:${caller.orgId}:${input.body.contentType}:${digest}`
		let doc = getCachedVisionRead<
			Awaited<ReturnType<typeof readPriceListDocument>>
		>(cacheKey, now)
		if (!doc) {
			if (!takeVisionReadSlot(caller.orgId, now)) {
				throw new InventoryError('invalid_request', 429, {
					reason: 'reader_rate_limited',
				})
			}
			try {
				doc = await readPriceListDocument({
					bytes,
					contentType: input.body.contentType,
					fileName: input.body.fileName,
				})
			} catch {
				throw new InventoryError('reader_failed', 502)
			}
			setCachedVisionRead(cacheKey, doc, now)
		}
		rawLines = doc.lines.map((line) => ({
			name: line.name,
			sku: line.sku,
			packSizeText: line.packSizeText,
			unit: line.unit,
			price: line.price,
			quantity: null,
			lineTotal: null,
			category: null,
			supplierName: doc.supplierName,
			pricedByWeight: line.pricedByWeight,
		}))
	}

	const truncated = rawLines.length > MAX_PRICE_LIST_LINES
	const capped = rawLines.slice(0, MAX_PRICE_LIST_LINES)

	const [items, supplierProducts] = await Promise.all([
		db.select().from(invItems).where(isNull(invItems.archivedAt)),
		db
			.select({
				product: invSupplierProducts,
				itemName: invItems.name,
				itemBaseUnit: invItems.baseUnit,
				itemCategory: invItems.category,
			})
			.from(invSupplierProducts)
			.innerJoin(invItems, eq(invItems.id, invSupplierProducts.itemId))
			.where(
				and(
					eq(invSupplierProducts.supplierId, supplier.id),
					isNull(invSupplierProducts.archivedAt),
				),
			),
	])

	const itemById = new Map(items.map((item) => [item.id, item]))
	const itemByNorm = new Map<string, (typeof items)[number]>()
	const itemByCanonical = new Map<string, (typeof items)[number]>()
	for (const item of items) {
		const norm = normalizeItemText(item.name)
		if (norm && !itemByNorm.has(norm)) itemByNorm.set(norm, item)
		const canon = canonicalItemKey(item.name)
		if (canon && !itemByCanonical.has(canon)) itemByCanonical.set(canon, item)
	}

	const productBySku = new Map<string, (typeof supplierProducts)[number]>()
	const productByPackNorm = new Map<string, (typeof supplierProducts)[number]>()
	const productsByItemId = new Map<
		string,
		Array<(typeof supplierProducts)[number]>
	>()
	for (const entry of supplierProducts) {
		if (entry.product.sku) {
			const skuKey = entry.product.sku.trim().toLowerCase()
			if (skuKey && !productBySku.has(skuKey)) productBySku.set(skuKey, entry)
		}
		const packKey = normalizeItemText(entry.product.packName)
		if (packKey && !productByPackNorm.has(packKey)) {
			productByPackNorm.set(packKey, entry)
		}
		const list = productsByItemId.get(entry.product.itemId)
		if (list) list.push(entry)
		else productsByItemId.set(entry.product.itemId, [entry])
	}

	const matchedProductIds = new Set<string>()
	const lines: PriceListProposalLine[] = capped.map((row, index) => {
		const initialPack = parsePackSpec({
			packSizeText: row.packSizeText,
			unit: row.unit,
			itemName: row.name,
		})
		const cleanName =
			cleanText(initialPack.strippedItemName ?? row.name, 80) ||
			cleanText(row.name, 80)

		let matchedProduct: (typeof supplierProducts)[number] | undefined
		if (row.sku) {
			matchedProduct = productBySku.get(row.sku.trim().toLowerCase())
		}
		if (!matchedProduct) {
			const rowPackNorm = normalizeItemText(initialPack.packName)
			const rowNameNorm = normalizeItemText(row.name)
			if (rowNameNorm && productByPackNorm.has(rowNameNorm)) {
				matchedProduct = productByPackNorm.get(rowNameNorm)
			} else if (rowPackNorm && productByPackNorm.has(rowPackNorm)) {
				const candidate = productByPackNorm.get(rowPackNorm)!
				if (
					normalizeItemText(candidate.itemName) ===
						normalizeItemText(cleanName) ||
					canonicalItemKey(candidate.itemName) === canonicalItemKey(cleanName)
				) {
					matchedProduct = candidate
				}
			}
		}

		let matchedItem = matchedProduct
			? itemById.get(matchedProduct.product.itemId)
			: undefined
		if (!matchedItem) {
			matchedItem =
				itemByNorm.get(normalizeItemText(cleanName)) ??
				itemByNorm.get(normalizeItemText(row.name)) ??
				itemByCanonical.get(canonicalItemKey(cleanName))
		}
		if (!matchedProduct && matchedItem) {
			const candidates = productsByItemId.get(matchedItem.id) ?? []
			if (candidates.length === 1) {
				matchedProduct = candidates[0]
			} else if (candidates.length > 1) {
				matchedProduct = candidates.find(
					(c) => c.product.packBaseQuantity === initialPack.packBaseQuantity,
				)
			}
		}

		const finalPack =
			matchedItem && !initialPack.recognizedUnit
				? parsePackSpec({
						packSizeText: row.packSizeText,
						unit: row.unit,
						itemName: row.name,
						fallbackBaseUnit: matchedItem.baseUnit,
					})
				: initialPack

		const priceMinor = toMinorClamped(row.price)
		const warnings: string[] = []
		if (priceMinor === null) warnings.push('missing_price')
		if (!finalPack.recognizedUnit) warnings.push('unknown_pack_size')

		let matchKind: PriceListProposalLine['matchKind']
		let existingProductId: string | null = null
		let previousPriceMinor: number | null = null
		let changeKind: PriceListProposalLine['changeKind']

		if (matchedProduct) {
			matchedProductIds.add(matchedProduct.product.id)
			matchKind = 'matched_product'
			existingProductId = matchedProduct.product.id
			previousPriceMinor = matchedProduct.product.priceMinor
			if (priceMinor === null) {
				changeKind = 'unchanged'
			} else if (
				previousPriceMinor === null ||
				priceMinor !== previousPriceMinor
			) {
				changeKind = 'price_changed'
			} else {
				changeKind = 'unchanged'
			}
		} else if (matchedItem) {
			matchKind = 'matched_item'
			changeKind = 'new'
		} else {
			matchKind = 'new_item'
			changeKind = 'new'
		}

		const baseUnit = matchedItem?.baseUnit ?? finalPack.baseUnit
		const category = matchedItem
			? (matchedItem.category as InventoryCategory)
			: guessInventoryCategory(row.category, cleanName)

		return {
			lineKey: `line-${index + 1}`,
			rawText: cleanText(row.name, 120),
			sku: row.sku,
			name: matchedItem ? matchedItem.name : cleanName,
			packName: finalPack.packName,
			packBaseQuantity: finalPack.packBaseQuantity,
			baseUnit,
			category,
			priceMinor,
			pricedByWeight: row.pricedByWeight,
			matchKind,
			existingProductId,
			matchedItemId: matchedItem?.id ?? null,
			matchedItemName: matchedItem?.name ?? null,
			changeKind,
			previousPriceMinor,
			warnings,
		}
	})

	const goneProducts: PriceListGoneProduct[] = supplierProducts
		.filter((entry) => !matchedProductIds.has(entry.product.id))
		.map((entry) => ({
			productId: entry.product.id,
			itemId: entry.product.itemId,
			itemName: entry.itemName,
			packName: entry.product.packName,
			sku: entry.product.sku,
			priceMinor: entry.product.priceMinor,
		}))

	const currency = supplier.currency || (await getOrgDefaultCurrency(db))

	return {
		supplierId: supplier.id,
		fileName: input.body.fileName,
		fileKind,
		currency,
		truncated,
		totalParsed: lines.length,
		readerConfigured,
		lines,
		goneProducts,
	}
}

export async function applySupplierPriceList(
	caller: InventoryCaller,
	input: {
		supplierId: string
		body: {
			effectiveDate?: string
			currency: string
			lines: Array<{
				action: 'upsert' | 'skip'
				existingProductId?: string | null
				matchedItemId?: string | null
				createItem?: {
					name: string
					baseUnit: InventoryBaseUnit
					category?: string
				}
				packName: string
				packBaseQuantity: number
				priceMinor: number
				pricedByWeight: boolean
				sku?: string | null
			}>
			archiveGoneProductIds?: string[]
		}
	},
): Promise<PriceListApplyResult> {
	return withInventoryWrite(
		{ orgId: caller.orgId, skipAutoSoldOut: true },
		async (tx, ctx) => {
			const supplier = await tx
				.select()
				.from(invSuppliers)
				.where(
					and(
						eq(invSuppliers.id, input.supplierId),
						isNull(invSuppliers.archivedAt),
					),
				)
				.get()
			if (!supplier) throw notFound()
			if (supplier.currency && supplier.currency !== input.body.currency) {
				throw new InventoryError('currency_mismatch', 400, {
					reason: 'currency_mismatch',
				})
			}

			const effectiveAt = parseEffectiveDateUtcNoon(
				input.body.effectiveDate,
				ctx.now,
			)
			const [existingItems, existingProducts] = await Promise.all([
				tx.select().from(invItems).where(isNull(invItems.archivedAt)),
				tx
					.select()
					.from(invSupplierProducts)
					.where(
						and(
							eq(invSupplierProducts.supplierId, supplier.id),
							isNull(invSupplierProducts.archivedAt),
						),
					),
			])

			const itemById = new Map(existingItems.map((i) => [i.id, i]))
			const itemByLower = new Map(
				existingItems.map((i) => [i.name.toLowerCase(), i]),
			)
			let activeItemCount = existingItems.length
			const productById = new Map(existingProducts.map((p) => [p.id, p]))

			let createdItems = 0
			let createdProducts = 0
			let updatedProducts = 0
			let archivedProducts = 0
			let recordedPrices = 0

			for (const line of input.body.lines) {
				if (line.action === 'skip') continue

				let itemId: string | null = null
				if (line.matchedItemId) {
					if (!itemById.has(line.matchedItemId)) throw notFound()
					itemId = line.matchedItemId
				} else if (line.existingProductId) {
					const prod = productById.get(line.existingProductId)
					if (!prod) throw notFound()
					itemId = prod.itemId
				} else if (line.createItem) {
					const existingByName = itemByLower.get(
						line.createItem.name.trim().toLowerCase(),
					)
					if (existingByName) {
						itemId = existingByName.id
					} else {
						if (activeItemCount >= INVENTORY_LIMITS.items) {
							throw new InventoryError('limit_reached', 409)
						}
						const newItemId = newId()
						const inserted = {
							id: newItemId,
							name: line.createItem.name,
							category: line.createItem.category ?? 'other',
							kind: 'bought' as const,
							baseUnit: line.createItem.baseUnit,
							notes: null,
							batchCounted: false,
							autoSoldOut: false,
							isDraft: false,
							isKey: false,
							countedByBottle: false,
							bottleSizeMl: null,
							fullBottleWeightG: null,
							emptyBottleWeightG: null,
							mergedIntoId: null,
							archivedAt: null,
							version: 1,
							createdAt: ctx.now,
							updatedAt: ctx.now,
						}
						await tx.insert(invItems).values(inserted)
						activeItemCount++
						createdItems++
						itemById.set(newItemId, inserted)
						itemByLower.set(inserted.name.toLowerCase(), inserted)
						itemId = newItemId
					}
				} else {
					throw badRequest('item_required')
				}

				let product = line.existingProductId
					? productById.get(line.existingProductId)
					: undefined
				if (line.existingProductId && !product) throw notFound()
				if (!product) {
					const skuNorm = line.sku?.trim().toLowerCase()
					product = [...productById.values()].find(
						(p) =>
							p.itemId === itemId &&
							((skuNorm && p.sku?.trim().toLowerCase() === skuNorm) ||
								(p.packName.toLowerCase() === line.packName.toLowerCase() &&
									p.packBaseQuantity === line.packBaseQuantity)),
					)
				}

				let productId: string
				if (product) {
					productId = product.id
					await tx
						.update(invSupplierProducts)
						.set({
							packName: line.packName,
							packBaseQuantity: line.packBaseQuantity,
							priceMinor: line.priceMinor,
							currency: input.body.currency,
							pricedByWeight: line.pricedByWeight,
							sku: line.sku ? line.sku : null,
							version: product.version + 1,
							updatedAt: ctx.now,
						})
						.where(eq(invSupplierProducts.id, product.id))
					productById.set(product.id, {
						...product,
						packName: line.packName,
						packBaseQuantity: line.packBaseQuantity,
						priceMinor: line.priceMinor,
						currency: input.body.currency,
						pricedByWeight: line.pricedByWeight,
						sku: line.sku ? line.sku : null,
						version: product.version + 1,
						updatedAt: ctx.now,
					})
					updatedProducts++
				} else {
					productId = newId()
					const newProduct = {
						id: productId,
						supplierId: supplier.id,
						itemId,
						packName: line.packName,
						packBaseQuantity: line.packBaseQuantity,
						priceMinor: line.priceMinor,
						currency: input.body.currency,
						pricedByWeight: line.pricedByWeight,
						sku: line.sku ? line.sku : null,
						preferred: false,
						archivedAt: null,
						version: 1,
						createdAt: ctx.now,
						updatedAt: ctx.now,
					}
					await tx.insert(invSupplierProducts).values(newProduct)
					productById.set(productId, newProduct)
					createdProducts++
				}

				await tx.insert(invSupplierProductPrices).values({
					id: newId(),
					supplierId: supplier.id,
					supplierProductId: productId,
					itemId,
					packName: line.packName,
					packBaseQuantity: line.packBaseQuantity,
					priceMinor: line.priceMinor,
					currency: input.body.currency,
					source: 'price_list',
					deliveryLineId: null,
					effectiveAt,
					createdAt: ctx.now,
				})
				recordedPrices++
			}

			for (const goneId of new Set(input.body.archiveGoneProductIds ?? [])) {
				const product = productById.get(goneId)
				if (!product) continue
				await tx
					.update(invSupplierProducts)
					.set({
						archivedAt: ctx.now,
						preferred: false,
						version: product.version + 1,
						updatedAt: ctx.now,
					})
					.where(eq(invSupplierProducts.id, product.id))
				productById.delete(goneId)
				archivedProducts++
			}

			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'price_list.apply',
				resourceType: 'supplier',
				resourceId: supplier.id,
				detail: {
					createdItems,
					createdProducts,
					updatedProducts,
					archivedProducts,
					recordedPrices,
				},
				at: ctx.now,
			})

			return {
				createdItems,
				createdProducts,
				updatedProducts,
				archivedProducts,
				recordedPrices,
			}
		},
	)
}

async function queryPriceHistory(
	db: InventoryReader,
	whereClause: ReturnType<typeof eq>,
): Promise<{ entries: PriceHistoryEntry[] }> {
	const rows = await db
		.select({
			price: invSupplierProductPrices,
			supplierName: invSuppliers.name,
		})
		.from(invSupplierProductPrices)
		.innerJoin(
			invSuppliers,
			eq(invSuppliers.id, invSupplierProductPrices.supplierId),
		)
		.leftJoin(
			invDeliveryLines,
			eq(invDeliveryLines.id, invSupplierProductPrices.deliveryLineId),
		)
		.leftJoin(invDeliveries, eq(invDeliveries.id, invDeliveryLines.deliveryId))
		.where(
			and(
				whereClause,
				or(isNull(invDeliveries.id), ne(invDeliveries.status, 'cancelled')),
			),
		)
		.orderBy(
			desc(invSupplierProductPrices.effectiveAt),
			desc(invSupplierProductPrices.createdAt),
			desc(invSupplierProductPrices.id),
		)
		.limit(200)

	return {
		entries: rows.map(({ price, supplierName }) => ({
			id: price.id,
			supplierId: price.supplierId,
			supplierName,
			supplierProductId: price.supplierProductId,
			itemId: price.itemId,
			packName: price.packName,
			packBaseQuantity: price.packBaseQuantity,
			priceMinor: price.priceMinor,
			currency: price.currency,
			source: price.source,
			deliveryLineId: price.deliveryLineId,
			effectiveAt: price.effectiveAt,
			createdAt: price.createdAt,
		})),
	}
}

export async function listSupplierProductPrices(
	db: InventoryReader,
	supplierProductId: string,
): Promise<{ entries: PriceHistoryEntry[] }> {
	const product = await db
		.select({ id: invSupplierProducts.id })
		.from(invSupplierProducts)
		.where(eq(invSupplierProducts.id, supplierProductId))
		.get()
	if (!product) throw notFound()
	return queryPriceHistory(
		db,
		eq(invSupplierProductPrices.supplierProductId, supplierProductId),
	)
}

export async function listItemPriceHistory(
	db: InventoryReader,
	itemId: string,
): Promise<{ entries: PriceHistoryEntry[] }> {
	const item = await db
		.select({ id: invItems.id })
		.from(invItems)
		.where(eq(invItems.id, itemId))
		.get()
	if (!item) throw notFound()
	return queryPriceHistory(db, eq(invSupplierProductPrices.itemId, itemId))
}

export async function activeSupplierCount(
	db: InventoryReader,
): Promise<number> {
	const row = await db
		.select({ n: count() })
		.from(invSuppliers)
		.where(isNull(invSuppliers.archivedAt))
		.get()
	return Number(row?.n ?? 0)
}
