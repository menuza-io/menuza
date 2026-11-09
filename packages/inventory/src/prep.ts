import { dayOfWeek } from '@repo/reservations'

/**
 * Prep math (phase 4), pure and explainable. A prep list says how much of each
 * made-in-house item to make today:
 *
 *   amount = (fill up to for the weekday x how busy the weekday is) - on hand,
 *            rounded UP to whole batches of the item's recipe.
 *
 * "How busy" is the weekday factor: the average of the same weekday over the
 * last four weeks divided by the average of all the days in that window. In
 * Ramadan (and only then) the window is Ramadan days, because demand follows
 * the evening there; outside it, Ramadan days are left out. Every number is
 * shown to the cook ("Fill up to 6 L · have 2 L · Fridays sell 20% more"), so
 * nothing is a black box. No I/O here.
 */

/** Weekday factor stays between half and double, so one odd week cannot empty or flood a kitchen. */
export const MIN_DEMAND_BP = 5_000
export const MAX_DEMAND_BP = 20_000
export const NEUTRAL_DEMAND_BP = 10_000
/** How far back the pattern looks, and how many same weekdays it needs. */
export const PREP_HISTORY_DAYS = 28
export const MIN_SAME_WEEKDAY_SAMPLES = 2
export const MIN_HISTORY_DAYS = 7

/** The Hijri month (1-12) of a business date, `null` when the platform has no such calendar. */
export function hijriMonth(date: string): number | null {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	if (!year || !month || !day) return null
	try {
		const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
			month: 'numeric',
			timeZone: 'UTC',
		}).formatToParts(new Date(Date.UTC(year, month - 1, day, 12)))
		const value = parts.find((part) => part.type === 'month')?.value
		const parsed = value ? Number(value) : Number.NaN
		return Number.isInteger(parsed) && parsed >= 1 && parsed <= 12
			? parsed
			: null
	} catch {
		return null
	}
}

/** Ramadan is the ninth month of the Hijri calendar. */
export function isRamadan(date: string): boolean {
	return hijriMonth(date) === 9
}

export type DailyUnits = { date: string; units: number }

export type DemandFactor = {
	/** 10000 is "a normal day"; 12000 is 20% busier. */
	bp: number
	/** Whether a pattern was found; false leaves the plan at the fill-up level. */
	known: boolean
	/** The pattern came from Ramadan days only. */
	ramadan: boolean
	/** Same-weekday days the figure rests on. */
	samples: number
}

const SHIFT_DAYS = (date: string, days: number) => {
	const [year, month, day] = date.split('-').map(Number) as [
		number,
		number,
		number,
	]
	return new Date(Date.UTC(year, month - 1, day + days))
		.toISOString()
		.slice(0, 10)
}

/**
 * How busy `date`'s weekday usually is, from the last 28 days of units sold
 * (dishes sold: any consistent count works). Days with no sales are ignored,
 * so a closed day does not read as a quiet one.
 */
export function weekdayDemand(input: {
	date: string
	history: readonly DailyUnits[]
}): DemandFactor {
	const ramadan = isRamadan(input.date)
	const from = SHIFT_DAYS(input.date, -PREP_HISTORY_DAYS)
	const days = input.history.filter(
		(day) =>
			day.date >= from &&
			day.date < input.date &&
			day.units > 0 &&
			isRamadan(day.date) === ramadan,
	)
	const weekday = dayOfWeek(input.date)
	const same = days.filter((day) => dayOfWeek(day.date) === weekday)
	if (
		days.length < MIN_HISTORY_DAYS ||
		same.length < MIN_SAME_WEEKDAY_SAMPLES
	) {
		return {
			bp: NEUTRAL_DEMAND_BP,
			known: false,
			ramadan,
			samples: same.length,
		}
	}
	const mean = (list: readonly DailyUnits[]) =>
		list.reduce((sum, day) => sum + day.units, 0) / list.length
	const all = mean(days)
	if (all <= 0) {
		return {
			bp: NEUTRAL_DEMAND_BP,
			known: false,
			ramadan,
			samples: same.length,
		}
	}
	const bp = Math.round((mean(same) / all) * NEUTRAL_DEMAND_BP)
	return {
		bp: Math.min(MAX_DEMAND_BP, Math.max(MIN_DEMAND_BP, bp)),
		known: true,
		ramadan,
		samples: same.length,
	}
}

export type PrepSuggestion = {
	/** What to make, base thousandths (0 when there is enough). */
	amount: number
	/** Whole batches of the recipe, when it has a batch size. */
	batches: number | null
	/** Fill up to as the plan used it, after the weekday factor. */
	target: number
}

/**
 * The amount to make. Negative stock counts as none (a drifting estimate must
 * not inflate the plan). Rounds up to whole batches when the made item's
 * recipe says how much one batch makes.
 */
export function suggestPrepAmount(input: {
	fillUpTo: number
	onHand: number
	demandBp: number
	/** Base thousandths one batch makes (`makesQuantity`), when known. */
	batchSize: number | null
}): PrepSuggestion {
	const target = Math.round(
		(input.fillUpTo * input.demandBp) / NEUTRAL_DEMAND_BP,
	)
	const need = Math.max(0, target - Math.max(0, input.onHand))
	if (need === 0)
		return { amount: 0, batches: input.batchSize ? 0 : null, target }
	if (input.batchSize && input.batchSize > 0) {
		const batches = Math.ceil(need / input.batchSize)
		return { amount: batches * input.batchSize, batches, target }
	}
	return { amount: need, batches: null, target }
}
