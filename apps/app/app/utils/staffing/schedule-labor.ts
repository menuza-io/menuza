import { ratioBp, targetStatusOf, type TargetStatus } from '@repo/staffing'
import { type ScheduleWeek } from './schedule-types.ts'

/**
 * The labor share the schedule footer shows: a day's estimated wages against
 * the sales the week is expected to bring, per currency. The expected sales are
 * a guide (the median of the same weekday over recent weeks) from the
 * scope's sales source, and the share only carries a within/over status when
 * the source covers all sales: with online orders alone the schedule shows the
 * share and says what it leaves out, but never judges it.
 */

export type DayShare = {
	currency: string
	/** Null without expected sales for that weekday. */
	laborBp: number | null
	targetStatus: TargetStatus | null
}

export function dayShares(week: ScheduleWeek, date: string): DayShare[] {
	const target = week.laborTarget
	if (!target) return []
	const cost =
		week.footers.find((footer) => footer.date === date)?.costMinorByCurrency ??
		{}
	const sales =
		target.days.find((day) => day.date === date)?.guideSalesMinorByCurrency ??
		{}
	const currencies = [
		...new Set([...Object.keys(cost), ...Object.keys(sales)]),
	].sort()
	return currencies
		.filter((currency) => (cost[currency] ?? 0) > 0)
		.map((currency) => {
			const laborBp = ratioBp(cost[currency] ?? 0, sales[currency] ?? 0)
			return {
				currency,
				laborBp,
				targetStatus: target.targetColoring
					? targetStatusOf({
							source: target.salesSource,
							targetBp: target.targetBp,
							laborBp,
						})
					: null,
			}
		})
}

/** Whether any day has a share worth a row in the footer. */
export function hasShareRow(week: ScheduleWeek): boolean {
	return week.dates.some((date) => dayShares(week, date).length > 0)
}
