import {
	type InventoryBaseUnit,
	type StockItem,
	type UnitRef,
	type WasteReason,
	toBaseQuantity,
	parseUnitRef,
	type QuantityUnit,
} from '@repo/inventory'
import { parseQuantityText } from '@repo/ui/quantity-input'
import { estimateValueMinor, type ItemUnitLike } from './format.ts'

/** The entry `POST /waste` takes for one logged item. */
export type WasteEntryInput = {
	clientId: string
	locationId: string
	itemId: string
	amount: number
	unit: UnitRef
	reason: WasteReason
	note?: string
}

export type WasteDraft = {
	item: Pick<StockItem, 'id' | 'baseUnit' | 'units'> | null
	amountText: string
	unit: UnitRef | null
	reason: WasteReason | null
	note: string
}

export type WasteDraftProblem = 'item' | 'amount' | 'unit' | 'reason'

/** What is still missing before a waste entry can be saved. */
export function wasteDraftProblems(draft: WasteDraft): WasteDraftProblem[] {
	const problems: WasteDraftProblem[] = []
	if (!draft.item) problems.push('item')
	const amount = parseQuantityText(draft.amountText)
	if (amount === null || amount <= 0) problems.push('amount')
	if (!draft.unit) problems.push('unit')
	if (!draft.reason) problems.push('reason')
	return problems
}

/** The wire entry for a complete draft, or null while a field is missing. */
export function buildWasteEntry(
	draft: WasteDraft,
	{ clientId, locationId }: { clientId: string; locationId: string },
): WasteEntryInput | null {
	if (wasteDraftProblems(draft).length > 0) return null
	const amount = parseQuantityText(draft.amountText)!
	const note = draft.note.trim()
	return {
		clientId,
		locationId,
		itemId: draft.item!.id,
		amount,
		unit: draft.unit!,
		reason: draft.reason!,
		...(note ? { note } : {}),
	}
}

/** The amount in stored base thousandths, or null for a unit the item cannot be measured in. */
export function wasteBaseQuantity(
	amount: number,
	unit: UnitRef,
	baseUnit: InventoryBaseUnit,
	units: readonly ItemUnitLike[],
): number | null {
	const parsed = parseUnitRef(unit)
	let quantityUnit: QuantityUnit
	if (parsed.kind === 'named') {
		const named = units.find((candidate) => candidate.id === parsed.id)
		if (!named) return null
		quantityUnit = { kind: 'named', baseQuantity: named.baseQuantity }
	} else {
		quantityUnit = { kind: 'standard', unit: parsed.unit }
	}
	try {
		return toBaseQuantity(amount, quantityUnit, baseUnit)
	} catch {
		return null
	}
}

/**
 * "Cost SAR 64.40" for the dialog: only when the member may see cost
 * (`costMicro` is present) and the item has a known cost.
 */
export function wasteCostPreviewMinor(
	draft: WasteDraft,
	costMicro: number | null | undefined,
): number | null {
	if (!draft.item || !draft.unit) return null
	const amount = parseQuantityText(draft.amountText)
	if (amount === null || amount <= 0) return null
	const quantity = wasteBaseQuantity(
		amount,
		draft.unit,
		draft.item.baseUnit,
		draft.item.units,
	)
	return quantity === null ? null : estimateValueMinor(quantity, costMicro)
}

// ── Recent items (per viewer, never shared) ────────────────────────────────

export const RECENT_WASTE_LIMIT = 6

export type RecentWasteItem = { id: string; name: string }

function recentKey(orgSlug: string, locationId: string) {
	return `inventory-waste-recent:${orgSlug}:${locationId}`
}

/** A blocked or full storage just means no chips; waste still logs. */
export function readRecentWaste(
	orgSlug: string,
	locationId: string,
	storage: Pick<Storage, 'getItem'> | null = browserStorage(),
): RecentWasteItem[] {
	if (!storage) return []
	try {
		const raw = storage.getItem(recentKey(orgSlug, locationId))
		const parsed: unknown = raw ? JSON.parse(raw) : []
		if (!Array.isArray(parsed)) return []
		return parsed
			.filter(
				(entry): entry is RecentWasteItem =>
					typeof entry === 'object' &&
					entry !== null &&
					typeof (entry as RecentWasteItem).id === 'string' &&
					typeof (entry as RecentWasteItem).name === 'string',
			)
			.slice(0, RECENT_WASTE_LIMIT)
	} catch {
		return []
	}
}

export function rememberRecentWaste(
	orgSlug: string,
	locationId: string,
	item: RecentWasteItem,
	storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage(),
): RecentWasteItem[] {
	const next = [
		{ id: item.id, name: item.name },
		...readRecentWaste(orgSlug, locationId, storage).filter(
			(entry) => entry.id !== item.id,
		),
	].slice(0, RECENT_WASTE_LIMIT)
	if (storage) {
		try {
			storage.setItem(recentKey(orgSlug, locationId), JSON.stringify(next))
		} catch {
			// Storage unavailable: the chips just do not persist.
		}
	}
	return next
}

function browserStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage
	} catch {
		return null
	}
}

/** A fresh idempotency key for one save (kept across retries of that save). */
export function newClientId(prefix = 'w'): string {
	const random =
		typeof crypto !== 'undefined' && 'randomUUID' in crypto
			? crypto.randomUUID()
			: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
	return `${prefix}-${random}`
}
