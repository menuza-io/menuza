import { type CountSheet, type UnitRef } from '@repo/inventory'
import { type CountSyncSnapshot, type QueuedEntry } from './count-queue.ts'
import { thousandthsInUnit } from './format.ts'

/**
 * The counting sheet as the screen uses it: rows per area, what each row
 * currently holds (typed amounts by unit), and "32 of 48". Pure, so the
 * rules about blank fields and several counters are tested without a page.
 */

type SheetArea = CountSheet['areas'][number]
type SheetItem = SheetArea['items'][number]

/** Items that are in no storage area come last, under this tab. */
export const NO_AREA_TAB = 'none'

export function areaTabKey(areaId: string | null): string {
	return areaId ?? NO_AREA_TAB
}

export function rowKey(itemId: string, areaId: string | null): string {
	return `${itemId}|${areaId ?? ''}`
}

/** Typed amounts by unit: "2 Box and 3 kg" is `{ 'unit:box': 2, kg: 3 }`. */
export type RowAmounts = Partial<Record<string, number | null>>

export type CountRow = {
	key: string
	itemId: string
	areaId: string | null
	name: string
	baseUnit: SheetItem['baseUnit']
	countUnit: UnitRef
	units: SheetItem['units']
	/** What everyone counted here, in base thousandths; `null` when nobody has. */
	quantity: number | null
	/** What this person last typed here (one unit), from the region. */
	mine: SheetItem['mine']
}

export type CountTab = {
	key: string
	areaId: string | null
	name: string | null
	rows: CountRow[]
}

/** The areas in walking order, each with its rows in shelf order. Empty areas are left out. */
export function sheetTabs(sheet: CountSheet): CountTab[] {
	return sheet.areas
		.map((area) => ({
			key: areaTabKey(area.areaId),
			areaId: area.areaId,
			name: area.name,
			rows: area.items.map((item) => ({
				key: rowKey(item.itemId, area.areaId),
				itemId: item.itemId,
				areaId: area.areaId,
				name: item.name,
				baseUnit: item.baseUnit,
				countUnit: item.countUnit,
				units: item.units,
				quantity: item.quantity,
				mine: item.mine,
			})),
		}))
		.filter((tab) => tab.rows.length > 0)
}

/**
 * What a row holds when the screen opens: what this person last typed (the
 * region keeps one unit per row), then anything still waiting in the
 * offline queue, which is newer. Fields never start with a default.
 */
export function initialRowAmounts(
	row: Pick<CountRow, 'itemId' | 'areaId' | 'mine'>,
	queued: readonly QueuedEntry[],
): RowAmounts {
	const amounts: RowAmounts = {}
	if (row.mine) amounts[row.mine.unit] = row.mine.amount
	for (const entry of queued) {
		if (entry.itemId === row.itemId && entry.areaId === row.areaId) {
			amounts[entry.unit] = entry.amount
		}
	}
	return amounts
}

/** The amounts of every row, keyed by `rowKey`. */
export type SheetAmounts = Record<string, RowAmounts>

export function initialSheetAmounts(
	tabs: readonly CountTab[],
	queued: readonly QueuedEntry[],
): SheetAmounts {
	const amounts: SheetAmounts = {}
	for (const tab of tabs) {
		for (const row of tab.rows) {
			const initial = initialRowAmounts(row, queued)
			if (Object.keys(initial).length > 0) amounts[row.key] = initial
		}
	}
	return amounts
}

function typedAmountCount(amounts: RowAmounts | undefined): number {
	return Object.values(amounts ?? {}).filter(
		(value): value is number => typeof value === 'number',
	).length
}

/**
 * A row is counted when this person has typed an amount in it, or when
 * somebody else counted it and this person has typed nothing there.
 */
export function isRowCounted(
	row: Pick<CountRow, 'key' | 'quantity'>,
	amounts: SheetAmounts,
): boolean {
	const own = amounts[row.key]
	if (own !== undefined && Object.keys(own).length > 0) {
		return typedAmountCount(own) > 0
	}
	return row.quantity !== null
}

/** "32 of 48": distinct items with at least one counted row, of every item on the sheet. */
export function countProgress(
	tabs: readonly CountTab[],
	amounts: SheetAmounts,
): { counted: number; total: number } {
	const all = new Set<string>()
	const counted = new Set<string>()
	for (const tab of tabs) {
		for (const row of tab.rows) {
			all.add(row.itemId)
			if (isRowCounted(row, amounts)) counted.add(row.itemId)
		}
	}
	return { counted: counted.size, total: all.size }
}

/** Counted rows of one area, for its tab badge ("5/12"). */
export function tabProgress(
	tab: CountTab,
	amounts: SheetAmounts,
): { counted: number; total: number } {
	return {
		counted: tab.rows.filter((row) => isRowCounted(row, amounts)).length,
		total: tab.rows.length,
	}
}

/**
 * Whatever others added on top of this person's own entry in a row, in base
 * thousandths, or `null` when this person has no entry or nobody else added
 * anything. It lets a row say "4 kg counted in total" without showing the
 * total as a default.
 */
export function othersQuantity(row: CountRow): number | null {
	if (row.quantity === null || row.mine === null) return null
	const perUnit = thousandthsInUnit(row.mine.unit, row.baseUnit, row.units)
	if (perUnit === null) return null
	const own = Math.round(row.mine.amount * perUnit)
	const rest = row.quantity - own
	return rest === 0 ? null : rest
}

/**
 * The units a row can be entered in, count unit first: the item's standard
 * units for its base, then its own packs. A row with one choice shows no
 * switch.
 */
export function rowUnitChoices(
	row: Pick<CountRow, 'countUnit'>,
	allChoices: readonly UnitRef[],
): UnitRef[] {
	return [
		row.countUnit,
		...allChoices.filter((choice) => choice !== row.countUnit),
	]
}

export type RowSaveState =
	/** Nothing typed here. */
	| 'idle'
	/** Typed, not handed to the queue yet (a moment, until blur or the pause). */
	| 'unsaved'
	/** In a request right now. */
	| 'saving'
	/** Queued and waiting for a connection. */
	| 'waiting'
	/** The last attempt did not reach the region: "Retry". */
	| 'failed'
	/** The region has it. */
	| 'saved'

/**
 * What a row shows beside its field. A row never looks saved while an entry
 * of it is still queued or has failed.
 */
export function rowSaveState(input: {
	row: Pick<CountRow, 'key' | 'itemId' | 'areaId' | 'quantity'>
	amounts: SheetAmounts
	snapshot: Pick<CountSyncSnapshot, 'pending' | 'sending' | 'failed'>
	/** Units of this row typed but not yet queued. */
	dirty: boolean
}): RowSaveState {
	const { row, amounts, snapshot } = input
	const entries = snapshot.pending.filter(
		(entry) => entry.itemId === row.itemId && entry.areaId === row.areaId,
	)
	if (entries.some((entry) => snapshot.failed.has(entry.clientId))) {
		return 'failed'
	}
	if (entries.some((entry) => snapshot.sending.has(entry.clientId))) {
		return 'saving'
	}
	if (entries.length > 0) return 'waiting'
	if (input.dirty) return 'unsaved'
	return isRowCounted(row, amounts) ? 'saved' : 'idle'
}
