import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import {
	explainOrderMoney,
	type OrderMoneyOrderType,
	type OrderMoneyPaymentMethod,
} from '@repo/common/order-money'
import {
	serviceFeeSettingsSchema,
	type ServiceFeeSettings,
} from '@repo/common/service-fee'
import { db, eq, OrganizationLocation } from '@repo/database'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Separator } from '@repo/ui/separator'
import { useMemo, useState } from 'react'
import {
	type LoaderFunctionArgs,
	useLoaderData,
	useSearchParams,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

type LocationCalculatorConfig = {
	id: string
	name: string
	currency: string
	taxRateBp: number
	pricesIncludeTax: boolean
	serviceFee: ServiceFeeSettings | null
	deliveryFeeCents: number
}

function parseServiceFee(raw: string | null): ServiceFeeSettings | null {
	if (!raw) return null
	try {
		const parsed = serviceFeeSettingsSchema.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		dataRegion: true,
		shopPaymentProvider: true,
	})
	const userId = await requireUserId(request)
	const canView =
		(await userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.READ_PAYMENTS_ANY,
		)) ||
		(await userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.READ_SETTINGS_ANY,
		))
	if (!canView) {
		throw new Response('Forbidden', { status: 403 })
	}

	const rows = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			taxRate: OrganizationLocation.taxRate,
			taxInclusive: OrganizationLocation.taxInclusive,
			serviceFee: OrganizationLocation.serviceFee,
			deliveryZones: OrganizationLocation.deliveryZones,
		})
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))

	const locations: LocationCalculatorConfig[] = rows.map((row) => {
		let deliveryFeeCents = 0
		if (row.deliveryZones) {
			try {
				const parsed = JSON.parse(row.deliveryZones) as Array<{
					fee?: number
					deliveryFeeCents?: number
				}>
				if (Array.isArray(parsed) && parsed.length > 0) {
					const first = parsed[0]
					if (typeof first?.deliveryFeeCents === 'number') {
						deliveryFeeCents = first.deliveryFeeCents
					} else if (typeof first?.fee === 'number') {
						deliveryFeeCents = Math.round(first.fee * 100)
					}
				}
			} catch {
				deliveryFeeCents = 0
			}
		}
		return {
			id: row.id,
			name: row.name,
			currency: organization.dataRegion === 'ksa' ? 'SAR' : 'USD',
			taxRateBp: Math.round((row.taxRate ?? 0) * 100),
			pricesIncludeTax: Boolean(row.taxInclusive),
			serviceFee: parseServiceFee(row.serviceFee),
			deliveryFeeCents,
		}
	})

	// Standard processor rate estimates for the organization's region/provider.
	const isKsa = organization.dataRegion === 'ksa'
	const rates = isKsa
		? { cardProcessingBp: 250, cardProcessingFixedCents: 100, platformFeeBp: 0 }
		: { cardProcessingBp: 290, cardProcessingFixedCents: 30, platformFeeBp: 0 }

	return {
		organization,
		locations,
		rates,
	}
}

function formatMoney(cents: number, currency: string, locale: string) {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: currency || 'USD',
	}).format(cents / 100)
}

