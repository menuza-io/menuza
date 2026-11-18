import { Trans } from '@lingui/react/macro'
import { requireUserId } from '@repo/auth'
import { financialPeriodToCsv } from '@repo/common/financial-period-csv'
import {
	type FinancialPeriodSummary,
	summarizeFinancialPeriod,
} from '@repo/common/financial-period-summary'
import { Button } from '@repo/ui/button'
import { WorkspacePage } from '@repo/ui/workspace'
import { useCallback, useEffect, useState } from 'react'
import { useLoaderData } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { getReportSalesBasis } from '#app/utils/reports/sales-basis.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'
import { type Route } from './+types/financial-summary.ts'

type LoaderData = {
	orgSlug: string
	tokenUrl: string
	tenantApiUrl: string
	salesBasis: 'net' | 'gross'
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		dataRegion: true,
	})
	const salesBasis = await getReportSalesBasis(userId, organization.id)
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(organization.dataRegion)
	return {
		orgSlug: params.orgSlug,
		tokenUrl: `/${params.orgSlug}/reports/token`,
		tenantApiUrl,
		salesBasis,
	}
}

export default function FinancialSummaryPage() {
	const { tokenUrl, tenantApiUrl, salesBasis } = useLoaderData<LoaderData>()
	const [summary, setSummary] = useState<FinancialPeriodSummary | null>(null)
	const [error, setError] = useState(false)
	const [preset] = useState('month_to_date')

	const load = useCallback(async () => {
		setError(false)
		try {
			const tokenRes = await fetch(tokenUrl)
			const tokenBody = (await tokenRes.json()) as { token?: string }
			if (!tokenRes.ok || typeof tokenBody.token !== 'string') throw new Error()
			const res = await fetch(
				`${tenantApiUrl}/analytics/financial-summary?preset=${preset}&salesBasis=${salesBasis}`,
				{ headers: { Authorization: `Bearer ${tokenBody.token}` } },
			)
			if (!res.ok) throw new Error()
			const body = (await res.json()) as { summary?: FinancialPeriodSummary }
			setSummary(body.summary ?? summarizeFinancialPeriod([]))
		} catch {
			setError(true)
			setSummary(summarizeFinancialPeriod([]))
		}
	}, [preset, salesBasis, tenantApiUrl, tokenUrl])

	useEffect(() => {
		void load()
	}, [load])

	const downloadCsv = () => {
		if (!summary) return
		const blob = new Blob([financialPeriodToCsv(summary)], {
			type: 'text/csv;charset=utf-8',
		})
		const url = URL.createObjectURL(blob)
		const anchor = document.createElement('a')
		anchor.href = url
		anchor.download = 'financial-summary.csv'
		anchor.click()
		URL.revokeObjectURL(url)
	}

	return (
		<WorkspacePage>
			<h1 className="text-2xl font-semibold tracking-tight">
				<Trans>Financial summary</Trans>
			</h1>
			<div className="mb-4 flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={() => void load()}
					data-testid="financial-refresh"
				>
					<Trans>Refresh</Trans>
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={downloadCsv}
					disabled={!summary}
					data-testid="financial-csv"
				>
					<Trans>Export CSV</Trans>
				</Button>
			</div>
			{error ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Could not load figures from your region.</Trans>
				</p>
			) : null}
			{summary ? (
				<>
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
							<dd data-testid="financial-tax">
								{(summary.taxMinor / 100).toFixed(2)}
							</dd>
						</div>
						<div>
							<dt>
								<Trans>Refunds</Trans>
							</dt>
							<dd data-testid="financial-refunds">
								{(summary.refundMinor / 100).toFixed(2)}
							</dd>
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
				</>
			) : (
				<p className="text-muted-foreground text-sm">
					<Trans>Loading…</Trans>
				</p>
			)}
		</WorkspacePage>
	)
}
