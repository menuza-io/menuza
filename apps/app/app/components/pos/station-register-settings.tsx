import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CASH_DISCOUNT_MAX_BP } from '@repo/common/cash-discount'
import {
	POS_CUSTOM_ITEMS_MODES,
	POS_GUEST_DETAILS_MODES,
	type PosCustomItemsMode,
	type PosGuestDetailsMode,
	type PosLocationStationSettings,
} from '@repo/common/pos-orders'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { FieldLabel } from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import {
	bpToPercentInput,
	parsePercentToBp,
} from '#app/utils/loyalty/loyalty-view.ts'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'

export type RegisterSettingsLocation = {
	id: string
	name: string
	currency: string
	settings: PosLocationStationSettings
}

/**
 * Settings, Terminals: per-location Station register rules (#372 guest
 * details & dish notes, #171 open-price custom items, #380 variance flag
 * threshold, #375 cash discount). Stored in the control plane as policy only;
 * guest details live in the regional database.
 */
export function StationRegisterSettings({
	orgSlug,
	canWrite,
	locations,
	cashDiscountAllowed = false,
}: {
	orgSlug: string
	canWrite: boolean
	locations: RegisterSettingsLocation[]
	/**
	 * Whether the organization's data region allows a cash-payment discount
	 * (`cashDiscountAllowedIn`). Where it does not, the setting is not shown.
	 */
	cashDiscountAllowed?: boolean
}) {
	const { _ } = useLingui()
	if (locations.length === 0) return null
	return (
		<Card
			role="region"
			aria-label={_(t`Register settings`)}
			className="min-w-0 shadow-none"
		>
			<CardHeader className="gap-2 border-b">
				<CardTitle as="h3">
					<Trans>Register settings</Trans>
				</CardTitle>
				<CardDescription className="max-w-prose leading-relaxed">
					<Trans>
						Choose what cashiers must enter at the till, whether dishes show a
						notes field, who may ring up open-price custom items, and when cash
						drawer variances are flagged in reports.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex min-w-0 flex-col divide-y">
				{locations.map((location) => (
					<LocationRegisterForm
						key={location.id}
						orgSlug={orgSlug}
						canWrite={canWrite}
						location={location}
						cashDiscountAllowed={cashDiscountAllowed}
					/>
				))}
			</CardContent>
		</Card>
	)
}

