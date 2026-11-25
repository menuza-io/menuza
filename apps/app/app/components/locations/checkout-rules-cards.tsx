'use client'

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	ALCOHOL_MINIMUM_AGE,
	type AlcoholOnline,
} from '@repo/common/alcohol-rules'
import {
	PACKAGING_FEE_FULFILLMENTS,
	PACKAGING_FEE_LABEL_MAX_LENGTH,
	DEFAULT_PACKAGING_FEE_LABEL,
} from '@repo/common/packaging-fee'
import { PICKUP_INSTRUCTIONS_MAX_LENGTH } from '@repo/common/pickup-instructions'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	type OrderCapsFormValues,
	type PackagingFeeFormValues,
	type PickupInstructionsForm,
} from '#app/utils/orders/checkout-rules-settings.ts'
import { type LargeOrderFormFields } from '#app/utils/orders/ordering-settings.ts'

export function PickupInstructionsCard({
	locales,
	activeLocale,
	onLocaleChange,
	values,
	onChange,
}: {
	locales: string[]
	activeLocale: string
	onLocaleChange: (locale: string) => void
	values: PickupInstructionsForm
	onChange: (next: PickupInstructionsForm) => void
}) {
	const setLocale = (text: string) =>
		onChange({
			...values,
			[activeLocale]: text.slice(0, PICKUP_INSTRUCTIONS_MAX_LENGTH),
		})
	return (
		<Card data-testid="pickup-instructions-card">
			<CardHeader>
				<CardTitle>
					<Trans>Pickup instructions</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Plain text guests see at pickup checkout and on the confirmation
						page. Line breaks are kept.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{locales.length > 1 ? (
					<Tabs value={activeLocale} onValueChange={onLocaleChange}>
						<TabsList>
							{locales.map((locale) => (
								<TabsTrigger key={locale} value={locale}>
									{locale.toUpperCase()}
								</TabsTrigger>
							))}
						</TabsList>
						{locales.map((locale) => (
							<TabsContent key={locale} value={locale} className="mt-3">
								<Textarea
									dir="auto"
									maxLength={PICKUP_INSTRUCTIONS_MAX_LENGTH}
									value={values[locale] ?? ''}
									onChange={(e) => setLocale(e.target.value)}
								/>
							</TabsContent>
						))}
					</Tabs>
				) : (
					<Textarea
						dir="auto"
						maxLength={PICKUP_INSTRUCTIONS_MAX_LENGTH}
						value={values[activeLocale] ?? ''}
						onChange={(e) => setLocale(e.target.value)}
					/>
				)}
			</CardContent>
		</Card>
	)
}

