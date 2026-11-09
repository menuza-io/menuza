import { expandLines } from './expand.ts'
import { type RecipeStore } from './store.ts'
import {
	type ExpandErrorCode,
	type ExpandFlag,
	type SaleLine,
	type UnrecipedLine,
} from './types.ts'

/** Raw quantity of an item that a source has used at a location (base thousandths, never negative). */
export type UsageEntry = {
	itemId: string
	locationId: string
	quantity: number
}

/** Why a till voided a line (the till's reasons; only two of them matter to stock). */
export const POS_VOID_REASONS = [
	'mistake',
	'guest_request',
	'out_of_stock',
	'quality',
	'wrong_charge',
	'other',
] as const
export type PosVoidReason = (typeof POS_VOID_REASONS)[number]

/** A line taken off a Station sale (`lineVoids`): ids and a reason, no money. */
export type PosVoidInput = {
	id: string
	itemId: string
	quantity: number
	reason: PosVoidReason
}

/** Where a web or QR order stands, as the reports' "counted" rule reads it. */
export const ORDER_USAGE_STATES = [
	'counted',
	'awaiting_payment',
	'cancelled',
	'expired',
] as const
export type OrderUsageState = (typeof ORDER_USAGE_STATES)[number]

export type SaleSource =
	| {
			kind: 'restaurant_order'
			/** `counted` (open or completed and payable) uses stock; the others none. */
			state: OrderUsageState
			lines: readonly SaleLine[]
	  }
	| {
			kind: 'pos_order'
			/** `paid` and `refunded` use stock; `open` and `void` use none. */
			status: 'open' | 'paid' | 'refunded' | 'void'
			/** The sale's lines as they stand now (voided lines are already out). */
			lines: readonly SaleLine[]
			lineVoids?: readonly PosVoidInput[]
	  }

export type DesiredUsageError = {
	/** The line that could not be expanded, or null for a voided dish. */
	lineIndex: number | null
	voidId?: string
	code: ExpandErrorCode
	path: string[]
}

export type DesiredUsage = {
	/** What the source uses now, per item (`pos_order`, `restaurant_order`). */
	sale: UsageEntry[]
	/**
	 * Dishes voided for bad quality: made and thrown away. Each is its own
	 * `pos_void` source (`voidId`) with the ingredients it wasted.
	 */
	wasteVoids: {
		voidId: string
		itemId: string
		quantity: number
		usage: UsageEntry[]
	}[]
	/**
	 * Voids for `out_of_stock`: a till said the dish ran out. Not stock used;
	 * a signal for "auto sold out" and the count review.
	 */
	signals: {
		kind: 'out_of_stock'
		voidId: string
		itemId: string
		quantity: number
	}[]
	/** Sold lines with no recipe and no typed cost (feeds "Dishes without a recipe"). */
	unrecipedLines: UnrecipedLine[]
	flags: ExpandFlag[]
	errors: DesiredUsageError[]
}

function entries(
	usage: readonly { itemId: string; quantity: number }[],
	locationId: string,
): UsageEntry[] {
	return usage.map((line) => ({ ...line, locationId }))
}

function usesStock(source: SaleSource): boolean {
	return source.kind === 'restaurant_order'
		? source.state === 'counted'
		: source.status === 'paid' || source.status === 'refunded'
}

/**
 * The usage a sale source should have deducted, from its CURRENT lines and
 * state and the recipes in force at `at` (the sale's time). Pure and
 * deterministic: settle by diffing this against what `inv_sale_usage` holds
 * (`diffUsage`), so replays, revisions, cancellations and edited tabs converge.
 *
 * - Web and QR orders: only `counted` ones use stock. Cancelled, expired and
 *   unpaid ones use none (so a cancel returns the usage to zero).
 * - Station sales: only `paid` and `refunded` ones; a refund does not return
 *   stock (the food was made). `lines` are what is on the bill now, so voided
 *   lines are already out and nothing is subtracted twice.
 * - A void with reason `quality` is the dish wasted: its ingredients (the
 *   dish without size or options, which a void does not record) are posted as
 *   waste under its own source, whatever state the sale is in. `out_of_stock`
 *   is a signal only; other reasons use nothing.
 * - A line with no recipe adds nothing and is listed in `unrecipedLines`. A line whose
 *   recipes loop is left out and reported in `errors`; the sale is never refused.
 */
