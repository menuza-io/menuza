import { plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type DemandSummary,
	formatHourOfDay,
} from '#app/utils/staffing/schedule-view.ts'

/**
 * A day's typical online orders by hour, as 24 thin bars scaled against the
 * busiest hour of the week. It is a guide drawn from past orders (the median of
 * the same weekday over recent weeks), not a forecast, and online orders are
 * not all of a business's sales. Spoken as a single sentence.
 */
export function DemandBars({ day }: { day: DemandSummary }) {
	const { _, i18n } = useLingui()
	const total = Math.round(day.totalOrders)
	const peak =
		day.peakHour === null ? '' : formatHourOfDay(day.peakHour, i18n.locale)
	const label =
		day.peakHour === null
			? _(t`No online orders on a typical day`)
			: `${plural(total, {
					one: '# online order on a typical day',
					other: '# online orders on a typical day',
				})}. ${_(t`Busiest around ${peak}`)}`
	return (
		<div
			role="img"
			aria-label={label}
			title={label}
			// The bars always run earliest to latest from the left, like a clock face.
			dir="ltr"
			className="flex h-8 items-end gap-px"
		>
			{day.bars.map((bar, hour) => (
				<span
					key={hour}
					className="bg-primary/35 min-w-0 flex-1 rounded-t-xs"
					// Bar heights are data, not styling: one pixel minimum so a quiet hour still shows.
					style={{ height: bar > 0 ? `${Math.max(bar * 100, 6)}%` : '1px' }}
				/>
			))}
		</div>
	)
}
