import { plural, t } from '@lingui/macro'
import {
	parseUnitRef,
	QUANTITY_SCALE,
	STANDARD_UNIT_SPECS,
	standardUnitsFor,
	type InventoryBaseUnit,
	stationDeliverySchema,
	type StationCatalog,
	type StationItem,
	type StationExpectedDelivery,
	type UnitRef,
	STATION_WASTE_UNDO_UI_MS,
	MAX_ENTRY_QUANTITY,
} from '@repo/inventory'

/**
 * The Stock app's rules that need no screen: units and steps, the counting
 * sheet's tabs and "32 of 48", what a delivery line receives, how long an
 * undo lasts. Pure, so each is tested without a page.
 */

export type StationSupplierProduct =
	StationCatalog['suppliers'][number]['products'][number]

export type ItemUnits = Pick<StationItem, 'baseUnit' | 'units' | 'countUnit'>

/** A catalogue item's named unit that may still be picked. */
type NamedUnit = StationItem['units'][number]

// ── Units ───────────────────────────────────────────────────────────────────

/** Base thousandths in one of `unitRef` for an item, or null for a unit the item does not have. */
export function thousandthsIn(
	unitRef: UnitRef,
	baseUnit: InventoryBaseUnit,
	units: readonly Pick<NamedUnit, 'id' | 'baseQuantity'>[] = [],
): number | null {
	const parsed = parseUnitRef(unitRef)
	if (parsed.kind === 'named')
		return units.find((unit) => unit.id === parsed.id)?.baseQuantity ?? null
	const spec = STANDARD_UNIT_SPECS[parsed.unit]
	if (spec.base !== baseUnit) return null
	return spec.factor * QUANTITY_SCALE
}

/**
 * The units a row can be switched to: the one it is counted in first, then the
 * item's named units, then the standard units that measure its base unit.
 */
export function unitChoices(item: ItemUnits): UnitRef[] {
	const choices: UnitRef[] = [item.countUnit]
	for (const unit of item.units) {
		if (unit.archived) continue
		const ref: UnitRef = `unit:${unit.id}`
		if (!choices.includes(ref)) choices.push(ref)
	}
	for (const unit of standardUnitsFor(item.baseUnit)) {
		if (!choices.includes(unit)) choices.push(unit)
	}
	return choices.filter(
		(ref) => thousandthsIn(ref, item.baseUnit, item.units) !== null,
	)
}

/** How much − and + change an amount: tens of grams and millilitres, otherwise whole units. */
export function unitStep(unitRef: UnitRef): number {
	const parsed = parseUnitRef(unitRef)
	if (
		parsed.kind === 'standard' &&
		(parsed.unit === 'g' || parsed.unit === 'ml')
	)
		return 100
	return 1
}

/** ¼ ½ ¾ make no sense in grams and millilitres. */
export function unitTakesFractions(unitRef: UnitRef): boolean {
	const parsed = parseUnitRef(unitRef)
	return !(
		parsed.kind === 'standard' &&
		(parsed.unit === 'g' || parsed.unit === 'ml')
	)
}

/** The stored quantity (base thousandths) of an amount typed in `unitRef`, or null when the unit does not fit. */
export function toBaseThousandths(
	amount: number,
	unitRef: UnitRef,
	item: ItemUnits,
): number | null {
	const per = thousandthsIn(unitRef, item.baseUnit, item.units)
	if (per === null || !Number.isFinite(amount)) return null
	const value = Math.round(amount * per)
	return value >= 0 && value <= MAX_ENTRY_QUANTITY ? value : null
}

/** The same quantity in another unit, rounded to thousandths; null when either unit does not fit. */
export function convertAmount(
	amount: number,
	from: UnitRef,
	to: UnitRef,
	item: ItemUnits,
): number | null {
	const base = toBaseThousandths(amount, from, item)
	const per = thousandthsIn(to, item.baseUnit, item.units)
	if (base === null || per === null) return null
	return Math.round((base / per) * 1000) / 1000
}

