import { Trans, msg } from '@lingui/macro'
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
import {
	Link,
	type LoaderFunctionArgs,
	useLoaderData,
	useRevalidator,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOrganizationPayoutsSnapshot } from '#app/utils/payments/payouts.server.ts'
import { normalizeShopProcessor } from '#app/utils/shop.types.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
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

	const url = new URL(request.url)
	const forceRefresh = url.searchParams.get('refresh') === '1'
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

	const { snapshot, fetchedAt, cached } = await getOrganizationPayoutsSnapshot({
		organizationId: organization.id,
		provider,
		connectedAccountId,
		currency: isUs ? 'USD' : 'SAR',
		forceRefresh,
	})

	return {
		organization: { id: organization.id, slug: organization.slug },
		snapshot,
		fetchedAt,
		cached,
	}
}

function formatMoney(cents: number, currency: string, locale: string) {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: currency || 'USD',
	}).format(cents / 100)
}

export default function PaymentsPayoutsIndexRoute() {
	const { organization, snapshot, fetchedAt } = useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const revalidator = useRevalidator()
	const money = (cents: number, currency = snapshot.balance.currency) =>
		formatMoney(cents, currency, i18n.locale)
	const updatedTimeLabel = new Date(fetchedAt).toLocaleTimeString(i18n.locale)

	const balanceCards = [
		{
			key: 'available',
			label: _(msg`Available`),
			amount: snapshot.balance.availableCents,
			explanation: _(msg`Ready to be included in your next scheduled payout.`),
		},
		{
			key: 'in_transit',
			label: _(msg`On its way to the bank`),
			amount: snapshot.balance.inTransitCents,
			explanation: _(
				msg`Already sent by your payment provider and arriving in your bank soon.`,
			),
		},
		{
			key: 'pending',
			label: _(msg`Pending`),
			amount: snapshot.balance.pendingCents,
			explanation: _(
				msg`Recent card payments still clearing before they become available.`,
			),
		},
		{
			key: 'reserved',
			label: _(msg`Held in reserve`),
			amount: snapshot.balance.reservedCents,
			explanation: _(
				msg`Funds temporarily held by your provider for disputes or risk coverage.`,
			),
		},
	]

	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<div
					className="flex flex-col gap-6"
					data-testid="payments-payouts-page"
				>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<h1 className="text-2xl font-semibold">
								<Trans>Payments &amp; payouts</Trans>
							</h1>
							<p className="text-muted-foreground text-sm">
								<Trans>
									Read-only view of your balance and bank deposits. Updated{' '}
									{updatedTimeLabel}.
								</Trans>
							</p>
						</div>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								render={
									<Link
										to={`/${organization.slug}/settings/payments-calculator`}
									/>
								}
							>
								<Trans>What you get paid</Trans>
							</Button>
							<Button
								variant="outline"
								render={<Link to={`/${organization.slug}/orders/disputes`} />}
							>
								<Trans>Disputes</Trans>
							</Button>
							<Button
								variant="outline"
								render={
									<Link to={`/${organization.slug}/payments?refresh=1`} />
								}
								disabled={revalidator.state !== 'idle'}
							>
								<Trans>Refresh</Trans>
							</Button>
						</div>
					</div>

					<div
						className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
						data-testid="payments-balance-grid"
					>
						{balanceCards.map((item) => (
							<Card key={item.key} data-testid={`balance-${item.key}`}>
								<CardHeader className="pb-2">
									<CardDescription>{item.label}</CardDescription>
									<CardTitle className="text-xl tabular-nums">
										<bdi>{money(item.amount)}</bdi>
									</CardTitle>
								</CardHeader>
								<CardContent>
									<p className="text-muted-foreground text-xs">
										{item.explanation}
									</p>
								</CardContent>
							</Card>
						))}
					</div>

					<Card>
						<CardHeader>
							<CardTitle>
								<Trans>Payouts</Trans>
							</CardTitle>
							<CardDescription>
								<Trans>
									Select a payout to see the orders, refunds, disputes, fees,
									and deposit bridge inside it.
								</Trans>
							</CardDescription>
						</CardHeader>
						<CardContent>
							{snapshot.payouts.length === 0 ? (
								<p className="text-muted-foreground text-sm">
									<Trans>No payouts yet.</Trans>
								</p>
							) : (
								<div className="overflow-x-auto">
									<table className="w-full text-sm">
										<thead>
											<tr className="text-muted-foreground border-b text-start">
												<th className="py-2 pe-4 text-start font-medium">
													<Trans>Date</Trans>
												</th>
												<th className="py-2 pe-4 text-start font-medium">
													<Trans>Arrival date</Trans>
												</th>
												<th className="py-2 pe-4 text-start font-medium">
													<Trans>Status</Trans>
												</th>
												<th className="py-2 text-end font-medium">
													<Trans>Amount</Trans>
												</th>
											</tr>
										</thead>
										<tbody className="divide-y">
											{snapshot.payouts.map((payout) => (
												<tr
													key={payout.id}
													data-testid={`payout-row-${payout.id}`}
												>
													<td className="py-2.5 pe-4">
														<Link
															to={`/${organization.slug}/payments/${encodeURIComponent(payout.id)}`}
															className="text-primary font-medium underline-offset-4 hover:underline"
														>
															{new Date(payout.createdAt).toLocaleDateString(
																i18n.locale,
															)}
														</Link>
													</td>
													<td className="py-2.5 pe-4">
														{new Date(payout.arrivalDate).toLocaleDateString(
															i18n.locale,
														)}
													</td>
													<td className="py-2.5 pe-4">
														<Badge
															variant={
																payout.status === 'paid'
																	? 'default'
																	: payout.status === 'failed'
																		? 'destructive'
																		: 'secondary'
															}
														>
															{payout.status === 'paid' ? (
																<Trans>Paid</Trans>
															) : payout.status === 'in_transit' ? (
																<Trans>In transit</Trans>
															) : payout.status === 'failed' ? (
																<Trans>Failed</Trans>
															) : (
																<Trans>Pending</Trans>
															)}
														</Badge>
													</td>
													<td className="py-2.5 text-end font-medium tabular-nums">
														<bdi>
															{money(payout.amountCents, payout.currency)}
														</bdi>
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
