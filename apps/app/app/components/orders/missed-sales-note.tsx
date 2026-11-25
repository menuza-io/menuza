import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type EntryEstimate,
	formatPauseLength,
	type MissedPlanEntry,
	weekdayName,
} from '#app/utils/location/missed-estimate.ts'
import { formatMoney } from '#app/utils/orders/order-model.ts'

/**
 * What a pause cost, on the Orders pause card (#176): "Paused 1 h 40 min,
 * about 14 orders (≈ $410) usually come in then", with the period the figure
 * rests on. Always an estimate (it says so and never mixes with real sales);
 * with fewer than two comparable weeks it says there is not enough history
 * rather than showing a number.
 */
export function MissedSalesNote({
	entry,
	estimate,
}: {
	entry: MissedPlanEntry
	estimate: EntryEstimate | undefined
}) {
	const { i18n } = useLingui()
	if (!estimate) return null
	const length = formatPauseLength(entry.minutesPaused, i18n.locale)
	if (estimate.status === 'not_enough') {
		return (
			<p
				className="text-muted-foreground text-xs"
				data-testid={`missed-sales-${entry.locationId}`}
			>
				<Trans>
					Paused <bdi>{length}</bdi>. Estimate: not enough history yet to say
					what this pause missed.
				</Trans>
			</p>
		)
	}
	const first = entry.plans[0]!
	const money = formatMoney(estimate.salesMinor, entry.currency, i18n.locale)
	const weekday = weekdayName(first.weekday, i18n.locale)
	const weeks = estimate.weeksUsed
	const orders = estimate.orders
	const from = first.localFrom
	const to = entry.plans[entry.plans.length - 1]!.localTo
	return (
		<p
			className="text-muted-foreground text-xs"
			data-testid={`missed-sales-${entry.locationId}`}
		>
			<Trans>
				Paused <bdi>{length}</bdi>, about {orders} orders (≈ <bdi>{money}</bdi>)
				usually come in then. Estimate based on the same hours, {weekday}{' '}
				<bdi>
					{from} to {to}
				</bdi>
				, over the last {weeks} weeks.
			</Trans>
		</p>
	)
}