export default function PaymentsCalculatorRoute() {
	const { locations, rates } = useLoaderData<typeof loader>()
	const [searchParams] = useSearchParams()
	const { _, i18n } = useLingui()

	const initialLocationId =
		searchParams.get('locationId') ?? locations[0]?.id ?? ''
	const initialAmount = searchParams.get('amount') ?? '40.00'
	const initialOrderType = ((): OrderMoneyOrderType => {
		const raw = searchParams.get('orderType')
		if (raw === 'delivery' || raw === 'in_store' || raw === 'pickup') return raw
		return 'pickup'
	})()
	const initialPaymentMethod = ((): OrderMoneyPaymentMethod => {
		const raw = searchParams.get('paymentMethod')
		return raw === 'cash' ? 'cash' : 'card'
	})()
	const initialTip = searchParams.get('tip') ?? '0.00'

	const [locationId, setLocationId] = useState(initialLocationId)
	const [amountText, setAmountText] = useState(initialAmount)
	const [orderType, setOrderType] =
		useState<OrderMoneyOrderType>(initialOrderType)
	const [paymentMethod, setPaymentMethod] =
		useState<OrderMoneyPaymentMethod>(initialPaymentMethod)
	const [tipText, setTipText] = useState(initialTip)

	const activeLocation =
		locations.find((loc) => loc.id === locationId) ?? locations[0] ?? null

	const subtotalCents = Math.max(
		0,
		Math.round((Number.parseFloat(amountText) || 0) * 100),
	)
	const tipCents = Math.max(
		0,
		Math.round((Number.parseFloat(tipText) || 0) * 100),
	)

	const explanation = useMemo(() => {
		const currency = activeLocation?.currency ?? 'USD'
		return explainOrderMoney(
			{
				subtotalCents,
				orderType,
				paymentMethod,
				tipCents,
			},
			{
				currency,
				taxRateBp: activeLocation?.taxRateBp ?? 0,
				pricesIncludeTax: activeLocation?.pricesIncludeTax ?? false,
				serviceFee: activeLocation?.serviceFee ?? null,
				deliveryFeeCents: activeLocation?.deliveryFeeCents ?? 0,
			},
			rates,
		)
	}, [activeLocation, subtotalCents, orderType, paymentMethod, tipCents, rates])

	const money = (cents: number) =>
		formatMoney(cents, explanation.currency, i18n.locale)

	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<div className="flex flex-col gap-6" data-testid="what-you-get-paid">
					<Card>
						<CardHeader>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<CardTitle>
									<Trans>What you get paid</Trans>
								</CardTitle>
								<Badge variant="outline">
									<Trans>Estimates only</Trans>
								</Badge>
							</div>
							<CardDescription>
								<Trans>
									At this location&apos;s current rates. Subscription is billed
									separately.
								</Trans>
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-6">
							<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
								{locations.length > 0 ? (
									<div className="space-y-1.5">
										<Label htmlFor="calc-location">
											<Trans>Location</Trans>
										</Label>
										<select
											id="calc-location"
											className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm"
											value={locationId}
											onChange={(e) => setLocationId(e.target.value)}
										>
											{locations.map((loc) => (
												<option key={loc.id} value={loc.id}>
													{loc.name}
												</option>
											))}
										</select>
									</div>
								) : null}

								<div className="space-y-1.5">
									<Label htmlFor="calc-amount">
										<Trans>Order subtotal</Trans>
									</Label>
									<Input
										id="calc-amount"
										type="number"
										min="0"
										step="0.01"
										value={amountText}
										onChange={(e) => setAmountText(e.target.value)}
									/>
								</div>

								<div className="space-y-1.5">
									<Label htmlFor="calc-order-type">
										<Trans>Order type</Trans>
									</Label>
									<select
										id="calc-order-type"
										className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm"
										value={orderType}
										onChange={(e) =>
											setOrderType(e.target.value as OrderMoneyOrderType)
										}
									>
										<option value="pickup">{_(msg`Pickup`)}</option>
										<option value="delivery">{_(msg`Delivery`)}</option>
										<option value="in_store">{_(msg`In store`)}</option>
									</select>
								</div>

								<div className="space-y-1.5">
									<Label htmlFor="calc-payment-method">
										<Trans>Payment method</Trans>
									</Label>
									<select
										id="calc-payment-method"
										className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-sm"
										value={paymentMethod}
										onChange={(e) =>
											setPaymentMethod(
												e.target.value as OrderMoneyPaymentMethod,
											)
										}
									>
										<option value="card">{_(msg`Card`)}</option>
										<option value="cash">{_(msg`Cash`)}</option>
									</select>
								</div>

								<div className="space-y-1.5">
									<Label htmlFor="calc-tip">
										<Trans>Tip</Trans>
									</Label>
									<Input
										id="calc-tip"
										type="number"
										min="0"
										step="0.01"
										value={tipText}
										onChange={(e) => setTipText(e.target.value)}
									/>
								</div>
							</div>

							<div className="grid gap-6 md:grid-cols-2">
								<div
									className="space-y-3 rounded-lg border p-4"
									data-testid="calculator-guest-column"
								>
									<h2 className="text-base font-semibold">
										<Trans>What the guest pays</Trans>
									</h2>
									<dl className="space-y-2 text-sm">
										{explanation.guest.lines.map((line) => (
											<div
												key={line.kind}
												className="flex items-center justify-between gap-2"
											>
												<dt className="text-muted-foreground">{line.label}</dt>
												<dd className="tabular-nums">
													<bdi>{money(line.amountCents)}</bdi>
												</dd>
											</div>
										))}
									</dl>
									<Separator />
									<div className="flex items-center justify-between text-base font-semibold">
										<span>
											<Trans>Guest total</Trans>
										</span>
										<span
											className="tabular-nums"
											data-testid="calculator-guest-total"
										>
											<bdi>{money(explanation.guest.totalCents)}</bdi>
										</span>
									</div>
								</div>

								<div
									className="space-y-3 rounded-lg border p-4"
									data-testid="calculator-restaurant-column"
								>
									<h2 className="text-base font-semibold">
										<Trans>What you receive</Trans>
									</h2>
									<dl className="space-y-2 text-sm">
										{explanation.restaurant.lines.map((line) => (
											<div
												key={line.kind}
												className="flex items-center justify-between gap-2"
											>
												<dt className="text-muted-foreground">{line.label}</dt>
												<dd className="tabular-nums">
													<bdi>{money(line.amountCents)}</bdi>
												</dd>
											</div>
										))}
									</dl>
									<Separator />
									<div className="flex items-center justify-between text-base font-semibold">
										<span>
											<Trans>Estimated payout</Trans>
										</span>
										<span
											className="tabular-nums"
											data-testid="calculator-restaurant-payout"
										>
											<bdi>{money(explanation.restaurant.netPayoutCents)}</bdi>
										</span>
									</div>
								</div>
							</div>

							<p className="text-muted-foreground text-xs">
								<Trans>
									Estimates only. Card type (international, corporate, or
									manually entered cards) can change the processing fee.
								</Trans>
							</p>
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
