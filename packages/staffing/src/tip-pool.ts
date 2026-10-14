import { type CsvCell } from './csv.ts'
import {
	type TipCadence,
	type TipPoolCurrency,
	type TipPoolGroup,
	type TipPoolPerson,
	type TipPoolSettingsView,
	type TipSplitBasis,
} from './labor-api.ts'

/**
 * Tip-pool arithmetic. A report to help a manager divide tips, not a payout:
 * nothing here moves money. Whether online-order tips may be pooled at all
 * differs by market, so the inputs say which fulfillment types count and the
 * deduction for card fees is a plain percentage the manager sets.
 *
 * Money is integer minor units and every split uses the largest-remainder
 * method, so shares always add up to the pool to the last cent and the same
 * inputs always give the same shares (ties break by id).
 */

export type TipAmount = { date: string; minor: number }

export type TipWorkFact = {
	date: string
	staffId: string
	positionId: string | null
	/** Paid minutes of a tip-eligible card. */
	minutes: number
}

export type TipPoolInput = {
	currency: string
	settings: Pick<
		TipPoolSettingsView,
		'splitBasis' | 'cadence' | 'cardFeeBp' | 'positionPercentBp'
	>
	/** Tips on online orders of the included fulfillment types. */
	onlineTips: readonly TipAmount[]
	/** Cash tips people declared on their time cards. */
	cashTips: readonly TipAmount[]
	work: readonly TipWorkFact[]
}

export type TipPoolOutcome = Omit<TipPoolCurrency, 'people'> & {
	people: Array<Pick<TipPoolPerson, 'staffId' | 'minutes' | 'shareMinor'>>
}

/** The whole-period key used when the split is not daily. */
export const TIP_PERIOD_KEY = 'period'

export function tipGroupKey(date: string, cadence: TipCadence): string {
	return cadence === 'daily' ? date : TIP_PERIOD_KEY
}

/** Card fees withheld from online tips: a percentage in basis points, rounded to the cent. */
export function cardFeeMinor(
	onlineTipsMinor: number,
	cardFeeBp: number,
): number {
	return Math.round((onlineTipsMinor * cardFeeBp) / 10_000)
}

/**
 * Splits `total` over `weights` in whole minor units. The floor of each exact
 * share is paid first and the leftover units go to the largest remainders, ties
 * to the smaller key. Zero or negative weights get nothing; with no positive
 * weight nothing is allocated.
 */
export function allocateByWeight(
	total: number,
	weights: ReadonlyArray<{ key: string; weight: number }>,
): Map<string, number> {
	const result = new Map<string, number>()
	const positive = weights.filter((w) => w.weight > 0)
	for (const w of weights) result.set(w.key, 0)
	const sum = positive.reduce((s, w) => s + w.weight, 0)
	if (total <= 0 || sum <= 0) return result
	const parts = positive.map((w) => {
		const exact = (total * w.weight) / sum
		const floor = Math.floor(exact)
		return { key: w.key, floor, remainder: exact - floor }
	})
	let left = total - parts.reduce((s, p) => s + p.floor, 0)
	for (const part of parts) result.set(part.key, part.floor)
	parts.sort((a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key))
	for (let i = 0; left > 0 && parts.length > 0; i = (i + 1) % parts.length) {
		const part = parts[i]!
		result.set(part.key, (result.get(part.key) ?? 0) + 1)
		left -= 1
	}
	return result
}

function sumBy(items: readonly TipAmount[], key: (date: string) => string) {
	const map = new Map<string, number>()
	for (const item of items) {
		map.set(key(item.date), (map.get(key(item.date)) ?? 0) + item.minor)
	}
	return map
}

/**
 * One currency's pool and split. With a daily cadence each day is pooled and
 * split among that day's people on its own; otherwise the whole range is one
 * pool. Under `hours` each eligible person takes a share in proportion to paid
 * minutes. Under `position_percent` each position that worked takes its set
 * percentage (re-scaled over the positions that actually worked, so an absent
 * position's share is not lost) and splits it by minutes among its people.
 */
