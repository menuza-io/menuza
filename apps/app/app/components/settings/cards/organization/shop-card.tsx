import { Trans } from '@lingui/macro'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { useRef } from 'react'
import { Form, useFetcher } from 'react-router'
import {
	MockPaymentsPanel,
	type PaymentsMockUiState,
} from '#app/components/settings/cards/organization/mock-payments-panel.tsx'
import { useNativeFormSaveBar } from '#app/components/use-native-form-save-bar.ts'
import {
	SHOP_PLATFORM_FEE_PERCENT,
	SHOP_PROCESSOR_CATALOG,
	getShopProcessorDefinition,
	normalizeShopProcessor,
	type ShopOrganization,
	type ShopOrderSummary,
	type ShopProcessorId,
} from '#app/utils/shop.types.ts'

type ShopCardProps = {
	organization: ShopOrganization
	orders: ShopOrderSummary[]
	ordersUnavailable?: boolean
	configuredProcessors?: ShopProcessorId[]
	/** Dev and CI only; always off in a production build. */
	paymentsMock?: PaymentsMockUiState
}

function formatMoney(cents: number, currency = 'usd') {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency,
	}).format(cents / 100)
}

export function ShopCard({
	organization,
	orders,
	ordersUnavailable = false,
	configuredProcessors = [],
	paymentsMock,
}: ShopCardProps) {
	const productFetcher = useFetcher<{
		result?: { error?: Record<string, string[] | null> | null }
	}>()
	const productFormRef = useRef<HTMLFormElement>(null)
	useNativeFormSaveBar(productFormRef, productFetcher.state !== 'idle')
	const productErrors = Object.values(productFetcher.data?.result?.error ?? {})
		.flat()
		.filter((message): message is string => Boolean(message))

	const isUsRegion = (organization.dataRegion || 'us') === 'us'
	// Outside the US only Checkout.com can take payments (Stripe Connect and
	// the hosted shop product are US only), so it is the processor shown.
	const processor = isUsRegion
		? normalizeShopProcessor(organization.shopPaymentProvider)
		: 'checkout'
	const processorDefinition = getShopProcessorDefinition(processor)
	const connectReady = Boolean(organization.stripeConnectAccountId)
	const hostedReady = Boolean(organization.polarProductId)
	const checkoutReady =
		Boolean(organization.checkoutSubEntityId) &&
		organization.checkoutChargesEnabled
	const canAcceptPayments =
		processor === 'mor'
			? hostedReady
			: processor === 'checkout'
				? checkoutReady
				: connectReady && organization.stripeConnectChargesEnabled
	const priceDollars =
		typeof organization.shopProductPriceCents === 'number'
			? (organization.shopProductPriceCents / 100).toFixed(2)
			: '19.99'
	const orgSharePercent = 100 - SHOP_PLATFORM_FEE_PERCENT
	// The name is required, so a saved product always has one. Once saved, the
	// fields show what was stored (a blank description stays blank), so the save
	// bar sees a clean form after saving.
	const productSaved = Boolean(organization.shopProductName)

	return (
		<div className="flex flex-col gap-6">
			<Card>
				<CardHeader>
					<CardTitle>
						{isUsRegion ? (
							<Trans>Site shop</Trans>
						) : (
							<Trans>Online payments</Trans>
						)}
					</CardTitle>
					<CardDescription>
						{isUsRegion ? (
							<Trans>
								Sell one product on your public site. The platform keeps{' '}
								{SHOP_PLATFORM_FEE_PERCENT}% and the rest is paid out to you.
							</Trans>
						) : (
							<Trans>
								Accept online payments for your orders. Payments are taken
								through Checkout.com and paid out to you.
							</Trans>
						)}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					<>
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant={canAcceptPayments ? 'default' : 'secondary'}>
								{canAcceptPayments ? (
									<Trans>Payments enabled</Trans>
								) : processor === 'mor' ? (
									hostedReady ? (
										<Trans>Setup incomplete</Trans>
									) : (
										<Trans>Hosted checkout not connected</Trans>
									)
								) : processor === 'checkout' ? (
									checkoutReady ? (
										<Trans>Setup incomplete</Trans>
									) : (
										<Trans>Checkout payout not connected</Trans>
									)
								) : connectReady ? (
									<Trans>Setup incomplete</Trans>
								) : (
									<Trans>Not connected</Trans>
								)}
							</Badge>
							<Badge variant="outline">{processorDefinition.shortLabel}</Badge>
							{typeof __PAYMENTS_MOCK_BUNDLED__ !== 'undefined' &&
							__PAYMENTS_MOCK_BUNDLED__ &&
							paymentsMock?.enabled ? (
								<Badge variant="warning" data-testid="mock-payments-badge">
									<Trans>Mock payments</Trans>
								</Badge>
							) : null}
							{processor === 'connect' &&
							organization.stripeConnectPayoutsEnabled ? (
								<Badge variant="outline">
									<Trans>Payouts enabled</Trans>
								</Badge>
							) : null}
						</div>

						<div className="flex flex-wrap gap-3">
							{isUsRegion ? (
								<>
									<Form method="post">
										<input type="hidden" name="intent" value="connect-payout" />
										<Button
											type="submit"
											variant={processor === 'connect' ? 'default' : 'outline'}
										>
											{connectReady ? (
												<Trans>Continue payout setup</Trans>
											) : (
												<Trans>Connect payout account</Trans>
											)}
										</Button>
									</Form>
									{connectReady ? (
										<Form method="post">
											<input
												type="hidden"
												name="intent"
												value="open-payout-dashboard"
											/>
											<Button type="submit" variant="outline">
												<Trans>Open payout dashboard</Trans>
											</Button>
										</Form>
									) : null}
								</>
							) : null}
							{configuredProcessors.includes('checkout') ? (
								<>
									<Form method="post">
										<input
											type="hidden"
											name="intent"
											value="invite-checkout-payout"
										/>
										<Button
											type="submit"
											variant={processor === 'checkout' ? 'default' : 'outline'}
										>
											{organization.checkoutSubEntityId ? (
												<Trans>Refresh Checkout setup</Trans>
											) : (
												<Trans>Invite Checkout payout contact</Trans>
											)}
										</Button>
									</Form>
									<Form method="post">
										<input
											type="hidden"
											name="intent"
											value="open-checkout-dashboard"
										/>
										<Button type="submit" variant="outline">
											<Trans>Open Checkout dashboard</Trans>
										</Button>
									</Form>
								</>
							) : null}
							{isUsRegion ? (
								<>
									{configuredProcessors.includes('mor') ? (
										<>
											<Form method="post">
												<input
													type="hidden"
													name="intent"
													value="enable-hosted-checkout"
												/>
												<Button
													type="submit"
													variant={processor === 'mor' ? 'default' : 'outline'}
												>
													{hostedReady ? (
														<Trans>Sync hosted product</Trans>
													) : (
														<Trans>Enable hosted checkout</Trans>
													)}
												</Button>
											</Form>
											<Form method="post">
												<input
													type="hidden"
													name="intent"
													value="open-hosted-dashboard"
												/>
												<Button type="submit" variant="outline">
													<Trans>Open hosted dashboard</Trans>
												</Button>
											</Form>
										</>
									) : (
										<p className="text-muted-foreground text-sm">
											<Trans>
												Hosted checkout becomes available once the platform
												configures a merchant-of-record processor.
											</Trans>
										</p>
									)}
								</>
							) : null}
						</div>

						{/* The build-time constant makes the panel (and its link to the
						    mock dashboard) dead code in the Cloudflare build, so none of it
						    ships there. Keep the check inline: it is what the bundler folds. */}
						{typeof __PAYMENTS_MOCK_BUNDLED__ !== 'undefined' &&
						__PAYMENTS_MOCK_BUNDLED__ &&
						paymentsMock?.enabled ? (
							<MockPaymentsPanel state={paymentsMock} isUsRegion={isUsRegion} />
						) : null}

						{isUsRegion ? (
							<>
								<productFetcher.Form
									ref={productFormRef}
									method="post"
									className="space-y-4 border-t pt-6"
								>
									<input
										type="hidden"
										name="intent"
										value="update-shop-product"
									/>

									<fieldset className="space-y-2">
										<legend className="text-sm font-medium">
											<Trans>Checkout processor</Trans>
										</legend>
										<div className="flex flex-wrap gap-4 text-sm">
											{SHOP_PROCESSOR_CATALOG.map((option) => (
												<label
													key={option.id}
													className="flex items-center gap-2"
												>
													<input
														type="radio"
														name="paymentProcessor"
														value={option.id}
														defaultChecked={processor === option.id}
														disabled={!configuredProcessors.includes(option.id)}
													/>
													{option.label}
												</label>
											))}
										</div>
										<p className="text-muted-foreground text-xs">
											{processorDefinition.checkoutDescription}
										</p>
									</fieldset>

									<div className="space-y-2">
										<Label htmlFor="productName">
											<Trans>Product name</Trans>
										</Label>
										<Input
											id="productName"
											name="productName"
											defaultValue={
												organization.shopProductName || 'Starter pack'
											}
											required
										/>
									</div>

									<div className="space-y-2">
										<Label htmlFor="productDescription">
											<Trans>Description</Trans>
										</Label>
										<Textarea
											id="productDescription"
											name="productDescription"
											rows={3}
											defaultValue={
												productSaved
													? (organization.shopProductDescription ?? '')
													: 'A simple offering for your customers.'
											}
										/>
									</div>

									<div className="space-y-2">
										<Label htmlFor="priceDollars">
											<Trans>Price (USD)</Trans>
										</Label>
										<Input
											id="priceDollars"
											name="priceDollars"
											type="number"
											min="0.5"
											step="0.01"
											defaultValue={priceDollars}
											required
										/>
										<p className="text-muted-foreground text-xs">
											<Trans>
												Customers pay this amount. You receive {orgSharePercent}
												% after the platform fee.
											</Trans>
										</p>
									</div>

									<label className="flex items-center gap-2 text-sm">
										<input
											type="checkbox"
											name="enabled"
											defaultChecked={organization.shopEnabled}
											className="border-input size-4 rounded"
										/>
										<Trans>Show product on your public site</Trans>
									</label>

									{productErrors.length > 0 ? (
										<p role="alert" className="text-destructive text-sm">
											{productErrors.join(' ')}
										</p>
									) : null}
								</productFetcher.Form>

								{organization.sitePublished ? (
									<p className="text-muted-foreground text-sm">
										<Trans>
											Your customers can buy at{' '}
											<code className="bg-muted rounded px-1">/shop</code> on
											your published site once payments are enabled.
										</Trans>
									</p>
								) : (
									<p className="text-sm text-amber-700 dark:text-amber-400">
										<Trans>
											Publish your site before sharing the shop link with
											customers.
										</Trans>
									</p>
								)}
							</>
						) : null}
					</>
				</CardContent>
			</Card>

			{isUsRegion && (ordersUnavailable || orders.length > 0) ? (
				<Card>
					<CardHeader>
						<CardTitle>
							<Trans>Recent orders</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>Orders placed on your public site.</Trans>
						</CardDescription>
					</CardHeader>
					<CardContent>
						{ordersUnavailable ? (
							<p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
								<Trans>
									Orders are unavailable right now. Your shop settings are still
									saved; try again later.
								</Trans>
							</p>
						) : (
							<ul className="divide-y rounded-lg border">
								{orders.map((order) => (
									<li
										key={order.id}
										className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
									>
										<div>
											<p className="font-medium">{order.productName}</p>
											{order.customerName || order.customerPhone ? (
												<p className="text-muted-foreground">
													{order.customerName}
													{order.customerName && order.customerPhone
														? ' · '
														: null}
													{order.customerPhone}
												</p>
											) : (
												<p className="text-muted-foreground">
													<Trans>Guest checkout</Trans>
												</p>
											)}
											<p className="text-muted-foreground">
												{order.status}
												{order.paymentProvider
													? ` · ${normalizeShopProcessor(order.paymentProvider)}`
													: ''}{' '}
												·{' '}
												{order.createdAt
													? new Date(order.createdAt).toLocaleString()
													: ''}
											</p>
										</div>
										<div className="text-right">
											<p>{formatMoney(order.amountCents, order.currency)}</p>
											<p className="text-muted-foreground text-xs">
												<Trans>You receive</Trans>{' '}
												{formatMoney(order.orgPayoutCents, order.currency)}
											</p>
										</div>
									</li>
								))}
							</ul>
						)}
					</CardContent>
				</Card>
			) : null}
		</div>
	)
}
