import { Trans, Plural } from '@lingui/macro'
import { type Organization } from '@repo/database/types'

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
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemTitle,
} from '@repo/ui/item'
import { useState, useEffect } from 'react'
import { Form, Link } from 'react-router'
import { type getPlansAndPrices } from '#app/utils/payments.server.ts'

const PLANS = {
	Base: {
		name: 'Base plan',
		seats: 3,
		price: 7.99,
		additionalSeatPrice: 4.99,
	},
	Plus: {
		name: 'Plus plan',
		seats: 5,
		price: 49.99,
		additionalSeatPrice: 9.99,
	},
}

type BillingCardProps = {
	organization: Pick<
		Organization,
		| 'id'
		| 'name'
		| 'slug'
		| 'stripeCustomerId'
		| 'stripeSubscriptionId'
		| 'stripeProductId'
		| 'planName'
		| 'subscriptionStatus'
	> & {
		_count?: {
			users: number
		}
	}
	plansAndPrices?: Awaited<ReturnType<typeof getPlansAndPrices>> | null
	isClosedBeta?: boolean
}

export function BillingCard({
	organization,
	plansAndPrices,
	isClosedBeta,
	currentPriceId,
}: BillingCardProps & { currentPriceId?: string | null }) {
	const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>(
		'monthly',
	)

	// Update billing interval when data becomes available
	useEffect(() => {
		if (currentPriceId && plansAndPrices) {
			const isYearly =
				currentPriceId === plansAndPrices.prices.base?.yearly?.id ||
				currentPriceId === plansAndPrices.prices.plus?.yearly?.id

			setBillingInterval(isYearly ? 'yearly' : 'monthly')
		}
	}, [currentPriceId, plansAndPrices])

	if (isClosedBeta) {
		return (
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Billing & Subscription</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Manage your restaurant's subscription</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="py-8 text-center">
						<div className="mb-4">
							<Badge variant="secondary" className="text-sm">
								<Trans>Beta Access</Trans>
							</Badge>
						</div>
						<p className="text-muted-foreground">
							<Trans>
								You are covered during our beta phase. No billing required at
								this time.
							</Trans>
						</p>
					</div>
				</CardContent>
			</Card>
		)
	}

	return (
		<div className="space-y-6">
			{/* Current Subscription Status */}
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Current Subscription</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Your restaurant's current plan and billing status</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="p-0">
					<Item>
						<ItemContent>
							<ItemTitle className="flex flex-wrap items-center gap-2 text-lg font-medium">
								{organization.planName || 'Free Plan'}
								{organization.subscriptionStatus && (
									<Badge
										variant={
											organization.subscriptionStatus === 'active'
												? 'default'
												: organization.subscriptionStatus === 'trialing'
													? 'secondary'
													: 'destructive'
										}
									>
										{organization.subscriptionStatus === 'active'
											? 'Active'
											: organization.subscriptionStatus === 'trialing'
												? 'Trial'
												: organization.subscriptionStatus}
									</Badge>
								)}
							</ItemTitle>
							<ItemDescription>
								{organization.subscriptionStatus === 'active' ? (
									<Trans>Billed monthly</Trans>
								) : organization.subscriptionStatus === 'trialing' ? (
									<Trans>Trial period active</Trans>
								) : organization.stripeCustomerId ? (
									<Trans>Subscription inactive</Trans>
								) : (
									<Trans>No active subscription</Trans>
								)}
							</ItemDescription>
							{organization._count?.users && (
								<ItemDescription className="text-sm">
									<Plural
										value={organization._count.users}
										one="# active member"
										other="# active members"
									/>
								</ItemDescription>
							)}
						</ItemContent>
						<ItemActions className="flex flex-wrap justify-end gap-2">
							{organization.stripeCustomerId ? (
								<Form method="post">
									<input type="hidden" name="intent" value="customer-portal" />
									<Button type="submit" variant="outline">
										<Trans>Manage Subscription</Trans>
									</Button>
								</Form>
							) : (
								<Button>
									<Link to={`/pricing?orgSlug=${organization.slug}`}>
										<Trans>Subscribe</Trans>
									</Link>
								</Button>
							)}
						</ItemActions>
					</Item>
				</CardContent>
			</Card>

			{/* Billing Interval Toggle */}
			{plansAndPrices && (
				<div className="flex items-center justify-end">
					<div className="bg-muted flex items-center space-x-2 rounded-lg p-1">
						<button
							type="button"
							onClick={() => setBillingInterval('monthly')}
							className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
								billingInterval === 'monthly'
									? 'bg-background text-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							<Trans>Monthly</Trans>
						</button>
						<button
							type="button"
							onClick={() => setBillingInterval('yearly')}
							className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
								billingInterval === 'yearly'
									? 'bg-background text-foreground shadow-sm'
									: 'text-muted-foreground hover:text-foreground'
							}`}
						>
							<Trans>Yearly</Trans>
							<Badge variant="default" className="ml-2 text-xs">
								<Trans>Save 20%</Trans>
							</Badge>
						</button>
					</div>
				</div>
			)}

			{/* Available Plans */}
			{plansAndPrices ? (
				<div className="grid gap-6 lg:grid-cols-2">
					<PricingPlan
						title={PLANS.Base.name}
						stripePrice={plansAndPrices.prices.base?.[billingInterval]}
						includesSeats={PLANS.Base.seats}
						billingInterval={billingInterval}
						currentPlan={
							currentPriceId ===
							plansAndPrices?.prices.base?.[billingInterval]?.id
						}
						priceId={plansAndPrices?.prices.base?.[billingInterval]?.id}
					/>
					<PricingPlan
						title={PLANS.Plus.name}
						stripePrice={plansAndPrices.prices.plus?.[billingInterval]}
						includesSeats={PLANS.Plus.seats}
						billingInterval={billingInterval}
						currentPlan={
							currentPriceId ===
							plansAndPrices?.prices.plus?.[billingInterval]?.id
						}
						priceId={plansAndPrices?.prices.plus?.[billingInterval]?.id}
					/>
				</div>
			) : (
				<Card>
					<CardContent className="p-6">
						<div className="text-muted-foreground text-center">
							<p>
								<Trans>Unable to load pricing information</Trans>
							</p>
							<p className="text-sm">
								<Trans>
									Please check your Stripe configuration or try again later
								</Trans>
							</p>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Enterprise Plan */}
			<Card>
				<CardContent className="p-0">
					<Item>
						<ItemContent>
							<ItemTitle className="text-base">
								<Trans>Enterprise Plan</Trans>
							</ItemTitle>
							<ItemDescription>
								<Trans>
									Single sign-on, custom SLA, private support channel, and more.{' '}
									<Link to="/contact" className="text-primary hover:underline">
										Learn more
									</Link>
								</Trans>
							</ItemDescription>
						</ItemContent>
						<ItemActions>
							<Button variant="outline">
								<Link to="/contact?subject=Enterprise">
									<Trans>Schedule a call</Trans>
								</Link>
							</Button>
						</ItemActions>
					</Item>
				</CardContent>
			</Card>

			{/* Help Section */}
			<Card>
				<CardContent className="p-0">
					<Item>
						<ItemContent>
							<ItemTitle className="text-muted-foreground text-sm font-medium">
								<Trans>Questions about billing?</Trans>
							</ItemTitle>
						</ItemContent>
						<ItemActions>
							<Button variant="link" className="text-sm">
								<Link to="/support">
									<Trans>Get in touch</Trans>
								</Link>
							</Button>
						</ItemActions>
					</Item>
				</CardContent>
			</Card>
		</div>
	)
}

function PricingPlan({
	title,
	stripePrice,
	includesSeats,
	billingInterval,
	currentPlan,
	priceId,
}: {
	title: string
	stripePrice?: {
		id: string
		productId: string
		unitAmount: number | null
		currency: string
		interval: string | null | undefined
		trialPeriodDays: number | null | undefined
		tiers?: Array<{
			flat_amount: number | null
			unit_amount: number | null
			up_to: number | null
		}>
	}
	includesSeats: number
	billingInterval: 'monthly' | 'yearly'
	currentPlan?: boolean
	priceId?: string
}) {
	if (!stripePrice) {
		return (
			<Card>
				<CardContent className="p-6">
					<div className="text-muted-foreground text-center">
						<p>
							<Trans>Pricing not available</Trans>
						</p>
						<p className="text-sm">
							<Trans>Please check your Stripe configuration</Trans>
						</p>
					</div>
				</CardContent>
			</Card>
		)
	}

	// Handle tiered pricing - get the base price from the first tier's flat_amount
	let basePrice = 0
	let additionalUserPrice = 0

	if (stripePrice.unitAmount) {
		// Standard pricing
		basePrice = stripePrice.unitAmount / 100
	} else if (
		(stripePrice as any).tiers &&
		(stripePrice as any).tiers.length > 0
	) {
		// Tiered pricing - use the first tier's flat_amount
		const firstTier = (stripePrice as any).tiers[0]
		const secondTier = (stripePrice as any).tiers[1]

		if (firstTier?.flat_amount) {
			basePrice = firstTier.flat_amount / 100
		}

		// Get additional user pricing from second tier
		if (secondTier?.unit_amount) {
			additionalUserPrice = secondTier.unit_amount / 100
		}
	}

	if (basePrice === 0) {
		return (
			<Card>
				<CardContent className="p-6">
					<div className="text-muted-foreground text-center">
						<p>
							<Trans>Price not configured</Trans>
						</p>
						<p className="text-sm">
							<Trans>Contact support for pricing</Trans>
						</p>
					</div>
				</CardContent>
			</Card>
		)
	}

	const displayPrice = billingInterval === 'yearly' ? basePrice / 12 : basePrice

	const basePriceValue = basePrice.toFixed(2)
	const includesSeatsValue = includesSeats
	const monthlyPrice =
		billingInterval === 'yearly'
			? (additionalUserPrice / 12).toFixed(2)
			: additionalUserPrice.toFixed(2)
	const annualPrice = additionalUserPrice.toFixed(2)

	return (
		<Card className={currentPlan ? 'ring-primary ring-2' : ''}>
			<CardHeader>
				<div className="flex items-baseline gap-2">
					<CardTitle className="text-2xl font-bold">
						${displayPrice.toFixed(2)}
					</CardTitle>
					<span className="text-muted-foreground text-sm">
						<Trans>per month</Trans>
					</span>
				</div>
				{billingInterval === 'yearly' && (
					<div className="text-muted-foreground text-sm">
						<Trans>${basePriceValue} billed annually</Trans>
					</div>
				)}
				<CardDescription>{title}</CardDescription>
			</CardHeader>
			<CardContent>
				<ul className="text-muted-foreground mb-4 space-y-2 text-sm">
					<li>
						<Trans>Includes {includesSeatsValue} user seats</Trans>
					</li>
					{additionalUserPrice > 0 && (
						<li>
							<Trans>Additional users: ${monthlyPrice}/user/month</Trans>
							{billingInterval === 'yearly' && (
								<span className="block text-xs opacity-75">
									<Trans>(${annualPrice} billed annually per user)</Trans>
								</span>
							)}
						</li>
					)}
				</ul>

				<Form method="post">
					<input type="hidden" name="intent" value="upgrade" />
					<input type="hidden" name="priceId" value={priceId} />
					<Button
						disabled={currentPlan}
						variant={currentPlan ? 'outline' : 'default'}
						type="submit"
						className="w-full"
					>
						{currentPlan ? (
							<>
								<Icon name="check" className="h-4 w-4" />{' '}
								<Trans>Current Plan</Trans>
							</>
						) : (
							<Trans>Upgrade</Trans>
						)}
					</Button>
				</Form>
			</CardContent>
		</Card>
	)
}
