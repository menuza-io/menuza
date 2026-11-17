import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { requireUserId } from '@repo/auth'
import { summarizeFinancialPeriod } from '@repo/common/financial-period-summary'
import { WorkspacePage } from '@repo/ui/workspace'
import { useLoaderData } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { type Route } from './+types/financial-summary.ts'

/** Placeholder until tenant financial loader is wired; totals logic is tested in @repo/common. */
export async function loader({ request, params }: Route.LoaderArgs) {
	await requireUserId(request)
	await requireUserOrganization(request, params.orgSlug, { id: true })
	const summary = summarizeFinancialPeriod([])
	return { orgSlug: params.orgSlug, summary }
}

export default function FinancialSummaryPage() {
	const { _ } = useLingui()
	const { summary } = useLoaderData<typeof loader>()
	return (
		<WorkspacePage title={_(msg`Financial summary`)}>
			<p className="text-muted-foreground mb-6 text-sm">
				<Trans>
					Period totals for accounting: sales, tax by rate, tips, fees, and
					refunds. Export matches this view.
				</Trans>
			</p>
			<dl className="grid gap-2 text-sm sm:grid-cols-2">
				<div>
					<dt>
						<Trans>Net sales</Trans>
					</dt>
					<dd data-testid="financial-net-sales">
						{(summary.netSalesMinor / 100).toFixed(2)}
					</dd>
				</div>
				<div>
					<dt>
						<Trans>Tax</Trans>
					</dt>
					<dd data-testid="financial-tax">{summary.taxMinor / 100}</dd>
				</div>
			</dl>
			{summary.taxByRate.length > 0 ? (
				<ul
					className="mt-4 space-y-1 text-sm"
					data-testid="financial-tax-rates"
				>
					{summary.taxByRate.map((row) => (
						<li key={row.rateBp}>
							<Trans>
								{row.rateBp / 100}%: {(row.taxMinor / 100).toFixed(2)}
							</Trans>
						</li>
					))}
				</ul>
			) : null}
		</WorkspacePage>
	)
}
