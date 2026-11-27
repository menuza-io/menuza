import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	buildPayoutBridge,
	findUnmatchedTransactions,
	splitTipsByOrderType,
} from '@repo/common/payout-reconciliation'
import { csvLines } from '@repo/reports/export'
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
import { Separator } from '@repo/ui/separator'
import { useEffect, useMemo, useState } from 'react'
import { Link, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOrganizationPayoutDetail } from '#app/utils/payments/payouts.server.ts'
import { normalizeShopProcessor } from '#app/utils/shop.types.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		shopPaymentProvider: true,
		stripeConnectAccountId: true,
		checkoutSubEntityId: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_PAYMENTS_ANY,
	)

	const payoutId = params.payoutId?.trim()
	if (!payoutId) {
		throw new Response('Not Found', { status: 404 })
	}

	const url = new URL(request.url)
	const forceRefresh = url.searchParams.get('refresh') === '1'
	const wantCsv = url.searchParams.get('format') === 'csv'
	const isUs = (organization.dataRegion || 'us') === 'us'
	const normalized = isUs
		? normalizeShopProcessor(organization.shopPaymentProvider)
		: 'checkout'
	const provider: 'connect' | 'checkout' =
		normalized === 'checkout' ? 'checkout' : 'connect'
	const connectedAccountId =
		provider === 'checkout'
			? organization.checkoutSubEntityId
			: organization.stripeConnectAccountId

	const { detail, fetchedAt, cached } = await getOrganizationPayoutDetail({
		organizationId: organization.id,
		provider,
		connectedAccountId,
		payoutId,
		currency: isUs ? 'USD' : 'SAR',
		forceRefresh,
	})

	if (wantCsv) {
		const header = [
			'Transaction ID',
			'Type',
			'Order Ref',
			'Date',
			'Gross',
			'Provider Fee',
			'Platform Fee',
			'Net',
			'Currency',
		]
		const rows = detail.transactions.map((txn) => [
			txn.id,
			txn.kind,
			txn.orderId ?? '',
			txn.createdAt,
			(txn.grossCents / 100).toFixed(2),
			(txn.providerFeeCents / 100).toFixed(2),
			(txn.platformFeeCents / 100).toFixed(2),
			(txn.netCents / 100).toFixed(2),
			txn.currency,
		])
		const csv = csvLines([header, ...rows])
		return new Response(csv, {
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="payout-${payoutId.replace(/[^a-zA-Z0-9_-]/g, '')}.csv"`,
				'Cache-Control': 'private, no-store',
			},
		})
	}

	return {
		organization: { id: organization.id, slug: organization.slug },
		detail,
		fetchedAt,
		cached,
	}
}

type RegionalOrderSummary = {
	id: string
	number: string
	fulfillment: string
	totalCents: number
	tipCents: number
	currency: string
	paidAt: string | null
	locationId: string
}

function formatMoney(cents: number, currency: string, locale: string) {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: currency || 'USD',
	}).format(cents / 100)
}

export default function PayoutDetailRoute() {
	const { organization, detail } = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const [regionalOrders, setRegionalOrders] = useState<RegionalOrderSummary[]>(
		[],
	)

	const orderIds = useMemo(
		() => [
			...new Set(
				detail.transactions
					.map((t) => t.orderId)
					.filter((id): id is string => Boolean(id)),
			),
		],
		[detail.transactions],
	)

	// Browser-direct regional lookup (`GET /operator/orders?ids=`) so no order
	// PII or regional data passes through the US App (#168).
	useEffect(() => {
		if (orderIds.length === 0) return
		let cancelled = false
		void (async () => {
			try {
				const tokenRes = await fetch(`/${organization.slug}/orders-token`)
				if (!tokenRes.ok) return
				const { jwt, tenantApiUrl } = (await tokenRes.json()) as {
					jwt: string
					tenantApiUrl: string
				}
				const ordersRes = await fetch(
					`${tenantApiUrl}/operator/orders?ids=${encodeURIComponent(orderIds.join(','))}`,
					{ headers: { Authorization: `Bearer ${jwt}` } },
				)
				if (!ordersRes.ok || cancelled) return
				const payload = (await ordersRes.json()) as {
					orders?: RegionalOrderSummary[]
				}
				if (!cancelled && Array.isArray(payload.orders)) {
					setRegionalOrders(payload.orders)
				}
			} catch {
				// Non-fatal: payout still renders with opaque order ids.
			}
		})()
		return () => {
			cancelled = true
		}
	}, [organization.slug, orderIds])

	const ordersById = useMemo(
		() => new Map(regionalOrders.map((o) => [o.id, o])),
		[regionalOrders],
	)

	const totals = useMemo(() => {
		let grossCents = 0
		let providerFeesCents = 0
		let platformFeesCents = 0
		let refundsCents = 0
		let disputesCents = 0
		let reservesCents = 0
		let netCents = 0
		for (const txn of detail.transactions) {
			netCents += txn.netCents
			providerFeesCents += txn.providerFeeCents
			platformFeesCents += txn.platformFeeCents
			if (txn.kind === 'payment') grossCents += txn.grossCents
			else if (txn.kind === 'refund') refundsCents += txn.grossCents
			else if (txn.kind === 'dispute') disputesCents += txn.grossCents
			else if (txn.kind === 'reserve') reservesCents += txn.grossCents
		}
		return {
			grossCents,
			providerFeesCents,
			platformFeesCents,
			refundsCents,
			disputesCents,
			reservesCents,
			netCents,
		}
	}, [detail.transactions])

	const unmatched = useMemo(
		() =>
			findUnmatchedTransactions({
				providerTransactions: detail.transactions.map((t) => ({
					id: t.id,
					kind: t.kind,
					orderId: t.orderId,
					orderType: t.orderKind,
					grossCents: t.grossCents,
					currency: t.currency,
					createdAt: t.createdAt,
				})),
				regionalPaidOrders: regionalOrders.map((o) => ({
					id: o.id,
					number: o.number,
					totalCents: o.totalCents,
					currency: o.currency,
					paidAt: o.paidAt,
				})),
			}),
		[detail.transactions, regionalOrders],
	)

	const bridgeResult = useMemo(
		() =>
			buildPayoutBridge({
				depositedCents: detail.payout.amountCents,
				periodSalesCents: totals.grossCents,
				otherPayoutSalesCents: 0,
				otherPeriodRefundsCents: totals.refundsCents,
				providerFeesCents: totals.providerFeesCents,
				platformFeesCents: totals.platformFeesCents,
				disputesCents: totals.disputesCents,
				reservesCents: totals.reservesCents,
				hasUnmatched: unmatched.unmatchedProvider.length > 0,
			}),
		[detail.payout.amountCents, totals, unmatched.unmatchedProvider.length],
	)

	const tipsSplit = useMemo(
		() =>
			splitTipsByOrderType(
				regionalOrders.map((o) => ({
					orderType: o.fulfillment || 'online',
					tipCents: o.tipCents ?? 0,
				})),
			),
		[regionalOrders],
	)

	const money = (cents: number, currency = detail.payout.currency) =>
		formatMoney(cents, currency, i18n.locale)

	const payoutDay = detail.payout.createdAt.slice(0, 10)
	const arrivalDateLabel = new Date(
		detail.payout.arrivalDate,
	).toLocaleDateString(i18n.locale)

	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<div className="flex flex-col gap-6" data-testid="payout-detail-page">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="text-muted-foreground text-xs">
								<Link
									to={`/${organization.slug}/payments`}
									className="hover:underline"
								>
									<Trans>Payments &amp; payouts</Trans>
								</Link>
							</p>
							<h1 className="text-2xl font-semibold tabular-nums">
								<bdi>{money(detail.payout.amountCents)}</bdi>
							</h1>
							<div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
								<Badge
									variant={
										bridgeResult.status === 'matched'
											? 'default'
											: bridgeResult.status === 'could_not_match'
												? 'warning'
												: 'secondary'
									}
									data-testid="payout-reconciliation-status"
								>
									{bridgeResult.status === 'matched' ? (
										<Trans>Matched</Trans>
									) : bridgeResult.status === 'could_not_match' ? (
										<Trans>Could not match</Trans>
									) : (
										<Trans>Matching</Trans>
									)}
								</Badge>
								<span className="text-muted-foreground">
									<Trans>Arrives {arrivalDateLabel}</Trans>
								</span>
							</div>
						</div>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								render={
									<Link
										to={`/${organization.slug}/reports?from=${encodeURIComponent(payoutDay)}&to=${encodeURIComponent(payoutDay)}`}
									/>
								}
							>
								<Trans>Open sales report</Trans>
							</Button>
							<Button
								variant="outline"
								render={
									<a
										href={`/${organization.slug}/payments/${encodeURIComponent(detail.payout.id)}?format=csv`}
									/>
								}
							>
								<Trans>Export CSV</Trans>
							</Button>
							<Button
								variant="outline"
								render={
									<Link
										to={`/${organization.slug}/payments/${encodeURIComponent(detail.payout.id)}?refresh=1`}
									/>
								}
							>
								<Trans>Refresh</Trans>
							</Button>
						</div>
					</div>

					<Card data-testid="payout-bridge-card">
						<CardHeader>
							<CardTitle>
								<Trans>From sales to deposit</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>
									How sales, refunds, fees, disputes, and reserves add up to the
									deposited amount.
								</Trans>
							</CardDescription>
						</CardHeader>
						<CardContent>
							{bridgeResult.bridge ? (
								<div className="space-y-2 text-sm">
									{bridgeResult.bridge.lines.map((line) => (
										<div
											key={line.kind}
											className="flex items-center justify-between gap-2"
										>
											<span className="text-muted-foreground">
												{line.label}
											</span>
											<span className="tabular-nums">
												<bdi>{money(line.amountCents)}</bdi>
											</span>
										</div>
									))}
									<Separator />
									<div className="flex items-center justify-between text-base font-semibold">
										<span>
											<Trans>Amount deposited</Trans>
										</span>
										<span className="tabular-nums">
											<bdi>{money(bridgeResult.bridge.depositedCents)}</bdi>
										</span>
									</div>
								</div>
							) : (
								<p className="text-muted-foreground text-sm">
									<Trans>
										Matching — provider data is still arriving, so the deposit
										bridge will appear once all transactions settle.
									</Trans>
								</p>
							)}
						</CardContent>
					</Card>

					{tipsSplit.length > 0 ? (
						<Card>
							<CardHeader>
								<CardTitle>
									<Trans>Tips by order type</Trans>
								</CardTitle>
							</CardHeader>
							<CardContent>
								<dl className="space-y-1.5 text-sm">
									{tipsSplit.map((bucket) => (
										<div
											key={bucket.orderType}
											className="flex items-center justify-between"
										>
											<dt className="text-muted-foreground capitalize">
												{bucket.orderType.replace('_', ' ')} (
												{bucket.orderCount})
											</dt>
											<dd className="tabular-nums">
												<bdi>{money(bucket.tipCents)}</bdi>
											</dd>
										</div>
									))}
								</dl>
							</CardContent>
						</Card>
					) : null}

					<Card>
						<CardHeader>
							<CardTitle>
								<Trans>Transactions in this payout</Trans>
							</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead>
										<tr className="text-muted-foreground border-b text-start">
											<th className="py-2 pe-3 text-start font-medium">
												<Trans>Order</Trans>
											</th>
											<th className="py-2 pe-3 text-start font-medium">
												<Trans>Type</Trans>
											</th>
											<th className="py-2 pe-3 text-end font-medium">
												<Trans>Gross</Trans>
											</th>
											<th className="py-2 pe-3 text-end font-medium">
												<Trans>Provider fee</Trans>
											</th>
											<th className="py-2 pe-3 text-end font-medium">
												<Trans>Platform fee</Trans>
											</th>
											<th className="py-2 pe-3 text-end font-medium">
												<Trans>Net</Trans>
											</th>
											<th className="py-2 text-end font-medium">
												<Trans>Calculator</Trans>
											</th>
										</tr>
									</thead>
									<tbody className="divide-y">
										{detail.transactions.map((txn) => {
											const regional = txn.orderId
												? ordersById.get(txn.orderId)
												: undefined
											const label = regional
												? `#${regional.number}`
												: (txn.orderId ?? _(msg`Unmatched`))
											return (
												<tr key={txn.id} data-testid={`payout-txn-${txn.id}`}>
													<td className="py-2.5 pe-3 font-medium">
														{txn.orderId ? (
															<Link
																to={`/${organization.slug}/orders/${encodeURIComponent(txn.orderId)}`}
																className="text-primary underline-offset-4 hover:underline"
															>
																<bdi dir="ltr">{label}</bdi>
															</Link>
														) : (
															<span className="text-muted-foreground">
																{label}
															</span>
														)}
													</td>
													<td className="py-2.5 pe-3 capitalize">{txn.kind}</td>
													<td className="py-2.5 pe-3 text-end tabular-nums">
														<bdi>{money(txn.grossCents, txn.currency)}</bdi>
													</td>
													<td className="py-2.5 pe-3 text-end tabular-nums">
														<bdi>
															{money(txn.providerFeeCents, txn.currency)}
														</bdi>
													</td>
													<td className="py-2.5 pe-3 text-end tabular-nums">
														<bdi>
															{money(txn.platformFeeCents, txn.currency)}
														</bdi>
													</td>
													<td className="py-2.5 pe-3 text-end font-medium tabular-nums">
														<bdi>{money(txn.netCents, txn.currency)}</bdi>
													</td>
													<td className="py-2.5 text-end">
														{txn.kind === 'payment' && txn.grossCents > 0 ? (
															<Link
																to={`/${organization.slug}/settings/payments-calculator?amount=${encodeURIComponent((txn.grossCents / 100).toFixed(2))}&orderType=${encodeURIComponent(regional?.fulfillment === 'delivery' ? 'delivery' : regional?.fulfillment === 'dine_in' ? 'in_store' : 'pickup')}&paymentMethod=card`}
																className="text-primary text-xs underline-offset-4 hover:underline"
															>
																<Trans>Explain</Trans>
															</Link>
														) : null}
													</td>
												</tr>
											)
										})}
									</tbody>
								</table>
							</div>
						</CardContent>
					</Card>

					{unmatched.unmatchedProvider.length > 0 ||
					unmatched.unmatchedOrders.length > 0 ? (
						<Card data-testid="payout-unmatched-card">
							<CardHeader>
								<CardTitle>
									<Trans>Unmatched transactions</Trans>
								</CardTitle>
								<CardDescription>
									<Trans>
										Provider payments with no linked Menuza order, or Menuza
										paid orders with no provider transaction after 3 days.
									</Trans>
								</CardDescription>
							</CardHeader>
							<CardContent>
								<div className="space-y-3 text-sm">
									{unmatched.unmatchedProvider.map((txn) => (
										<div
											key={txn.id}
											className="flex items-center justify-between gap-2"
										>
											<span>
												<bdi dir="ltr">{txn.id}</bdi> —{' '}
												<Trans>No Menuza order linked</Trans>
											</span>
											<span className="tabular-nums">
												<bdi>{money(txn.grossCents, txn.currency)}</bdi>
											</span>
										</div>
									))}
									{unmatched.unmatchedOrders.map((ord) => (
										<div
											key={ord.id}
											className="flex items-center justify-between gap-2"
										>
											<span>
												<bdi dir="ltr">#{ord.number}</bdi> —{' '}
												<Trans>No provider transaction after 3 days</Trans>
											</span>
											<span className="tabular-nums">
												<bdi>{money(ord.totalCents, ord.currency)}</bdi>
											</span>
										</div>
									))}
								</div>
							</CardContent>
						</Card>
					) : null}
				</div>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
