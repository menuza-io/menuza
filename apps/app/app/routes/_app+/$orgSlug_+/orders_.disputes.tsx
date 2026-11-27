import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Link, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	listOrganizationDisputes,
	summarizeDisputesForPeriod,
} from '#app/utils/payments/disputes.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
	})
	await requireMenuRead(request, organization.id)

	const [disputes, periodSummary] = await Promise.all([
		listOrganizationDisputes(organization.id),
		summarizeDisputesForPeriod({ organizationId: organization.id }),
	])

	return {
		organization: { id: organization.id, slug: organization.slug },
		disputes: disputes.map((d) => ({
			id: d.id,
			provider: d.provider,
			providerDisputeId: d.providerDisputeId,
			orderKind: d.orderKind,
			orderRef: d.orderRef,
			amountMinor: d.amountMinor,
			feeMinor: d.feeMinor,
			currency: d.currency,
			reason: d.reason,
			status: d.status,
			alreadyRefunded: d.alreadyRefunded,
			dueAt: d.dueAt ? d.dueAt.toISOString() : null,
			submittedAt: d.submittedAt ? d.submittedAt.toISOString() : null,
			createdAt: d.createdAt.toISOString(),
		})),
		periodSummary,
	}
}

function formatMoney(cents: number, currency: string, locale: string) {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: currency || 'USD',
	}).format(cents / 100)
}

export default function OrderDisputesListRoute() {
	const { organization, disputes, periodSummary } =
		useLoaderData<typeof loader>()
	const { i18n } = useLingui()
	const money = (cents: number, currency: string) =>
		formatMoney(cents, currency, i18n.locale)

	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<div className="flex flex-col gap-6" data-testid="orders-disputes-page">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h1 className="text-2xl font-semibold">
								<Trans>Payment disputes</Trans>
							</h1>
							<p className="text-muted-foreground text-sm">
								<Trans>
									Review chargebacks on online orders and reservation deposits
									and submit evidence before the deadline.
								</Trans>
							</p>
						</div>
						<Button
							variant="outline"
							render={<Link to={`/${organization.slug}/orders`} />}
						>
							<Trans>Back to orders</Trans>
						</Button>
					</div>

					{periodSummary.length > 0 ? (
						<div
							className="grid gap-4 sm:grid-cols-3"
							data-testid="disputes-period-summary"
						>
							{periodSummary.map((row) => {
								const currency = row.currency
								const feesFormatted = money(row.disputeFeesMinor, row.currency)
								const openCount = row.openCount
								const wonCount = row.wonCount
								const lostCount = row.lostCount
								return (
									<Card key={row.currency}>
										<CardHeader className="pb-2">
											<CardDescription>
												<Trans>Disputed ({currency})</Trans>
											</CardDescription>
											<CardTitle className="text-xl tabular-nums">
												<bdi>
													{money(row.disputedAmountMinor, row.currency)}
												</bdi>
											</CardTitle>
										</CardHeader>
										<CardContent>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Dispute fees: <bdi>{feesFormatted}</bdi> · {openCount}{' '}
													open · {wonCount} won · {lostCount} lost
												</Trans>
											</p>
										</CardContent>
									</Card>
								)
							})}
						</div>
					) : null}

					<Card>
						<CardHeader>
							<CardTitle>
								<Trans>Disputes</Trans>
							</CardTitle>
						</CardHeader>
						<CardContent>
							{disputes.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									<Trans>No payment disputes.</Trans>
								</p>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-sm">
										<thead>
											<tr className="text-muted-foreground border-b text-start">
												<th className="py-2 pe-4 text-start font-medium">
													<Trans>Order</Trans>
												</th>
												<th className="py-2 pe-4 text-start font-medium">
													<Trans>Reason</Trans>
												</th>
												<th className="py-2 pe-4 text-start font-medium">
													<Trans>Status</Trans>
												</th>
												<th className="py-2 pe-4 text-start font-medium">
													<Trans>Answer by</Trans>
												</th>
												<th className="py-2 text-end font-medium">
													<Trans>Amount</Trans>
												</th>
											</tr>
										</thead>
										<tbody className="divide-y">
											{disputes.map((d) => (
												<tr key={d.id} data-testid={`dispute-row-${d.id}`}>
													<td className="py-2.5 pe-4 font-medium">
														<Link
															to={`/${organization.slug}/orders/disputes/${encodeURIComponent(d.id)}`}
															className="text-primary underline-offset-4 hover:underline"
														>
															<bdi dir="ltr">{d.orderRef}</bdi>
														</Link>
														{d.alreadyRefunded ? (
															<Badge variant="warning" className="ms-2">
																<Trans>Already refunded</Trans>
															</Badge>
														) : null}
													</td>
													<td className="py-2.5 pe-4 capitalize">
														{d.reason.replaceAll('_', ' ')}
													</td>
													<td className="py-2.5 pe-4">
														<Badge
															variant={
																d.status === 'won'
																	? 'default'
																	: d.status === 'lost' ||
																		  d.status === 'accepted'
																		? 'destructive'
																		: d.status === 'needs_response'
																			? 'warning'
																			: 'secondary'
															}
														>
															{d.status === 'needs_response' ? (
																<Trans>Needs response</Trans>
															) : d.status === 'under_review' ? (
																<Trans>Under review</Trans>
															) : d.status === 'won' ? (
																<Trans>Won</Trans>
															) : d.status === 'accepted' ? (
																<Trans>Accepted</Trans>
															) : (
																<Trans>Lost</Trans>
															)}
														</Badge>
													</td>
													<td className="py-2.5 pe-4">
														{d.dueAt
															? new Date(d.dueAt).toLocaleDateString(
																	i18n.locale,
																)
															: '—'}
													</td>
													<td className="py-2.5 text-end font-medium tabular-nums">
														<bdi>{money(d.amountMinor, d.currency)}</bdi>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</CardContent>
					</Card>
				</div>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
