import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	LOYALTY_PERMISSIONS,
	type LoyaltyOperatorProgram,
	type LoyaltyOperatorReward,
	type LoyaltyReport,
} from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspaceMetric, WorkspaceMetricGrid } from '@repo/ui/workspace'
import { useCallback, useEffect, useState } from 'react'
import { useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { useLoyaltyClient } from '#app/hooks/use-loyalty-client.ts'
import { requireLoyaltyAccess } from '#app/utils/loyalty/access.server.ts'
import { loyaltyErrorInfo } from '#app/utils/loyalty/loyalty-client.ts'
import { loyaltyErrorMessage } from '#app/utils/loyalty/loyalty-errors.ts'
import {
	LOYALTY_EARNING_METHOD_LABELS,
	LOYALTY_PROGRAM_STATUS_LABELS,
	LOYALTY_UNIT_LABEL_LABELS,
	loyaltyEnumLabel,
} from '#app/utils/loyalty/loyalty-labels.ts'
import {
	dateInTimeZone,
	formatBpPercent,
	formatLoyaltyMoney,
} from '#app/utils/loyalty/loyalty-view.ts'
import { LOYALTY_SECTION_REQUIREMENTS } from '#app/utils/loyalty/sections.ts'
import { type Route } from './+types/overview.ts'
import { useLoyaltyLayoutData } from './_layout.tsx'

const REPORT_WINDOW_DAYS = 30

function reportWindow(timeZone: string | undefined) {
	const now = Date.now()
	return {
		from: dateInTimeZone(now - (REPORT_WINDOW_DAYS - 1) * 86_400_000, timeZone),
		to: dateInTimeZone(now, timeZone),
	}
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireLoyaltyAccess(request, params.orgSlug, {
		anyOf: LOYALTY_SECTION_REQUIREMENTS.overview.anyOf,
	})
	return {
		orgSlug: access.orgSlug,
		canReadReports: access.grants.includes(
			LOYALTY_PERMISSIONS.READ_LOYALTY_REPORT,
		),
		canReadProgram: access.grants.includes(LOYALTY_PERMISSIONS.READ_LOYALTY),
	}
}

export default function LoyaltyOverviewRoute() {
	const { t, i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const { orgSlug, canReadReports, canReadProgram } =
		useLoaderData<typeof loader>()
	const { nav } = useLoyaltyLayoutData()
	const client = useLoyaltyClient()

	const [program, setProgram] = useState<LoyaltyOperatorProgram | null>(null)
	const [rewards, setRewards] = useState<LoyaltyOperatorReward[]>([])
	const [report, setReport] = useState<LoyaltyReport | null>(null)
	const [reportFailed, setReportFailed] = useState(false)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const load = useCallback(async () => {
		setLoading(true)
		setError(null)
		setReportFailed(false)
		setReport(null)
		try {
			if (!canReadProgram) {
				// A reports-only role cannot mint a read token, so it gets the
				// figures alone, over the browser's calendar days.
				setProgram(null)
				setRewards([])
				try {
					setReport(
						await client.getReport(
							reportWindow(Intl.DateTimeFormat().resolvedOptions().timeZone),
						),
					)
				} catch (err) {
					if (loyaltyErrorInfo(err).code !== 'program_not_found') throw err
				}
				return
			}
			const nextProgram = await client.getProgram()
			setProgram(nextProgram)
			setRewards(nextProgram ? await client.listRewards() : [])
			if (!nextProgram) return
			if (canReadReports) {
				try {
					setReport(
						await client.getReport(
							reportWindow(nextProgram.current.config.timeZone),
						),
					)
				} catch {
					setReportFailed(true)
				}
			}
		} catch (err) {
			setError(
				loyaltyErrorMessage(
					err,
					tx,
					msg`The loyalty overview could not be loaded.`,
				),
			)
		} finally {
			setLoading(false)
		}
	}, [client, canReadReports, canReadProgram, tx])

	useEffect(() => {
		void load()
	}, [load])

	const config = program?.current.config ?? null
	const cheapestReward = rewards
		.filter((reward) => reward.status === 'active')
		.reduce<LoyaltyOperatorReward | null>(
			(cheapest, reward) =>
				cheapest === null ||
				reward.definition.pointsCost < cheapest.definition.pointsCost
					? reward
					: cheapest,
			null,
		)
	const earning = config?.earning ?? null
	const unitName = config ? tx(LOYALTY_UNIT_LABEL_LABELS[config.unitLabel]) : ''
	const earnPoints = earning?.points ?? 0
	const spendStep =
		config && earning?.method === 'spend'
			? formatLoyaltyMoney(earning.perMinor, config.currency, i18n.locale)
			: ''
	const minimumSpend = config
		? formatLoyaltyMoney(config.minimumSpendMinor, config.currency, i18n.locale)
		: ''
	const rewardName = cheapestReward?.definition.name ?? ''
	const rewardCost = cheapestReward?.definition.pointsCost ?? 0
	const newAccounts = report?.customers.accountsOpened ?? 0
	const pointsRedeemed = report?.points.redeemed ?? 0
	const purchaseCount = report?.purchases.count ?? 0

	return (
		<div className="flex flex-col gap-6" data-testid="loyalty-overview-page">
			{error ? (
				<Alert variant="destructive" data-testid="loyalty-overview-error">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<div className="flex flex-wrap items-center gap-3">
							{error}
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void load()}
							>
								<Trans>Try again</Trans>
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{loading ? (
				<div
					role="status"
					className="flex flex-col gap-4"
					data-testid="loyalty-overview-loading"
				>
					<span className="sr-only">
						<Trans>Loading the overview…</Trans>
					</span>
					<Skeleton className="h-24 w-full" />
					<Skeleton className="h-40 w-full" />
				</div>
			) : null}

			{!loading && !error && !program && !report ? (
				<div data-testid="loyalty-overview-empty">
					<EmptyState
						title={<Trans>No loyalty program yet</Trans>}
						description={
							nav.program ? (
								<Trans>
									Set up earning rules and rewards so customers earn on every
									visit.
								</Trans>
							) : (
								<Trans>
									Figures appear here once someone who manages loyalty sets up
									the program.
								</Trans>
							)
						}
						icons={['star', 'users', 'trophy']}
						action={
							nav.program
								? {
										label: t`Set up the program`,
										href: `/${orgSlug}/loyalty/program`,
									}
								: undefined
						}
					/>
				</div>
			) : null}

			{!loading && program && config ? (
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
					<Card data-testid="loyalty-program-summary">
						<CardHeader className="pb-2">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div className="min-w-0">
									<CardTitle className="text-base wrap-anywhere">
										{config.name}
									</CardTitle>
									<CardDescription>
										<Trans>Program summary</Trans>
									</CardDescription>
								</div>
								<Badge
									variant={
										program.status === 'active'
											? 'success'
											: program.status === 'paused'
												? 'warning'
												: 'secondary'
									}
									data-testid="loyalty-program-status"
								>
									{loyaltyEnumLabel(
										tx,
										LOYALTY_PROGRAM_STATUS_LABELS,
										program.status,
									)}
								</Badge>
							</div>
						</CardHeader>
						<CardContent>
							<dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
								<div className="flex flex-col gap-0.5">
									<dt className="text-muted-foreground text-xs">
										<Trans>Earning method</Trans>
									</dt>
									<dd data-testid="loyalty-program-earning">
										{loyaltyEnumLabel(
											tx,
											LOYALTY_EARNING_METHOD_LABELS,
											config.earning.method,
										)}
									</dd>
								</div>
								<div className="flex flex-col gap-0.5">
									<dt className="text-muted-foreground text-xs">
										<Trans>Unit</Trans>
									</dt>
									<dd>
										{loyaltyEnumLabel(
											tx,
											LOYALTY_UNIT_LABEL_LABELS,
											config.unitLabel,
										)}
									</dd>
								</div>
								<div className="flex flex-col gap-0.5">
									<dt className="text-muted-foreground text-xs">
										<Trans>Currency</Trans>
									</dt>
									<dd dir="ltr">{config.currency}</dd>
								</div>
								<div className="flex flex-col gap-0.5">
									<dt className="text-muted-foreground text-xs">
										<Trans>Minimum qualifying spend</Trans>
									</dt>
									<dd dir="ltr">
										{formatLoyaltyMoney(
											config.minimumSpendMinor,
											config.currency,
											i18n.locale,
										)}
									</dd>
								</div>
								<div className="flex flex-col gap-0.5">
									<dt className="text-muted-foreground text-xs">
										<Trans>Time zone</Trans>
									</dt>
									<dd dir="ltr">{config.timeZone}</dd>
								</div>
							</dl>
						</CardContent>
					</Card>

					<Card data-testid="loyalty-setup-preview">
						<CardHeader className="pb-2">
							<CardTitle className="text-base">
								<Trans>What customers see</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>Worked examples from the live configuration.</Trans>
							</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-3">
							<div
								className="flex items-start gap-3 rounded-lg border p-3 text-sm"
								data-testid="loyalty-preview-earning"
							>
								<Icon
									name="star"
									className="text-muted-foreground mt-0.5 size-4 shrink-0"
								/>
								<div className="flex flex-col gap-1">
									{config.earning.method === 'spend' ? (
										<span>
											<Trans>
												Every <bdi dir="ltr">{spendStep}</bdi> spent earns{' '}
												<bdi dir="ltr" className="tabular-nums">
													{earnPoints}
												</bdi>{' '}
												{unitName}.
											</Trans>
										</span>
									) : null}
									{config.earning.method === 'visit' ? (
										<span>
											<Trans>
												Each qualifying visit earns{' '}
												<bdi dir="ltr" className="tabular-nums">
													{earnPoints}
												</bdi>{' '}
												{unitName}, at most once a day.
											</Trans>
										</span>
									) : null}
									{config.earning.method === 'items' ? (
										<span>
											<Trans>
												Each unit of a selected item earns{' '}
												<bdi dir="ltr" className="tabular-nums">
													{earnPoints}
												</bdi>{' '}
												{unitName}.
											</Trans>
										</span>
									) : null}
									{config.earning.method === 'categories' ? (
										<span>
											<Trans>
												Each unit in a selected category earns{' '}
												<bdi dir="ltr" className="tabular-nums">
													{earnPoints}
												</bdi>{' '}
												{unitName}.
											</Trans>
										</span>
									) : null}
									{config.minimumSpendMinor > 0 ? (
										<span className="text-muted-foreground text-xs">
											<Trans>
												Orders below <bdi dir="ltr">{minimumSpend}</bdi> do not
												earn.
											</Trans>
										</span>
									) : null}
								</div>
							</div>
							<div
								className="flex items-start gap-3 rounded-lg border p-3 text-sm"
								data-testid="loyalty-preview-redemption"
							>
								<Icon
									name="trophy"
									className="text-muted-foreground mt-0.5 size-4 shrink-0"
								/>
								{cheapestReward ? (
									<span>
										<Trans>
											Cheapest reward:{' '}
											<span className="font-medium wrap-anywhere">
												{rewardName}
											</span>{' '}
											for{' '}
											<bdi dir="ltr" className="tabular-nums">
												{rewardCost}
											</bdi>{' '}
											{unitName}.
										</Trans>
									</span>
								) : (
									<span className="text-muted-foreground">
										<Trans>
											No active rewards yet. Customers can earn but not redeem.
										</Trans>
									</span>
								)}
							</div>
						</CardContent>
					</Card>
				</div>
			) : null}

			{!loading && canReadReports ? (
				report ? (
					<div
						className="flex flex-col gap-4"
						data-testid="loyalty-report-block"
					>
						<WorkspaceMetricGrid>
							<WorkspaceMetric
								label={<Trans>Customers</Trans>}
								value={
									<span dir="ltr" data-testid="loyalty-metric-customers">
										{report.customers.accountsTotal}
									</span>
								}
								hint={
									<Trans>
										<bdi dir="ltr">{newAccounts}</bdi> joined in the last{' '}
										{REPORT_WINDOW_DAYS} days
									</Trans>
								}
							/>
							<WorkspaceMetric
								label={<Trans>Active customers</Trans>}
								value={
									<span dir="ltr" data-testid="loyalty-metric-active">
										{report.customers.activeInWindow}
									</span>
								}
								hint={<Trans>Earned at least once in the window</Trans>}
							/>
							<WorkspaceMetric
								label={<Trans>Points earned</Trans>}
								value={
									<span dir="ltr" data-testid="loyalty-metric-earned">
										{report.points.earned}
									</span>
								}
								hint={
									<Trans>
										<bdi dir="ltr">{pointsRedeemed}</bdi> redeemed
									</Trans>
								}
							/>
							<WorkspaceMetric
								label={<Trans>Customer revenue</Trans>}
								value={
									<span dir="ltr" data-testid="loyalty-metric-revenue">
										{formatLoyaltyMoney(
											report.purchases.customerRevenueMinor,
											report.currency,
											i18n.locale,
										)}
									</span>
								}
								hint={
									<Plural
										value={purchaseCount}
										one="# purchase"
										other="# purchases"
									/>
								}
							/>
						</WorkspaceMetricGrid>
						<Card data-testid="loyalty-report-details">
							<CardHeader className="pb-2">
								<CardTitle className="text-base">
									<Trans>Last {REPORT_WINDOW_DAYS} days</Trans>
								</CardTitle>
								<CardDescription dir="ltr">
									{report.window.from} – {report.window.to} ·{' '}
									{report.window.timeZone}
								</CardDescription>
							</CardHeader>
							<CardContent>
								<dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
									<div className="flex flex-col gap-0.5">
										<dt className="text-muted-foreground text-xs">
											<Trans>Average order value</Trans>
										</dt>
										<dd dir="ltr">
											{formatLoyaltyMoney(
												report.purchases.averageOrderValueMinor,
												report.currency,
												i18n.locale,
											)}
										</dd>
									</div>
									<div className="flex flex-col gap-0.5">
										<dt className="text-muted-foreground text-xs">
											<Trans>Repeat-purchase rate</Trans>
										</dt>
										<dd dir="ltr">
											{formatBpPercent(
												report.purchases.repeatPurchaseRateBp,
												i18n.locale,
											)}
										</dd>
									</div>
									<div className="flex flex-col gap-0.5">
										<dt className="text-muted-foreground text-xs">
											<Trans>Purchase frequency</Trans>
										</dt>
										<dd dir="ltr" className="tabular-nums">
											{(report.purchases.frequencyHundredths / 100).toFixed(2)}
										</dd>
									</div>
									<div className="flex flex-col gap-0.5">
										<dt className="text-muted-foreground text-xs">
											<Trans>Redemption conversion</Trans>
										</dt>
										<dd dir="ltr">
											{formatBpPercent(
												report.redemptions.conversionBp,
												i18n.locale,
											)}
										</dd>
									</div>
									<div className="flex flex-col gap-0.5">
										<dt className="text-muted-foreground text-xs">
											<Trans>Discount cost</Trans>
										</dt>
										<dd dir="ltr">
											{formatLoyaltyMoney(
												report.redemptions.discountCostMinor,
												report.currency,
												i18n.locale,
											)}
										</dd>
									</div>
									<div className="flex flex-col gap-0.5">
										<dt className="text-muted-foreground text-xs">
											<Trans>Waiting for review</Trans>
										</dt>
										<dd dir="ltr" className="tabular-nums">
											{report.operations.redemptionsInReview +
												report.operations.purchasesInReview}
										</dd>
									</div>
								</dl>
							</CardContent>
						</Card>
					</div>
				) : reportFailed ? (
					<Alert variant="destructive" data-testid="loyalty-report-error">
						<Icon name="alert-triangle" />
						<AlertDescription>
							<Trans>
								The report figures could not be loaded. The program summary
								above is up to date.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null
			) : null}
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
