/**
 * Use-by dates on stock (#479). Pure: no I/O.
 *
 * The stock ledger (`inv_movements`) stays the one record of how much of an
 * item is on hand. A lot is only a note that some quantity arrived with a
 * use-by date. Stock is used oldest date first, so what is left of the dated
 * stock is never stored: it is the NEWEST lots, up to the ledger's figure.
 * Everything that lowers on hand (a sale, waste, a count correction, a transfer
 * out) therefore takes from the oldest date without any of those writers
 * knowing about lots. Stock the ledger holds beyond the lots (stock from before
 * the item was tracked, a transfer in) is `undated` and is treated as the
 * oldest.
 *
 * Waste of expired stock, and a cancelled delivery, name their lot: that is a
 * `take`, which lowers the named lot instead of the oldest one.
 */

export type StockLot = {
	id: string
	/** `YYYY-MM-DD`, the last day to use it. */
	useByDate: string
	/** Base thousandths that arrived with this date. */
	quantity: number
	/** A confirmed count of dates: lots recorded before it no longer count. */
	baseline: boolean
	createdAt: number
}

export type LotTake = { lotId: string; quantity: number }

export type LotRemaining = StockLot & {
	/** What is left of the lot, base thousandths (above zero). */
	remaining: number
	/** Whole days from today to the use-by date (negative: past it). */
	daysLeft: number
	status: UseByStatus
}

export type LotStock = {
	/** Dated stock still on hand, oldest use-by date first. */
	lots: LotRemaining[]
	/** On hand the lots do not explain (treated as the oldest stock). */
	undated: number
	/** The ledger's on-hand figure (never below zero). */
	onHand: number
}

/** How many days before the date stock shows under "Use first". */
export const USE_FIRST_DAYS = 2

export type UseByStatus = 'expired' | 'today' | 'soon' | 'ok'

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function dayNumber(date: string): number {
	const match = DATE.exec(date)
	if (!match) throw new RangeError('Invalid date')
	return Math.round(
		Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) /
			86_400_000,
	)
}

/** Whole days from `today` to `useByDate` (both `YYYY-MM-DD`). */
export function daysUntilUseBy(useByDate: string, today: string): number {
	return dayNumber(useByDate) - dayNumber(today)
}

/** Expired once the business date is past the use-by date. */
export function useByStatus(
	useByDate: string,
	today: string,
	soonDays: number = USE_FIRST_DAYS,
): UseByStatus {
	const days = daysUntilUseBy(useByDate, today)
	if (days < 0) return 'expired'
	if (days === 0) return 'today'
	return days <= soonDays ? 'soon' : 'ok'
}

/** The calendar date (`YYYY-MM-DD`) of an instant in a time zone. */
export function localDateIn(at: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(new Date(at))
	const get = (type: string) => parts.find((part) => part.type === type)!.value
	return `${get('year')}-${get('month')}-${get('day')}`
}

/**
 * The use-by date of something received or made at `at`: the location's
 * calendar date of `at` plus the shelf life.
 */
export function useByFromShelfLife(input: {
	at: number
	shelfLifeHours: number
	timeZone: string
}): string {
	return localDateIn(
		input.at + input.shelfLifeHours * 3_600_000,
		input.timeZone,
	)
}

/** The instant something made at `at` must be used by (a label shows the time). */
export function useByInstant(at: number, shelfLifeHours: number): number {
	return at + shelfLifeHours * 3_600_000
}

/** The lots that count: the latest confirmed set, and everything recorded after it. */
function countingLots(lots: readonly StockLot[]): StockLot[] {
	let baselineAt = -1
	for (const lot of lots) {
		if (lot.baseline && lot.createdAt > baselineAt) baselineAt = lot.createdAt
	}
	if (baselineAt < 0) return [...lots]
	return lots.filter((lot) =>
		lot.baseline ? lot.createdAt === baselineAt : lot.createdAt > baselineAt,
	)
}

/**
 * What is left of each lot for one item at one location. `onHand` is the
 * ledger's sum; `takes` are the stock taken from named lots.
 */
export function remainingLots(input: {
	onHand: number
	lots: readonly StockLot[]
	takes: readonly LotTake[]
	today: string
	soonDays?: number
}): LotStock {
	const onHand = Math.max(0, input.onHand)
	const taken = new Map<string, number>()
	for (const take of input.takes) {
		taken.set(take.lotId, (taken.get(take.lotId) ?? 0) + take.quantity)
	}
	const effective = countingLots(input.lots)
		.map((lot) => ({
			lot,
			own: Math.max(0, lot.quantity - (taken.get(lot.id) ?? 0)),
		}))
		.sort(
			(a, b) =>
				(a.lot.useByDate < b.lot.useByDate
					? -1
					: a.lot.useByDate > b.lot.useByDate
						? 1
						: 0) ||
				a.lot.createdAt - b.lot.createdAt ||
				(a.lot.id < b.lot.id ? -1 : 1),
		)
	const datedTotal = effective.reduce((sum, row) => sum + row.own, 0)
	const undated = Math.max(0, onHand - datedTotal)
	// Used oldest first: whatever the ledger no longer holds came off the front.
	let toRemove = Math.max(0, datedTotal - onHand)
	const lots: LotRemaining[] = []
	for (const row of effective) {
		const used = Math.min(row.own, toRemove)
		toRemove -= used
		const remaining = row.own - used
		if (remaining <= 0) continue
		lots.push({
			...row.lot,
			remaining,
			daysLeft: daysUntilUseBy(row.lot.useByDate, input.today),
			status: useByStatus(row.lot.useByDate, input.today, input.soonDays),
		})
	}
	return { lots, undated, onHand }
}

/** What a person confirming the dates on the shelf wants recorded. */
export type ConfirmedLotInput = { useByDate: string; quantity: number }

/**
 * Checks a confirmation against the ledger: dated quantities must be above
 * zero and together no more than on hand (the rest is undated).
 */
export function validateConfirmedLots(
	lots: readonly ConfirmedLotInput[],
	onHand: number,
): 'ok' | 'empty' | 'duplicate_date' | 'too_much' | 'quantity' {
	if (lots.length === 0) return 'empty'
	const dates = new Set<string>()
	let total = 0
	for (const lot of lots) {
		if (!Number.isInteger(lot.quantity) || lot.quantity <= 0) return 'quantity'
		if (dates.has(lot.useByDate)) return 'duplicate_date'
		dates.add(lot.useByDate)
		total += lot.quantity
	}
	return total > Math.max(0, onHand) ? 'too_much' : 'ok'
}