/** Short names for what `Intl` has no unit for. Looked up when drawn, in the person's language. */
export function unitLabel(
	unitRef: UnitRef,
	units: readonly Pick<NamedUnit, 'id' | 'name'>[],
	locale: string,
	/** The amount it follows, so "1 piece" and "2 pieces" read right. */
	amount?: number,
): string {
	const parsed = parseUnitRef(unitRef)
	if (parsed.kind === 'named')
		return units.find((unit) => unit.id === parsed.id)?.name ?? parsed.id
	if (parsed.unit === 'piece')
		return amount === undefined
			? t`pieces`
			: plural(amount, { one: 'piece', other: 'pieces' })
	const intl = STANDARD_UNIT_SPECS[parsed.unit].intl
	if (intl === null) return t`qt`
	try {
		const parts = new Intl.NumberFormat(locale, {
			style: 'unit',
			unit: intl,
			unitDisplay: 'short',
		}).formatToParts(1)
		return parts.find((part) => part.type === 'unit')?.value ?? parsed.unit
	} catch {
		return parsed.unit
	}
}

/** "2.5" the way the person's language writes it, at most three decimals. */
export function formatAmount(amount: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, {
			maximumFractionDigits: 3,
		}).format(amount)
	} catch {
		return String(amount)
	}
}

// ── Counting sheet ──────────────────────────────────────────────────────────

/** Items in no storage area come last, under this tab. */
export const NO_AREA_TAB = 'none'

export const rowKey = (itemId: string, areaId: string | null) =>
	`${itemId}|${areaId ?? ''}`

export type CountTab = {
	key: string
	areaId: string | null
	/** Null for the "Not in an area" tab (the screen words it). */
	name: string | null
	itemIds: string[]
}

/**
 * The areas in walking order, each with its items in shelf order, limited to
 * the items on the count's list (`scope` null means everything). Items the
 * catalogue puts in no area come last. An item in two areas is on both tabs
 * (each place is counted on its own), and an empty tab is left out.
 */
export function countTabs(
	catalog: Pick<StationCatalog, 'items' | 'areas'>,
	scope: ReadonlySet<string> | null,
): CountTab[] {
	const known = new Set(catalog.items.map((item) => item.id))
	const inScope = (id: string) => known.has(id) && (!scope || scope.has(id))
	const placed = new Set<string>()
	const tabs: CountTab[] = [...catalog.areas]
		.sort((a, b) => a.sortOrder - b.sortOrder)
		.map((area) => {
			const itemIds = area.itemIds.filter(inScope)
			for (const id of itemIds) placed.add(id)
			return { key: area.id, areaId: area.id, name: area.name, itemIds }
		})
		.filter((tab) => tab.itemIds.length > 0)
	const loose = catalog.items
		.map((item) => item.id)
		.filter((id) => inScope(id) && !placed.has(id))
	if (loose.length > 0)
		tabs.push({ key: NO_AREA_TAB, areaId: null, name: null, itemIds: loose })
	return tabs
}

/** One amount in one unit. */
export type CountLine = { amount: number | null; unit: UnitRef }

/**
 * What a row shows: its main amount and unit, plus the lines the person added
 * with "Add another unit" ("2 boxes and 3 kg"). Switching the main unit
 * replaces the amount in the old unit; only an added line sums with it.
 */
export type CountValue = CountLine & { more?: CountLine[] }
export type CountValues = Record<string, CountValue>

/** Units a row's lines use, the main one first (units of lines with no amount yet included). */
export const lineUnits = (
	value: CountValue | null,
	fallback: UnitRef,
): UnitRef[] => [
	value?.unit ?? fallback,
	...(value?.more ?? []).map((line) => line.unit),
]

/**
 * "32 of 48": items with a typed amount in some area (or that someone else
 * already counted, which says nothing about how much), of every item on the
 * sheet.
 */
export function countProgress(
	tabs: readonly CountTab[],
	values: CountValues,
	countedElsewhere: ReadonlySet<string> = new Set(),
): { counted: number; total: number } {
	const all = new Set<string>()
	const counted = new Set<string>()
	for (const tab of tabs) {
		for (const id of tab.itemIds) {
			all.add(id)
			const own = values[rowKey(id, tab.areaId)]
			if (own) {
				if (own.amount !== null) counted.add(id)
			} else if (countedElsewhere.has(id)) counted.add(id)
		}
	}
	return { counted: counted.size, total: all.size }
}