function LocationRegisterForm({
	orgSlug,
	canWrite,
	location,
	cashDiscountAllowed,
}: {
	orgSlug: string
	canWrite: boolean
	location: RegisterSettingsLocation
	cashDiscountAllowed: boolean
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{
		ok: boolean
		error: string | null
		stationSettings: PosLocationStationSettings | null
	}>()
	const saved =
		fetcher.data?.ok && fetcher.data.stationSettings
			? fetcher.data.stationSettings
			: location.settings

	const [guestDetails, setGuestDetails] = useState<PosGuestDetailsMode>(
		saved.guestDetails,
	)
	const [dishNotes, setDishNotes] = useState<boolean>(saved.dishNotes)
	const [customItems, setCustomItems] = useState<PosCustomItemsMode>(
		saved.customItems,
	)
	const [maxPriceText, setMaxPriceText] = useState<string>(() =>
		minorToMajorText(saved.customItemMaxCents, location.currency),
	)
	const [varianceFlagText, setVarianceFlagText] = useState<string>(() =>
		saved.cashVarianceFlagCents !== null
			? minorToMajorText(saved.cashVarianceFlagCents, location.currency)
			: '',
	)
	const [cashDiscountText, setCashDiscountText] = useState<string>(() =>
		bpToPercentInput(saved.cashDiscountBp),
	)
	const [validationError, setValidationError] = useState<string | null>(null)

	const guestLabels: Record<PosGuestDetailsMode, string> = {
		none: _(t`Optional (one-tap quick service)`),
		name: _(t`Guest name required`),
		phone: _(t`Phone number required`),
		both: _(t`Name and phone number required`),
	}
	const customLabels: Record<PosCustomItemsMode, string> = {
		off: _(t`Off`),
		managers: _(t`Managers only`),
		everyone: _(t`Everyone at the till`),
	}

	const busy = fetcher.state !== 'idle'
	const serverError =
		fetcher.state === 'idle' && fetcher.data && !fetcher.data.ok
			? fetcher.data.error === 'location_not_found'
				? _(t`This location no longer exists. Reload the page.`)
				: _(t`Could not save register settings.`)
			: null

	function submit(event: React.FormEvent) {
		event.preventDefault()
		if (!canWrite || busy) return
		const maxCents = parseMoneyToMinor(maxPriceText, {
			currency: location.currency,
			min: 1,
			max: 100_000_000,
		})
		if (maxCents === null) {
			setValidationError(_(t`Enter a positive maximum price for custom items.`))
			return
		}
		let varianceCents: string = ''
		if (varianceFlagText.trim()) {
			const parsed = parseMoneyToMinor(varianceFlagText, {
				currency: location.currency,
				min: 0,
				max: 100_000_000,
			})
			if (parsed === null) {
				setValidationError(
					_(t`Enter a valid cash variance threshold or leave it blank.`),
				)
				return
			}
			varianceCents = String(parsed)
		}
		let cashDiscountPercent = ''
		if (cashDiscountAllowed && cashDiscountText.trim()) {
			const bp = parsePercentToBp(cashDiscountText)
			if (bp === null || bp > CASH_DISCOUNT_MAX_BP) {
				const most = bpToPercentInput(CASH_DISCOUNT_MAX_BP)
				setValidationError(
					_(t`Enter a cash discount of ${most}% or less, or leave it blank.`),
				)
				return
			}
			cashDiscountPercent = cashDiscountText.trim()
		}
		setValidationError(null)
		void fetcher.submit(
			{
				locationId: location.id,
				guestDetails,
				dishNotes: dishNotes ? 'true' : 'false',
				customItems,
				customItemMaxCents: String(maxCents),
				cashVarianceFlagCents: varianceCents,
				...(cashDiscountAllowed ? { cashDiscountPercent } : {}),
			},
			{
				method: 'POST',
				action: `/${orgSlug}/settings/terminals/register-settings`,
			},
		)
	}

	const guestSelectId = `guest-details-${location.id}`
	const customSelectId = `custom-items-${location.id}`
	const maxPriceId = `custom-max-${location.id}`
	const varianceId = `variance-flag-${location.id}`
	const cashDiscountId = `cash-discount-${location.id}`
	const locationCurrency = location.currency

	return (
		<form onSubmit={submit} className="flex flex-col gap-4 py-4 first:pt-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h4 className="font-medium wrap-anywhere">{location.name}</h4>
				{fetcher.state === 'idle' && fetcher.data?.ok ? (
					<span className="text-muted-foreground text-xs">
						<Trans>Saved</Trans>
					</span>
				) : null}
			</div>

			<div className="grid grid-cols-1 gap-4 @md:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<FieldLabel htmlFor={guestSelectId}>
						<Trans>Guest details at checkout</Trans>
					</FieldLabel>
					<Select
						value={guestDetails}
						onValueChange={(value) => {
							if (value) setGuestDetails(value as PosGuestDetailsMode)
						}}
						disabled={!canWrite}
					>
						<SelectTrigger id={guestSelectId} className="h-11 md:h-9">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{POS_GUEST_DETAILS_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{guestLabels[mode]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex flex-col gap-1.5">
					<FieldLabel htmlFor={customSelectId}>
						<Trans>Open-price custom items</Trans>
					</FieldLabel>
					<Select
						value={customItems}
						onValueChange={(value) => {
							if (value) setCustomItems(value as PosCustomItemsMode)
						}}
						disabled={!canWrite}
					>
						<SelectTrigger id={customSelectId} className="h-11 md:h-9">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{POS_CUSTOM_ITEMS_MODES.map((mode) => (
								<SelectItem key={mode} value={mode}>
									{customLabels[mode]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="flex flex-col gap-1.5">
					<FieldLabel htmlFor={maxPriceId}>
						<Trans>Custom item limit ({locationCurrency})</Trans>
					</FieldLabel>
					<Input
						id={maxPriceId}
						type="text"
						inputMode="decimal"
						dir="ltr"
						value={maxPriceText}
						onChange={(e) => setMaxPriceText(e.target.value)}
						disabled={!canWrite}
						className="h-11 md:h-9"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<FieldLabel htmlFor={varianceId}>
						<Trans>Flag cash variance over ({locationCurrency})</Trans>
					</FieldLabel>
					<Input
						id={varianceId}
						type="text"
						inputMode="decimal"
						dir="ltr"
						placeholder={_(t`Off`)}
						value={varianceFlagText}
						onChange={(e) => setVarianceFlagText(e.target.value)}
						disabled={!canWrite}
						className="h-11 md:h-9"
					/>
				</div>

				{cashDiscountAllowed ? (
					<div className="flex flex-col gap-1.5">
						<FieldLabel htmlFor={cashDiscountId}>
							<Trans>Cash discount (%)</Trans>
						</FieldLabel>
						<Input
							id={cashDiscountId}
							type="text"
							inputMode="decimal"
							dir="ltr"
							placeholder={_(t`Off`)}
							aria-describedby={`${cashDiscountId}-hint`}
							value={cashDiscountText}
							onChange={(e) => setCashDiscountText(e.target.value)}
							disabled={!canWrite}
							className="h-11 md:h-9"
						/>
						<p
							id={`${cashDiscountId}-hint`}
							className="text-muted-foreground text-xs"
						>
							<Trans>
								Taken off a bill paid entirely in cash and shown as its own
								line on the receipt and in reports. Check that your state and
								card agreements allow it.
							</Trans>
						</p>
					</div>
				) : null}
			</div>

			<label className="flex min-h-11 items-center justify-between gap-4">
				<span className="text-sm">
					<Trans>Show kitchen note field on dishes at the till</Trans>
				</span>
				<Switch
					checked={dishNotes}
					disabled={!canWrite}
					onCheckedChange={setDishNotes}
				/>
			</label>

			<p role="status" className="text-destructive text-sm empty:hidden">
				{validationError ?? serverError ?? ''}
			</p>

			{canWrite ? (
				<div className="flex justify-end">
					<Button
						type="submit"
						variant="outline"
						disabled={busy}
						className="h-11 md:h-9"
					>
						{busy ? (
							<Trans>Saving…</Trans>
						) : (
							<Trans>Save register settings</Trans>
						)}
					</Button>
				</div>
			) : null}
		</form>
	)
}