export function computeTipPool(input: TipPoolInput): TipPoolOutcome {
	const { settings } = input
	const keyOf = (date: string) => tipGroupKey(date, settings.cadence)
	const online = sumBy(input.onlineTips, keyOf)
	const cash = sumBy(input.cashTips, keyOf)

	const work = new Map<string, TipWorkFact[]>()
	for (const fact of input.work) {
		if (fact.minutes <= 0) continue
		const list = work.get(keyOf(fact.date)) ?? []
		list.push(fact)
		work.set(keyOf(fact.date), list)
	}

	const keys = [
		...new Set([...online.keys(), ...cash.keys(), ...work.keys()]),
	].sort()
	const groups: TipPoolGroup[] = []
	const people = new Map<string, { minutes: number; shareMinor: number }>()
	const totals = {
		onlineTipsMinor: 0,
		cardFeeMinor: 0,
		cashTipsMinor: 0,
		poolMinor: 0,
		unallocatedMinor: 0,
	}

	for (const key of keys) {
		const onlineMinor = online.get(key) ?? 0
		const fee = cardFeeMinor(onlineMinor, settings.cardFeeBp)
		const cashMinor = cash.get(key) ?? 0
		const pool = onlineMinor - fee + cashMinor
		const facts = work.get(key) ?? []

		// Minutes per person (and per person within a position).
		const minutesByStaff = new Map<string, number>()
		const minutesByPosition = new Map<string, Map<string, number>>()
		for (const fact of facts) {
			minutesByStaff.set(
				fact.staffId,
				(minutesByStaff.get(fact.staffId) ?? 0) + fact.minutes,
			)
			const position = fact.positionId ?? ''
			const inPosition = minutesByPosition.get(position) ?? new Map()
			inPosition.set(
				fact.staffId,
				(inPosition.get(fact.staffId) ?? 0) + fact.minutes,
			)
			minutesByPosition.set(position, inPosition)
		}

		const shares = new Map<string, number>()
		if (settings.splitBasis === 'hours') {
			const byStaff = allocateByWeight(
				pool,
				[...minutesByStaff].map(([staffId, minutes]) => ({
					key: staffId,
					weight: minutes,
				})),
			)
			for (const [staffId, share] of byStaff) shares.set(staffId, share)
		} else {
			const positions = allocateByWeight(
				pool,
				[...minutesByPosition.keys()].map((position) => ({
					key: position,
					weight:
						position === '' ? 0 : (settings.positionPercentBp[position] ?? 0),
				})),
			)
			for (const [position, amount] of positions) {
				const inPosition = minutesByPosition.get(position)!
				const split = allocateByWeight(
					amount,
					[...inPosition].map(([staffId, minutes]) => ({
						key: staffId,
						weight: minutes,
					})),
				)
				for (const [staffId, share] of split) {
					shares.set(staffId, (shares.get(staffId) ?? 0) + share)
				}
			}
		}

		const allocated = [...shares.values()].reduce((s, v) => s + v, 0)
		const unallocated = pool - allocated
		for (const [staffId, minutes] of minutesByStaff) {
			const entry = people.get(staffId) ?? { minutes: 0, shareMinor: 0 }
			entry.minutes += minutes
			entry.shareMinor += shares.get(staffId) ?? 0
			people.set(staffId, entry)
		}
		groups.push({
			key,
			onlineTipsMinor: onlineMinor,
			cardFeeMinor: fee,
			cashTipsMinor: cashMinor,
			poolMinor: pool,
			unallocatedMinor: unallocated,
		})
		totals.onlineTipsMinor += onlineMinor
		totals.cardFeeMinor += fee
		totals.cashTipsMinor += cashMinor
		totals.poolMinor += pool
		totals.unallocatedMinor += unallocated
	}

	return {
		currency: input.currency,
		...totals,
		groups,
		people: [...people]
			.map(([staffId, value]) => ({ staffId, ...value }))
			.sort((a, b) => a.staffId.localeCompare(b.staffId)),
	}
}

export const DEFAULT_TIP_SETTINGS: Pick<
	TipPoolSettingsView,
	'splitBasis' | 'cadence' | 'cardFeeBp' | 'fulfillment' | 'positionPercentBp'
> = {
	splitBasis: 'hours' satisfies TipSplitBasis,
	cadence: 'period' satisfies TipCadence,
	cardFeeBp: 0,
	// Delivery tips often belong to the driver; they stay out until chosen.
	fulfillment: ['pickup'],
	positionPercentBp: {},
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type TipCsvPerson = Pick<
	TipPoolPerson,
	'employeeNumber' | 'firstName' | 'lastName' | 'minutes' | 'shareMinor'
>

/**
 * One row per person and currency, then a row per currency for the pool
 * itself so the file shows where the numbers came from. Names pass through the
 * shared CSV builder, which neutralizes spreadsheet formulas.
 */
export function tipPoolTable(
	pools: ReadonlyArray<
		Pick<
			TipPoolCurrency,
			| 'currency'
			| 'onlineTipsMinor'
			| 'cardFeeMinor'
			| 'cashTipsMinor'
			| 'poolMinor'
			| 'unallocatedMinor'
		> & { people: readonly TipCsvPerson[] }
	>,
): { headers: string[]; rows: CsvCell[][] } {
	const headers = [
		'Employee ID',
		'First name',
		'Last name',
		'Eligible hours',
		'Currency',
		'Tip share',
	]
	const rows: CsvCell[][] = []
	for (const pool of pools) {
		for (const person of pool.people) {
			rows.push([
				person.employeeNumber,
				person.firstName,
				person.lastName,
				Math.round((person.minutes / 60) * 100) / 100,
				pool.currency,
				person.shareMinor / 100,
			])
		}
		const line = (label: string, minor: number) =>
			rows.push(['', label, '', '', pool.currency, minor / 100])
		line('Online order tips', pool.onlineTipsMinor)
		line('Card fee deduction', -pool.cardFeeMinor)
		line('Declared cash tips', pool.cashTipsMinor)
		line('Pool', pool.poolMinor)
		line('Not allocated', pool.unallocatedMinor)
	}
	return { headers, rows }
}
