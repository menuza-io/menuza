import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	keptByOrderingDirect,
	type FigureEntry,
	type FigureValue,
} from '@repo/reports'
import { Badge } from '@repo/ui/badge'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { fetchMonthlyFigures } from '#app/utils/reports/monthly-client.ts'

export type KeptByDirectView = {
	orgSlug: string
	month: string
	timeZone: string
	tokenUrl: string
	tenantApiUrl: string
	commissionBp: number
}

/**
 * Billing: what ordering direct kept last month, next to the plan price (#221).
 * The same estimate as on Reports, Monthly results: your direct online sales
 * times the delivery-app commission rate you set, labelled an estimate with the
 * rate shown. Read from the region by the member's own reports token; shown only
 * to members whose token covers sales.
 */
export function KeptByDirectCard({ view }: { view: KeptByDirectView }) {
	const { _, i18n } = useLingui()
	const [kept, setKept] = useState<FigureEntry[] | null | 'error'>(null)
	useEffect(() => {
		const controller = new AbortController()
		fetchMonthlyFigures({
			tokenUrl: view.tokenUrl,
			tenantApiUrl: view.tenantApiUrl,
			month: view.month,
			ids: ['onlineSales'],
			timeZone: view.timeZone,
			signal: controller.signal,
		})
			.then((figures: FigureValue[]) => {
				if (controller.signal.aborted) return
				const online = figures.find((f) => f.id === 'onlineSales')
				// No sales grant on this token: nothing to show (hidden, not zero).
				setKept(online ? keptByOrderingDirect(online.entries, view.commissionBp) : [])
			})
			.catch(() => {
				if (!controller.signal.aborted) setKept('error')
			})
		return () => controller.abort()
	}, [view])
	if (kept === null || kept === 'error') return null
	if (kept.length === 0) return null
	return (
		<Card data-testid="billing-kept-by-direct">
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2">
					<Trans>Kept by ordering direct last month</Trans>
					<Badge variant="outline" data-testid="billing-kept-estimate">
						<Trans>
							Estimate at <bdi>{view.commissionBp / 100}</bdi>% commission
						</Trans>
					</Badge>
				</CardTitle>
				<CardDescription>
					<Trans>
						What the same orders would have cost on a delivery app. An estimate
						from your direct online sales, not real money.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-2">
				<div className="text-2xl font-semibold tabular-nums">
					{kept.map((entry) => (
						<div key={entry.currency} data-testid={`billing-kept-${entry.currency}`}>
							{new Intl.NumberFormat(i18n.locale, {
								style: 'currency',
								currency: entry.currency ?? 'USD',
							}).format(entry.value)}
						</div>
					))}
				</div>
				<Link
					to={`/${view.orgSlug}/reports/monthly?month=${view.month}`}
					className="text-sm underline underline-offset-4"
				>
					{_(msg`See the monthly results`)}
				</Link>
			</CardContent>
		</Card>
	)
}
