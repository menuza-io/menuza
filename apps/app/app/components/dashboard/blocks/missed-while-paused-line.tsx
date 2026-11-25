import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useMissedEstimates } from '#app/hooks/use-missed-estimates.ts'
import { formatMoney } from '#app/utils/orders/order-model.ts'

/**
 * "Missed while paused" on the home Today block (#176): the estimated web and
 * QR sales that did not come in during today's pauses, one amount per currency
 * (never added across currencies). It sits apart from the real sales tiles and
 * says it is an estimate, so it is never read as, or added to, real sales.
 * Shown only while there is a pause today with enough history behind it.
 */
export function MissedWhilePausedLine({
	orgSlug,
	tokenUrl,
	tenantApiUrl,
	locationIds,
}: {
	orgSlug: string
	tokenUrl: string
	tenantApiUrl: string | null
	/** The locations the block currently shows. */
	locationIds: readonly string[]
}) {
	const { i18n } = useLingui()
	const missed = useMissedEstimates({
		orgSlug,
		tokenUrl,
		tenantApiUrl,
		mode: 'today',
	})
	const shown = new Set(locationIds)
	const byCurrency = new Map<string, number>()
	for (const entry of missed.entries) {
		if (!shown.has(entry.locationId)) continue
		const estimate = missed.estimates.get(entry.id)
		if (estimate?.status !== 'enough') continue
		byCurrency.set(
			entry.currency,
			(byCurrency.get(entry.currency) ?? 0) + estimate.salesMinor,
		)
	}
	if (byCurrency.size === 0) return null
	return (
		<p
			className="text-muted-foreground text-xs"
			data-testid="today-missed-while-paused"
		>
			<Trans>Missed while paused (estimate, not in sales):</Trans>{' '}
			{[...byCurrency.entries()].map(([currency, minor], index) => (
				<span key={currency}>
					{index > 0 ? ' · ' : ''}
					<bdi className="tabular-nums">
						≈ {formatMoney(minor, currency, i18n.locale)}
					</bdi>
				</span>
			))}
		</p>
	)
}