/** How many of a tab's items have an amount (the number on the tab). */
export function tabProgress(
	tab: CountTab,
	values: CountValues,
	countedElsewhere: ReadonlySet<string> = new Set(),
): { counted: number; total: number } {
	let counted = 0
	for (const id of tab.itemIds) {
		const own = values[rowKey(id, tab.areaId)]
		if (own ? own.amount !== null : countedElsewhere.has(id)) counted++
	}
	return { counted, total: tab.itemIds.length }
}

// ── Waste ───────────────────────────────────────────────────────────────────

/** Items to offer first: this terminal's recent ones (the region's, then what was just logged here). */
export function recentWasteIds(
	catalog: Pick<StationCatalog, 'items' | 'recentWasteItemIds'>,
	local: readonly string[],
	limit = 8,
): string[] {
	const known = new Set(catalog.items.map((item) => item.id))
	const seen = new Set<string>()
	const out: string[] = []
	for (const id of [...local, ...catalog.recentWasteItemIds]) {
		if (!known.has(id) || seen.has(id)) continue
		seen.add(id)
		out.push(id)
		if (out.length >= limit) break
	}
	return out
}

/** Items matching what was typed, by name, ignoring case and accents. */
export function filterItems<T extends { name: string; category?: string }>(
	items: readonly T[],
	query: string,
): T[] {
	const fold = (text: string) =>
		text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim()
	const needle = fold(query)
	if (!needle) return [...items]
	return items.filter((item) => fold(item.name).includes(needle))
}

/** Milliseconds left to undo something logged at `at`, never below zero. */
export function undoRemainingMs(at: number, now: number): number {
	return Math.max(0, at + STATION_WASTE_UNDO_UI_MS - now)
}

// ── Delivery ────────────────────────────────────────────────────────────────

/** A delivery as the outbox holds it: the contract's request without what the runner adds. */
export const deliveryPayloadSchema = stationDeliverySchema
	.omit({ clientId: true, locationId: true, madeBy: true, madeAt: true })
	.strict()

/** One line of a delivery as the form holds it. */
export type DeliveryLineDraft = {
	key: string
	itemId: string
	itemName: string
	baseUnit: InventoryBaseUnit
	supplierProductId: string | null
	packName: string
	packBaseQuantity: number
	pricedByWeight: boolean
	orderLineId: string | null
	/** Ordered packs, when the line is on an order (a hint, not sent). */
	orderedPacks: number | null
	/** Packs that came; null while not typed. */
	packs: number | null
	/** Whether this line came at all (an order's lines start ticked). */
	received: boolean
	/**
	 * A line with no supplier product (a market or cash-and-carry purchase, or
	 * an item this supplier has no product for): the quantity is typed in any
	 * unit the item has, with no packs and no price.
	 */
	plain?: {
		amount: number | null
		unit: UnitRef
		units: StationItem['units']
		countUnit: UnitRef
	}
	/** The weight on the scale, in `weightUnit`, for a line priced by weight. */
	weight: number | null
	weightUnit: UnitRef
}

/** Standard unit a weight is typed in by default: kilograms and litres, pieces as they are. */
export function defaultWeightUnit(baseUnit: InventoryBaseUnit): UnitRef {
	return baseUnit === 'g' ? 'kg' : baseUnit === 'ml' ? 'l' : 'piece'
}

export function linesFromExpected(
	delivery: StationExpectedDelivery,
): DeliveryLineDraft[] {
	return delivery.lines.map((line) => ({
		key: line.orderLineId,
		itemId: line.itemId,
		itemName: line.itemName,
		baseUnit: line.baseUnit,
		supplierProductId: line.supplierProductId,
		packName: line.packName,
		packBaseQuantity: line.packBaseQuantity,
		pricedByWeight: line.pricedByWeight,
		orderLineId: line.orderLineId,
		orderedPacks: line.orderedPacks,
		packs: line.outstandingPacks > 0 ? line.outstandingPacks : null,
		received: line.outstandingPacks > 0,
		weight: null,
		weightUnit: defaultWeightUnit(line.baseUnit),
	}))
}