export function UtensilsCheckoutCard({
	enabled,
	defaultRequested,
	onChange,
}: {
	enabled: boolean
	defaultRequested: boolean
	onChange: (next: { enabled: boolean; defaultRequested: boolean }) => void
}) {
	return (
		<Card data-testid="utensils-card">
			<CardHeader>
				<CardTitle>
					<Trans>Utensils and napkins</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Ask on pickup and delivery checkout. Table and QR orders are never
						asked.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex items-center justify-between gap-3">
					<Label htmlFor="utensils-enabled">
						<Trans>Ask guests</Trans>
					</Label>
					<Switch
						id="utensils-enabled"
						checked={enabled}
						onCheckedChange={(c) => onChange({ enabled: c, defaultRequested })}
					/>
				</div>
				{enabled ? (
					<div className="flex items-center justify-between gap-3">
						<Label htmlFor="utensils-default">
							<Trans>Default checkbox</Trans>
						</Label>
						<Switch
							id="utensils-default"
							checked={defaultRequested}
							onCheckedChange={(c) =>
								onChange({ enabled: true, defaultRequested: c })
							}
						/>
						<span className="text-muted-foreground text-xs">
							{defaultRequested ? (
								<Trans>Yes, include utensils</Trans>
							) : (
								<Trans>No utensils</Trans>
							)}
						</span>
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}

export function OrderCapsCard({
	currency,
	values,
	onChange,
}: {
	currency: string
	values: OrderCapsFormValues
	onChange: (next: OrderCapsFormValues) => void
}) {
	const set = (patch: Partial<OrderCapsFormValues>) =>
		onChange({ ...values, ...patch })
	return (
		<Card data-testid="order-caps-card">
			<CardHeader>
				<CardTitle>
					<Trans>Order size limits</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Refuse oversized regular orders online. Leave blank for no cap.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4 sm:grid-cols-2">
				<TextField
					id="cap-pickup-amount"
					label={<Trans>Pickup max subtotal ({currency})</Trans>}
					optional
					type="text"
					inputMode="decimal"
					dir="ltr"
					value={values.pickupMaxSubtotal}
					onChange={(e) => set({ pickupMaxSubtotal: e.target.value })}
				/>
				<TextField
					id="cap-delivery-amount"
					label={<Trans>Delivery max subtotal ({currency})</Trans>}
					optional
					type="text"
					inputMode="decimal"
					dir="ltr"
					value={values.deliveryMaxSubtotal}
					onChange={(e) => set({ deliveryMaxSubtotal: e.target.value })}
				/>
				<TextField
					id="cap-dine-guests"
					label={<Trans>Dine-in max guests</Trans>}
					optional
					type="text"
					inputMode="numeric"
					dir="ltr"
					value={values.dineInMaxGuests}
					onChange={(e) => set({ dineInMaxGuests: e.target.value })}
				/>
			</CardContent>
		</Card>
	)
}

export function PackagingFeeCard({
	currency,
	values,
	onChange,
}: {
	currency: string
	values: PackagingFeeFormValues
	onChange: (next: PackagingFeeFormValues) => void
}) {
	const { _ } = useLingui()
	const set = (patch: Partial<PackagingFeeFormValues>) =>
		onChange({ ...values, ...patch })
	const modeOptions = [
		{ value: 'per_order', label: _(msg`Per order`) },
		{ value: 'per_item', label: _(msg`Per item`) },
	]
	return (
		<Card data-testid="packaging-fee-card">
			<CardHeader>
				<CardTitle>
					<Trans>Packaging fee</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Bag or packaging charge on takeaway and delivery. Not applied to
						dine-in.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex items-center justify-between gap-3">
					<Label htmlFor="packaging-enabled">
						<Trans>Charge a packaging fee</Trans>
					</Label>
					<Switch
						id="packaging-enabled"
						checked={values.enabled}
						onCheckedChange={(c) => set({ enabled: c })}
					/>
				</div>
				{values.enabled ? (
					<div className="space-y-4">
						<SelectField
							id="packaging-mode"
							label={<Trans>Charge</Trans>}
							options={modeOptions}
							value={values.mode}
							onValueChange={(v) =>
								v && set({ mode: v as PackagingFeeFormValues['mode'] })
							}
						/>
						<TextField
							id="packaging-amount"
							label={<Trans>Amount ({currency})</Trans>}
							type="text"
							inputMode="decimal"
							dir="ltr"
							value={values.amount}
							onChange={(e) => set({ amount: e.target.value })}
						/>
						<fieldset className="space-y-2">
							<legend className="text-sm font-medium">
								<Trans>Applies to</Trans>
							</legend>
							<div className="flex flex-wrap gap-3">
								{PACKAGING_FEE_FULFILLMENTS.map((key) => (
									<label
										key={key}
										className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2"
									>
										<Checkbox
											checked={
												key === 'pickup' ? values.pickup : values.delivery
											}
											onCheckedChange={(c) =>
												set({
													[key]: c === true,
												} as Partial<PackagingFeeFormValues>)
											}
										/>
										<span className="text-xs font-medium">
											{key === 'pickup' ? (
												<Trans>Pickup</Trans>
											) : (
												<Trans>Delivery</Trans>
											)}
										</span>
									</label>
								))}
							</div>
						</fieldset>
						<TextField
							id="packaging-label"
							label={<Trans>Name guests see</Trans>}
							maxLength={PACKAGING_FEE_LABEL_MAX_LENGTH}
							value={values.label}
							placeholder={DEFAULT_PACKAGING_FEE_LABEL}
							onChange={(e) => set({ label: e.target.value })}
						/>
						<div className="flex items-center justify-between gap-3">
							<Label htmlFor="packaging-taxable">
								<Trans>Charge tax on the fee</Trans>
							</Label>
							<Switch
								id="packaging-taxable"
								checked={values.taxable}
								onCheckedChange={(c) => set({ taxable: c })}
							/>
						</div>
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}
/**
 * Large orders (#355): "When an order has more than N items or is over AMOUNT,
 * add M minutes." Either threshold may be empty; whichever is reached first
 * applies. Sits inside the preparation time card.
 */
export function LargeOrderFields({
	values,
	currency,
	onChange,
}: {
	values: LargeOrderFormFields
	/** The location's currency code; unknown while a new location is set up. */
	currency: string | null
	onChange: (patch: Partial<LargeOrderFormFields>) => void
}) {
	return (
		<div
			className="bg-muted/30 space-y-3 rounded-md border p-3"
			data-testid="large-orders-fields"
		>
			<div>
				<h4 className="text-sm font-medium">
					<Trans>Large orders</Trans>
				</h4>
				<p className="text-muted-foreground text-xs">
					<Trans>
						When an order has more than this many items, or is over this amount,
						add extra minutes to its ready time. Leave one empty to use only the
						other. Dishes that do not count toward order limits are left out of
						the item count.
					</Trans>
				</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-3">
				<TextField
					id="large-order-items"
					label={<Trans>More than (items)</Trans>}
					optional
					type="text"
					inputMode="numeric"
					dir="ltr"
					value={values.largeOrderItems}
					onChange={(e) => onChange({ largeOrderItems: e.target.value })}
				/>
				<TextField
					id="large-order-amount"
					label={
						currency ? (
							<Trans>Or over ({currency})</Trans>
						) : (
							<Trans>Or over (amount)</Trans>
						)
					}
					optional
					type="text"
					inputMode="decimal"
					dir="ltr"
					value={values.largeOrderAmount}
					onChange={(e) => onChange({ largeOrderAmount: e.target.value })}
				/>
				<TextField
					id="large-order-minutes"
					label={<Trans>Add (minutes)</Trans>}
					type="text"
					inputMode="numeric"
					dir="ltr"
					value={values.largeOrderMinutes}
					onChange={(e) => onChange({ largeOrderMinutes: e.target.value })}
				/>
			</div>
		</div>
	)
}

/**
 * Where alcohol may be ordered online (#167). Hidden in KSA, where alcohol is
 * always refused online. `reviewed` is false until the owner has saved a
 * choice: until then the location behaves as before and a banner asks for a
 * review.
 */
export function AlcoholCard({
	value,
	reviewed,
	onChange,
}: {
	value: AlcoholOnline
	reviewed: boolean
	onChange: (next: AlcoholOnline) => void
}) {
	const { _ } = useLingui()
	const options = [
		{
			value: 'pickup_and_delivery',
			label: _(msg`Allow for pickup and delivery`),
		},
		{ value: 'pickup', label: _(msg`Allow for pickup only`) },
		{ value: 'delivery', label: _(msg`Allow for delivery only`) },
		{ value: 'none', label: _(msg`Not online`) },
	]
	return (
		<Card data-testid="alcohol-card">
			<CardHeader>
				<CardTitle>
					<Trans>Alcohol</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Items marked as alcohol are refused for order types you do not
						allow. When alcohol is in the cart the guest confirms they are{' '}
						{ALCOHOL_MINIMUM_AGE} or older and will show ID, and tickets say
						Check ID. Delivery apps and couriers never carry alcohol.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{reviewed ? null : (
					<p
						role="note"
						className="notice-warning rounded-md px-3 py-2 text-sm"
						data-testid="alcohol-review-banner"
					>
						<Trans>
							Alcohol is allowed for pickup and delivery here, as it was before
							this setting existed. Please review it and save your choice.
						</Trans>
					</p>
				)}
				<SelectField
					id="alcohol-online"
					label={<Trans>Alcohol online</Trans>}
					options={options}
					value={value}
					onValueChange={(v) => v && onChange(v as AlcoholOnline)}
				/>
			</CardContent>
		</Card>
	)
}

/** The location's Google review link, printed as a code on receipts (#263). */
export function GoogleReviewCard({
	value,
	onChange,
	error,
}: {
	value: string
	onChange: (next: string) => void
	error?: string | null
}) {
	return (
		<Card data-testid="google-review-card">
			<CardHeader>
				<CardTitle>
					<Trans>Google review link</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Receipts can print a code that opens this page ("Enjoyed it? Tell
						us"). Without a link, no review code is printed for this location.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<TextField
					id="google-review-url"
					label={<Trans>Review link</Trans>}
					optional
					type="url"
					dir="ltr"
					placeholder="https://g.page/r/…/review"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					error={error ?? undefined}
				/>
			</CardContent>
		</Card>
	)
}