export function desiredUsage(input: {
	store: RecipeStore
	locationId: string
	/** The sale's time, epoch ms: picks the recipe version in force. */
	at: number
	source: SaleSource
}): DesiredUsage {
	const { store, locationId, at, source } = input
	const out: DesiredUsage = {
		sale: [],
		wasteVoids: [],
		signals: [],
		unrecipedLines: [],
		flags: [],
		errors: [],
	}
	if (usesStock(source)) {
		const expanded = expandLines(store, source.lines, at)
		out.sale = entries(expanded.usage, locationId)
		out.unrecipedLines = expanded.unrecipedLines
		out.flags = expanded.flags
		out.errors = expanded.errors.map((error) => ({ ...error }))
	}
	if (source.kind === 'pos_order') {
		for (const voided of source.lineVoids ?? []) {
			if (voided.reason === 'out_of_stock') {
				out.signals.push({
					kind: 'out_of_stock',
					voidId: voided.id,
					itemId: voided.itemId,
					quantity: voided.quantity,
				})
			}
			if (voided.reason !== 'quality') continue
			const wasted = expandLines(
				store,
				[{ itemId: voided.itemId, quantity: voided.quantity }],
				at,
			)
			for (const error of wasted.errors) {
				out.errors.push({
					lineIndex: null,
					voidId: voided.id,
					code: error.code,
					path: error.path,
				})
			}
			out.wasteVoids.push({
				voidId: voided.id,
				itemId: voided.itemId,
				quantity: voided.quantity,
				usage: entries(wasted.usage, locationId),
			})
		}
	}
	out.wasteVoids.sort((a, b) =>
		a.voidId < b.voidId ? -1 : a.voidId > b.voidId ? 1 : 0,
	)
	out.signals.sort((a, b) =>
		a.voidId < b.voidId ? -1 : a.voidId > b.voidId ? 1 : 0,
	)
	return out
}

/** A change to post: the usage moves by `usageDelta`, the stock movement is its negative. */
export type UsageDelta = {
	itemId: string
	locationId: string
	/** Desired minus applied. Positive: the sale used more. */
	usageDelta: number
	/** Signed stock movement to post: `-usageDelta` (stock out is negative). */
	movementQuantity: number
}

function keyOf(entry: UsageEntry): string {
	return JSON.stringify([entry.locationId, entry.itemId])
}

function sumByKey(list: Iterable<UsageEntry>): Map<string, UsageEntry> {
	const map = new Map<string, UsageEntry>()
	for (const entry of list) {
		if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 0) {
			throw new RangeError('usage must be a non-negative safe integer')
		}
		const key = keyOf(entry)
		const existing = map.get(key)
		if (existing) existing.quantity += entry.quantity
		else map.set(key, { ...entry })
	}
	return map
}

/**
 * What to post so the applied usage becomes the desired usage: one delta per
 * (location, item) that differs, zeros left out, sorted by location then item.
 * Entries with the same key are summed first, so how a list is split does not
 * matter. Diffing the desired usage against itself is empty, so a replay posts
 * nothing.
 */
export function diffUsage(
	applied: Iterable<UsageEntry>,
	desired: Iterable<UsageEntry>,
): UsageDelta[] {
	const before = sumByKey(applied)
	const after = sumByKey(desired)
	const deltas: UsageDelta[] = []
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const was = before.get(key)
		const now = after.get(key)
		const reference = (now ?? was)!
		const usageDelta = (now?.quantity ?? 0) - (was?.quantity ?? 0)
		if (usageDelta === 0) continue
		deltas.push({
			itemId: reference.itemId,
			locationId: reference.locationId,
			usageDelta,
			movementQuantity: 0 - usageDelta,
		})
	}
	return deltas.sort((a, b) =>
		a.locationId !== b.locationId
			? a.locationId < b.locationId
				? -1
				: 1
			: a.itemId < b.itemId
				? -1
				: a.itemId > b.itemId
					? 1
					: 0,
	)
}

/** The usage rows after posting `deltas` (zero rows dropped): the new `inv_sale_usage`. */
export function applyUsageDeltas(
	applied: Iterable<UsageEntry>,
	deltas: readonly UsageDelta[],
): UsageEntry[] {
	const map = sumByKey(applied)
	for (const delta of deltas) {
		const key = keyOf(delta as unknown as UsageEntry)
		const existing = map.get(key)
		const quantity = (existing?.quantity ?? 0) + delta.usageDelta
		if (quantity < 0) throw new RangeError('usage would go below zero')
		if (quantity === 0) map.delete(key)
		else {
			map.set(key, {
				itemId: delta.itemId,
				locationId: delta.locationId,
				quantity,
			})
		}
	}
	return [...map.values()].sort((a, b) =>
		a.locationId !== b.locationId
			? a.locationId < b.locationId
				? -1
				: 1
			: a.itemId < b.itemId
				? -1
				: a.itemId > b.itemId
					? 1
					: 0,
	)
}