export function lineFromProduct(
	product: StationSupplierProduct,
	item: Pick<StationItem, 'name' | 'baseUnit'>,
): DeliveryLineDraft {
	return {
		key: `product:${product.id}`,
		itemId: product.itemId,
		itemName: item.name,
		baseUnit: item.baseUnit,
		supplierProductId: product.id,
		packName: product.packName,
		packBaseQuantity: product.packBaseQuantity,
		pricedByWeight: product.pricedByWeight,
		orderLineId: null,
		orderedPacks: null,
		packs: 1,
		received: true,
		weight: null,
		weightUnit: defaultWeightUnit(item.baseUnit),
	}
}

/** An item received with no supplier product: only a quantity, in a unit the item has. */
export function lineFromItem(item: StationItem): DeliveryLineDraft {
	return {
		key: `item:${item.id}`,
		itemId: item.id,
		itemName: item.name,
		baseUnit: item.baseUnit,
		supplierProductId: null,
		packName: '',
		packBaseQuantity: 0,
		pricedByWeight: false,
		orderLineId: null,
		orderedPacks: null,
		packs: null,
		received: true,
		weight: null,
		weightUnit: defaultWeightUnit(item.baseUnit),
		plain: {
			amount: null,
			unit: item.countUnit,
			units: item.units,
			countUnit: item.countUnit,
		},
	}
}

/**
 * What a line puts into stock, in base thousandths: the amount typed in its
 * own unit for a line with no supplier product, the weight typed from the
 * scale for a line priced by weight, otherwise packs times the pack size.
 * Null when the line did not come (or nothing usable was typed).
 */
export function lineQuantity(line: DeliveryLineDraft): {
	quantity: number
	realWeightQuantity: number | null
} | null {
	if (!line.received) return null
	if (line.plain) {
		const { amount, unit, units, countUnit } = line.plain
		if (amount === null || !(amount > 0)) return null
		const quantity = toBaseThousandths(amount, unit, {
			baseUnit: line.baseUnit,
			units,
			countUnit,
		})
		return quantity !== null && quantity >= 1
			? { quantity, realWeightQuantity: null }
			: null
	}
	if (line.pricedByWeight && line.weight !== null && line.weight > 0) {
		const per = thousandthsIn(line.weightUnit, line.baseUnit)
		if (per === null) return null
		const weight = Math.round(line.weight * per)
		if (weight < 1 || weight > MAX_ENTRY_QUANTITY) return null
		return { quantity: weight, realWeightQuantity: weight }
	}
	if (line.packs === null || !(line.packs > 0)) return null
	const quantity = Math.round(line.packs * line.packBaseQuantity)
	if (quantity < 1 || quantity > MAX_ENTRY_QUANTITY) return null
	return { quantity, realWeightQuantity: null }
}

/** Lines that came, as the contract's delivery lines (empty ones are left out). */
export function deliveryLines(lines: readonly DeliveryLineDraft[]) {
	const out: Array<{
		itemId: string
		supplierProductId: string | null
		quantity: number
		packs: number | null
		packName: string | null
		packBaseQuantity: number | null
		realWeightQuantity: number | null
		orderLineId: string | null
	}> = []
	for (const line of lines) {
		const amount = lineQuantity(line)
		if (!amount) continue
		out.push({
			itemId: line.itemId,
			supplierProductId: line.supplierProductId,
			quantity: amount.quantity,
			packs: line.plain ? null : line.packs,
			packName: line.plain ? null : line.packName || null,
			packBaseQuantity: line.plain ? null : line.packBaseQuantity,
			realWeightQuantity: amount.realWeightQuantity,
			orderLineId: line.orderLineId,
		})
	}
	return out
}

/** Whether `lines` leave any ordered line short or out (the "nothing more is coming" question). */
export function hasShortLines(lines: readonly DeliveryLineDraft[]): boolean {
	return lines.some((line) => {
		if (line.orderLineId === null || line.orderedPacks === null) return false
		if (!line.received) return true
		return (line.packs ?? 0) < line.orderedPacks
	})
}

/**
 * Whether this person may receive: any signed-in person, unless the location
 * wants a till manager (`receiveRequiresManager`).
 */
export function mayReceive(
	catalog: Pick<StationCatalog, 'settings'>,
	role: 'cashier' | 'manager' | null,
): boolean {
	return !catalog.settings.receiveRequiresManager || role === 'manager'
}
