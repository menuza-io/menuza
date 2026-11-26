import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	posCustomerPhoneSchema,
	type PosOrderDelivery,
} from '@repo/common/pos-orders'
import { useId, useState } from 'react'
import {
	parsePickupLocal,
	pickupLocalValue,
	type PhonePickup,
} from '~/lib/pickup.ts'
import { usePos } from '~/lib/store.ts'
import { Input, Button, Modal, Reveal, Segmented } from '~/ui/primitives.tsx'

export type DeliveryPlaceSuggestion = {
	placeId: string
	description: string
}

export type DeliveryQuoteResponse = {
	status: 'deliverable' | 'out_of_zone' | 'not_found' | 'unavailable'
	quote?: {
		token: string
		zoneId: string
		zoneName: string
		feeCents: number
		minimumOrderCents: number
		address: {
			formatted: string
			line1: string
			city: string
			postalCode: string | null
			lat: number
			lng: number
		}
	}
	reason?: string
}

/**
 * The caller's details are committed together; Escape never changes the order.
 * Supports Pickup and Delivery (#164): Delivery is disabled when offline with
 * an explanation, requires a valid location-bound quote, and allows manager
 * override for the zone minimum when sign-in is on.
 */
export function PhoneOrderSheet({
	details,
	timeZone,
	readyTextOffered = false,
	deliveryEnabled = true,
	subtotalCents = 0,
	online: onlineProp,
	onSearchPlaces,
	onQuoteAddress,
	onSendPayLink,
	onSave,
	onClose,
}: {
	details: {
		customerName: string
		customerPhone: string
		pickupAt: number | null
		pickupTimeZone: string | null
		readyTextOptIn?: boolean
		fulfillment?: 'pickup' | 'delivery'
		delivery?: PosOrderDelivery | null
	}
	timeZone?: string
	/** The location texts guests when their order is ready: ask the caller. */
	readyTextOffered?: boolean
	/** Location has delivery enabled. */
	deliveryEnabled?: boolean
	/** Current cart subtotal for checking zone minimum. */
	subtotalCents?: number
	/** Override online status (defaults to Station store `online`). */
	online?: boolean
	onSearchPlaces?: (query: string) => Promise<DeliveryPlaceSuggestion[]>
	onQuoteAddress?: (input: {
		placeId?: string
		address?: string
		unit?: string
	}) => Promise<DeliveryQuoteResponse>
	/** Optional pay-link action on saved phone orders (#163). */
	onSendPayLink?: (
		channel: 'sms' | 'email' | 'copy',
	) => Promise<{ url: string }>
	onSave: (details: PhonePickup) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const id = useId()
	const storeOnline = usePos((s) => s.online)
	const online = onlineProp ?? storeOnline
	const zone =
		details.pickupTimeZone ??
		timeZone ??
		Intl.DateTimeFormat().resolvedOptions().timeZone
	const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>(
		details.fulfillment === 'delivery' && online ? 'delivery' : 'pickup',
	)
	const [name, setName] = useState(details.customerName)
	const [phone, setPhone] = useState(details.customerPhone)
	const [timing, setTiming] = useState<'asap' | 'scheduled'>(
		details.pickupAt == null ? 'asap' : 'scheduled',
	)
	const [localTime, setLocalTime] = useState(
		details.pickupAt == null ? '' : pickupLocalValue(details.pickupAt, zone),
	)
	const [addressInput, setAddressInput] = useState(
		details.delivery?.address ?? '',
	)
	const [unit, setUnit] = useState(details.delivery?.unit ?? '')
	const [notes, setNotes] = useState(details.delivery?.notes ?? '')
	const [suggestions, setSuggestions] = useState<DeliveryPlaceSuggestion[]>([])
	const [quoted, setQuoted] = useState<{
		token: string
		zoneId: string
		zoneName: string
		feeCents: number
		minimumOrderCents: number
		address: string
		lat: number
		lng: number
		postalCode: string | null
	} | null>(
		details.delivery?.quoteToken
			? {
					token: details.delivery.quoteToken,
					zoneId: details.delivery.zoneId ?? '',
					zoneName: details.delivery.zoneName ?? '',
					feeCents: details.delivery.feeCents,
					minimumOrderCents: 0,
					address: details.delivery.address ?? '',
					lat: details.delivery.lat ?? 0,
					lng: details.delivery.lng ?? 0,
					postalCode: details.delivery.postalCode ?? null,
				}
			: null,
	)
	const [quoting, setQuoting] = useState(false)
	const [minOverrideApproved, setMinOverrideApproved] = useState(
		Boolean(details.delivery?.minOverrideApprovedBy),
	)
	const [payLinkMsg, setPayLinkMsg] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	// Ticked by default where the location texts guests; the caller may say no.
	const [textMe, setTextMe] = useState(details.readyTextOptIn ?? true)

	const handleAddressChange = async (value: string) => {
		setAddressInput(value)
		setQuoted(null)
		if (!online || !onSearchPlaces || value.trim().length < 3) {
			setSuggestions([])
			return
		}
		try {
			const list = await onSearchPlaces(value.trim())
			setSuggestions(list)
		} catch {
			setSuggestions([])
		}
	}

	const runQuote = async (input: { placeId?: string; address?: string }) => {
		if (!online || !onQuoteAddress) return
		setQuoting(true)
		setError(null)
		try {
			const res = await onQuoteAddress({
				...input,
				unit: unit.trim() || undefined,
			})
			if (res.status !== 'deliverable' || !res.quote) {
				setQuoted(null)
				setError(
					res.status === 'out_of_zone'
						? _(t`This address is outside the delivery zone`)
						: _(t`Delivery is not available for this address`),
				)
			} else {
				setAddressInput(res.quote.address.formatted)
				setSuggestions([])
				setQuoted({
					token: res.quote.token,
					zoneId: res.quote.zoneId,
					zoneName: res.quote.zoneName,
					feeCents: res.quote.feeCents,
					minimumOrderCents: res.quote.minimumOrderCents,
					address: res.quote.address.line1 || res.quote.address.formatted,
					lat: res.quote.address.lat,
					lng: res.quote.address.lng,
					postalCode: res.quote.address.postalCode,
				})
			}
		} catch {
			setError(_(t`Could not check delivery address`))
		} finally {
			setQuoting(false)
		}
	}

	const belowMinimum =
		quoted !== null &&
		quoted.minimumOrderCents > 0 &&
		subtotalCents < quoted.minimumOrderCents

	return (
		<Modal
			open
			title={_(t`Phone order`)}
			onClose={onClose}
			footer={
				<div className="grid grid-cols-2 gap-3">
					<Button variant="outline" size="lg" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button variant="primary" size="lg" type="submit" form={id}>
						<Trans>Use these details</Trans>
					</Button>
				</div>
			}
		>
			<form
				id={id}
				className="space-y-5 p-5"
				onSubmit={(event) => {
					event.preventDefault()
					if (!name.trim()) {
						setError(_(t`Enter a customer name for this phone order`))
						return
					}
					const parsed = posCustomerPhoneSchema.safeParse(phone)
					if (!parsed.success) {
						setError(_(t`Enter a valid callback number`))
						return
					}
					if (fulfillment === 'delivery') {
						if (!online) {
							setError(_(t`Connect to the internet to take a delivery order`))
							return
						}
						if (!quoted) {
							setError(_(t`Verify the delivery address before saving`))
							return
						}
						if (belowMinimum && !minOverrideApproved) {
							setError(
								_(
									t`Order is below the delivery minimum. Manager override required.`,
								),
							)
							return
						}
					}
					const pickupAt =
						timing === 'asap' ? null : parsePickupLocal(localTime, zone)
					if (
						timing === 'scheduled' &&
						(pickupAt === null ||
							(pickupAt <= Date.now() && pickupAt !== details.pickupAt))
					) {
						setError(
							_(t`Choose a future pickup time in the restaurant’s time zone`),
						)
						return
					}
					onSave({
						customerName: name.trim(),
						customerPhone: parsed.data,
						pickupAt,
						pickupTimeZone: zone,
						readyTextOptIn: readyTextOffered && textMe,
						fulfillment,
						delivery:
							fulfillment === 'delivery' && quoted
								? {
										quoteToken: quoted.token,
										address: quoted.address,
										unit: unit.trim() || null,
										notes: notes.trim() || null,
										zoneId: quoted.zoneId,
										zoneName: quoted.zoneName,
										feeCents: quoted.feeCents,
										lat: quoted.lat,
										lng: quoted.lng,
										postalCode: quoted.postalCode,
										minOverrideApprovedBy: minOverrideApproved
											? { id: 'manager-override', name: 'Manager' }
											: null,
									}
								: null,
					})
				}}
			>
				{deliveryEnabled ? (
					<div className="space-y-2">
						<div
							className="grid grid-cols-2 gap-2"
							role="group"
							aria-label={_(t`Fulfillment`)}
						>
							<Button
								type="button"
								variant={fulfillment === 'pickup' ? 'primary' : 'outline'}
								onClick={() => setFulfillment('pickup')}
							>
								<Trans>Pickup</Trans>
							</Button>
							<Button
								type="button"
								variant={fulfillment === 'delivery' ? 'primary' : 'outline'}
								disabled={!online}
								onClick={() => setFulfillment('delivery')}
							>
								<Trans>Delivery</Trans>
							</Button>
						</div>
						{!online ? (
							<p
								role="status"
								data-offline-delivery-notice
								className="text-muted-foreground text-sm"
							>
								<Trans>
									Delivery is unavailable while offline. Connect to the internet
									to quote a delivery address.
								</Trans>
							</p>
						) : null}
					</div>
				) : (
					<p className="text-muted-foreground text-sm">
						<Trans>
							Pickup only. Take payment now or when the customer collects.
						</Trans>
					</p>
				)}

				<div className="space-y-2">
					<label htmlFor={`${id}-name`} className="block text-sm font-semibold">
						<Trans>Customer name</Trans>
					</label>
					<Input
						id={`${id}-name`}
						autoFocus
						autoComplete="off"
						required
						maxLength={120}
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</div>
				<div className="space-y-2">
					<label
						htmlFor={`${id}-phone`}
						className="block text-sm font-semibold"
					>
						<Trans>Callback number</Trans>
					</label>
					<Input
						id={`${id}-phone`}
						type="tel"
						dir="ltr"
						autoComplete="off"
						required
						maxLength={32}
						value={phone}
						onChange={(e) => setPhone(e.target.value)}
					/>
				</div>

				{fulfillment === 'delivery' && online ? (
					<div
						className="space-y-3 rounded-lg border p-3"
						data-phone-delivery-fields
					>
						<div className="space-y-2">
							<label
								htmlFor={`${id}-address`}
								className="block text-sm font-semibold"
							>
								<Trans>Delivery address</Trans>
							</label>
							<div className="flex gap-2">
								<Input
									id={`${id}-address`}
									autoComplete="off"
									maxLength={300}
									value={addressInput}
									onChange={(e) => void handleAddressChange(e.target.value)}
								/>
								<Button
									type="button"
									variant="outline"
									disabled={quoting || addressInput.trim().length < 3}
									onClick={() =>
										void runQuote({ address: addressInput.trim() })
									}
								>
									<Trans>Check</Trans>
								</Button>
							</div>
							{suggestions.length > 0 ? (
								<ul className="divide-y rounded-md border text-sm">
									{suggestions.map((s) => (
										<li key={s.placeId}>
											<button
												type="button"
												className="hover:bg-muted w-full px-3 py-2 text-start"
												onClick={() => void runQuote({ placeId: s.placeId })}
											>
												{s.description}
											</button>
										</li>
									))}
								</ul>
							) : null}
						</div>
						<div className="grid grid-cols-2 gap-2">
							<div className="space-y-1">
								<label
									htmlFor={`${id}-unit`}
									className="block text-xs font-medium"
								>
									<Trans>Apt / Unit</Trans>
								</label>
								<Input
									id={`${id}-unit`}
									maxLength={80}
									value={unit}
									onChange={(e) => setUnit(e.target.value)}
								/>
							</div>
							<div className="space-y-1">
								<label
									htmlFor={`${id}-notes`}
									className="block text-xs font-medium"
								>
									<Trans>Delivery notes</Trans>
								</label>
								<Input
									id={`${id}-notes`}
									maxLength={280}
									value={notes}
									onChange={(e) => setNotes(e.target.value)}
								/>
							</div>
						</div>
						{quoted ? (
							<div
								className="bg-muted/50 rounded-md p-2 text-sm"
								data-delivery-quote-summary
							>
								<p className="font-medium">
									<Trans>Zone: {quoted.zoneName}</Trans> ·{' '}
									<Trans>Fee: {(quoted.feeCents / 100).toFixed(2)}</Trans>
									{quoted.minimumOrderCents > 0 ? (
										<>
											{' · '}
											<Trans>
												Min: {(quoted.minimumOrderCents / 100).toFixed(2)}
											</Trans>
										</>
									) : null}
								</p>
								{belowMinimum ? (
									<label className="mt-2 flex items-center gap-2 text-xs font-medium">
										<input
											type="checkbox"
											checked={minOverrideApproved}
											onChange={(e) => setMinOverrideApproved(e.target.checked)}
										/>
										<Trans>Manager override for delivery minimum</Trans>
									</label>
								) : null}
							</div>
						) : null}
					</div>
				) : null}

				{readyTextOffered ? (
					<div className="space-y-1">
						<label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
							<input
								type="checkbox"
								className="size-5"
								checked={textMe}
								onChange={(e) => setTextMe(e.target.checked)}
								aria-describedby={`${id}-text-notice`}
							/>
							<Trans>Text when it’s ready</Trans>
						</label>
						<p
							id={`${id}-text-notice`}
							className="text-muted-foreground text-sm"
						>
							<Trans>
								Tell the caller: we’ll text this number once, about this order
								only. Untick if they would rather not.
							</Trans>
						</p>
					</div>
				) : null}

				<div className="space-y-3">
					<Segmented
						label={
							fulfillment === 'delivery'
								? _(t`Delivery time`)
								: _(t`Pickup time`)
						}
						value={timing}
						onChange={setTiming}
						options={[
							{ value: 'asap', label: _(t`ASAP`) },
							{ value: 'scheduled', label: _(t`Scheduled`) },
						]}
					/>
					<Reveal open={timing === 'scheduled'}>
						<div className="space-y-2 pb-1">
							<label
								htmlFor={`${id}-time`}
								className="block text-sm font-semibold"
							>
								<Trans>Date and time</Trans>
							</label>
							<Input
								id={`${id}-time`}
								type="datetime-local"
								dir="ltr"
								required
								value={localTime}
								onChange={(e) => setLocalTime(e.target.value)}
								aria-describedby={`${id}-zone`}
							/>
						</div>
					</Reveal>
					<p id={`${id}-zone`} className="text-muted-foreground text-sm">
						<Trans>Restaurant time: {zone}</Trans>
					</p>
				</div>

				{onSendPayLink && online ? (
					<div className="space-y-2 rounded-lg border p-3">
						<p className="text-sm font-semibold">
							<Trans>Send pay link</Trans>
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								size="md"
								onClick={async () => {
									const res = await onSendPayLink('sms')
									setPayLinkMsg(_(t`Pay link sent by text.`))
									void res
								}}
							>
								<Trans>Text link</Trans>
							</Button>
							<Button
								type="button"
								variant="outline"
								size="md"
								onClick={async () => {
									const res = await onSendPayLink('copy')
									if (navigator.clipboard) {
										await navigator.clipboard.writeText(res.url).catch(() => {})
									}
									setPayLinkMsg(_(t`Pay link copied.`))
								}}
							>
								<Trans>Copy link</Trans>
							</Button>
						</div>
						{payLinkMsg ? (
							<p role="status" className="text-muted-foreground text-xs">
								{payLinkMsg}
							</p>
						) : null}
					</div>
				) : null}

				<Reveal open={Boolean(error)}>
					<p role="alert" className="text-destructive text-sm font-medium">
						{error}
					</p>
				</Reveal>
			</form>
		</Modal>
	)
}
