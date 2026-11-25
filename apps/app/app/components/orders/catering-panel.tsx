import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { formatDate, localParts, parseLocalTimestamp } from '@repo/zoned-time'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import {
	SelectField,
	TextAreaField,
	TextField,
} from '#app/components/staff/controls.tsx'
import {
	OperatorRequestError,
	useOperatorClient,
} from '#app/hooks/use-operator-client.ts'
import { parseMoneyToMinor, minorToMajorText } from '#app/utils/money-input.ts'
import { formatMoney } from '#app/utils/orders/order-model.ts'
import { ordersHref } from '#app/utils/orders/orders-link.ts'

export type CateringTabLocation = {
	id: string
	name: string
	timezone: string
	currency: string
	cateringOn: boolean
}
export type CateringTabDish = { id: string; name: string; priceCents: number }

const lineSchema = z.object({
	lineId: z.string(),
	itemId: z.string().nullable(),
	itemName: z.string(),
	quantity: z.number(),
	unitPriceCents: z.number(),
	taxable: z.boolean(),
	instructions: z.string().nullable().optional(),
})
const chargeSchema = z.object({
	chargeId: z.string(),
	kind: z.enum(['delivery', 'setup', 'service', 'other']),
	label: z.string(),
	amountCents: z.number(),
	taxable: z.boolean(),
})
const quoteSchema = z.object({
	id: z.string(),
	status: z.enum(['draft', 'sent', 'accepted', 'paid', 'expired', 'cancelled']),
	version: z.number(),
	source: z.enum(['guest', 'operator']),
	locationId: z.string(),
	fulfillment: z.enum(['pickup', 'delivery']),
	eventAt: z.number().nullable(),
	guestCount: z.number().nullable(),
	contact: z.object({
		name: z.string(),
		phone: z.string(),
		email: z.string().nullable(),
	}),
	eventNotes: z.string().nullable(),
	quoteNote: z.string().nullable(),
	lines: z.array(lineSchema),
	charges: z.array(chargeSchema),
	currency: z.string(),
	subtotalCents: z.number(),
	taxCents: z.number(),
	totalCents: z.number(),
	depositPercent: z.number().nullable(),
	validDays: z.number().nullable(),
	expiresAt: z.number().nullable(),
	sentAt: z.number().nullable(),
	paidOrderId: z.string().nullable(),
	updatedAt: z.number(),
})
type Quote = z.infer<typeof quoteSchema>

const orderSchema = z.object({
	id: z.string(),
	number: z.string(),
	locationId: z.string(),
	status: z.string(),
	paymentStatus: z.string(),
	eventAt: z.number().nullable(),
	guestCount: z.number().nullable(),
	contact: z.object({ name: z.string() }),
	currency: z.string(),
	totalCents: z.number(),
	paidCents: z.number(),
	balance: z.object({
		status: z.enum([
			'none',
			'awaiting_deposit',
			'due',
			'overdue',
			'paid',
			'void',
		]),
		owedCents: z.number(),
		dueAt: z.number().nullable(),
	}),
})
type CateringOrder = z.infer<typeof orderSchema>

const listSchema = z.object({
	orders: z.array(orderSchema),
	quotes: z.array(quoteSchema),
})

function GuestCount({ count }: { count: number }) {
	return <Trans>{count} guests</Trans>
}

function QuoteStatus({ status }: { status: Quote['status'] }) {
	switch (status) {
		case 'draft':
			return (
				<Badge variant="outline">
					<Trans>Draft</Trans>
				</Badge>
			)
		case 'sent':
			return (
				<Badge variant="secondary">
					<Trans>Sent</Trans>
				</Badge>
			)
		case 'accepted':
			return (
				<Badge variant="secondary">
					<Trans>Paying</Trans>
				</Badge>
			)
		case 'paid':
			return (
				<Badge>
					<Trans>Paid</Trans>
				</Badge>
			)
		case 'expired':
			return (
				<Badge variant="outline">
					<Trans>Expired</Trans>
				</Badge>
			)
		case 'cancelled':
			return (
				<Badge variant="outline">
					<Trans>Cancelled</Trans>
				</Badge>
			)
	}
}

function BalanceStatus({
	status,
}: {
	status: CateringOrder['balance']['status']
}) {
	switch (status) {
		case 'due':
			return (
				<Badge variant="secondary">
					<Trans>Balance due</Trans>
				</Badge>
			)
		case 'overdue':
			return (
				<Badge variant="destructive">
					<Trans>Balance overdue</Trans>
				</Badge>
			)
		case 'paid':
			return (
				<Badge>
					<Trans>Paid in full</Trans>
				</Badge>
			)
		case 'void':
			return (
				<Badge variant="outline">
					<Trans>Balance voided</Trans>
				</Badge>
			)
		case 'awaiting_deposit':
			return (
				<Badge variant="outline">
					<Trans>Waiting for the deposit</Trans>
				</Badge>
			)
		default:
			return null
	}
}

/** `YYYY-MM-DDTHH:mm` of an instant in a zone, for a datetime-local input. */
function toLocalInput(ms: number | null, timeZone: string): string {
	if (ms === null) return ''
	const p = localParts(ms, timeZone)
	return `${formatDate(p.year, p.month, p.day)}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

type DraftLine = {
	lineId?: string
	itemId: string | null
	itemName: string
	quantity: string
	price: string
	taxable: boolean
}
type DraftCharge = {
	chargeId?: string
	kind: 'delivery' | 'setup' | 'service' | 'other'
	label: string
	amount: string
	taxable: boolean
}

/**
 * Orders, Catering (#124): catering orders and quote requests with the event,
 * the guest count and the status, and the quote editor: from a request or from
 * scratch for a phone enquiry, edit the lines and prices, add a delivery or
 * setup charge and a note, set how long it stays open and send it. The guest's
 * words are read in the browser from the regional API with the orders token,
 * never through this server.
 */
export function CateringPanel({
	orgSlug,
	canWrite,
	quotesEnabled,
	locations,
	dishes,
}: {
	orgSlug: string
	canWrite: boolean
	quotesEnabled: boolean
	locations: CateringTabLocation[]
	dishes: CateringTabDish[]
}) {
	const { _, i18n } = useLingui()
	const { request } = useOperatorClient(orgSlug, '/operator/catering')
	const [orders, setOrders] = useState<CateringOrder[]>([])
	const [quotes, setQuotes] = useState<Quote[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [editing, setEditing] = useState<Quote | 'new' | null>(null)

	const refresh = useCallback(async () => {
		try {
			const data = listSchema.parse(await request('', { readOnly: true }))
			setOrders(data.orders)
			setQuotes(data.quotes)
			setError(null)
		} catch {
			setError(_(msg`Unable to load catering. Try again.`))
		} finally {
			setLoading(false)
		}
	}, [request, _])

	useEffect(() => {
		void refresh()
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') void refresh()
		}, 20000)
		return () => window.clearInterval(timer)
	}, [refresh])

	const locationName = (id: string) =>
		locations.find((location) => location.id === id)?.name ?? ''
	const zoneOf = (id: string) =>
		locations.find((location) => location.id === id)?.timezone ?? 'UTC'
	const when = (ms: number | null, locationId: string) =>
		ms === null
			? '—'
			: new Intl.DateTimeFormat(i18n.locale, {
					dateStyle: 'medium',
					timeStyle: 'short',
					timeZone: zoneOf(locationId),
				}).format(new Date(ms))

	const openQuotes = quotes.filter(
		(quote) => quote.status !== 'paid' && quote.status !== 'cancelled',
	)

	if (editing) {
		return (
			<QuoteEditor
				quote={editing === 'new' ? null : editing}
				locations={locations}
				dishes={dishes}
				canWrite={canWrite}
				onClose={(changed) => {
					setEditing(null)
					if (changed) void refresh()
				}}
				request={request}
			/>
		)
	}

	return (
		<div className="space-y-4" data-testid="catering-panel">
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			<Tabs defaultValue="orders">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<TabsList>
						<TabsTrigger value="orders">
							<Trans>Orders</Trans>
							{orders.length > 0 ? (
								<span className="ms-1 tabular-nums">({orders.length})</span>
							) : null}
						</TabsTrigger>
						{quotesEnabled ? (
							<TabsTrigger value="quotes">
								<Trans>Quotes and requests</Trans>
								{openQuotes.length > 0 ? (
									<span className="ms-1 tabular-nums">
										({openQuotes.length})
									</span>
								) : null}
							</TabsTrigger>
						) : null}
					</TabsList>
					{canWrite && quotesEnabled ? (
						<Button
							variant="outline"
							size="sm"
							data-testid="catering-new-quote"
							onClick={() => setEditing('new')}
						>
							<Icon name="plus" className="size-4" />
							<Trans>New quote</Trans>
						</Button>
					) : null}
				</div>

				<TabsContent value="orders" className="mt-3">
					{loading ? (
						<p role="status">
							<Trans>Loading catering…</Trans>
						</p>
					) : orders.length === 0 ? (
						<div className="rounded-lg border p-8 text-center">
							<h3 className="font-medium">
								<Trans>No catering orders yet</Trans>
							</h3>
							<p className="text-muted-foreground mt-2 text-sm">
								<Trans>
									Confirmed catering orders appear here, by event date.
								</Trans>
							</p>
						</div>
					) : (
						<ul
							className="divide-border divide-y rounded-lg border"
							data-testid="catering-orders"
						>
							{orders.map((order) => (
								<li key={order.id}>
									<Link
										to={ordersHref(orgSlug, { orderId: order.id })}
										className="hover:bg-muted/60 flex flex-col gap-1 p-4"
									>
										<span className="flex items-baseline justify-between gap-3">
											<span className="font-medium tabular-nums">
												<bdi dir="ltr">{order.number}</bdi>
											</span>
											<span className="font-medium tabular-nums">
												<bdi>
													{formatMoney(
														order.totalCents,
														order.currency,
														i18n.locale,
													)}
												</bdi>
											</span>
										</span>
										<span className="text-muted-foreground text-sm">
											{when(order.eventAt, order.locationId)}
											{order.guestCount ? (
												<span className="ms-2">
													<GuestCount count={order.guestCount} />
												</span>
											) : null}
											<span className="ms-2">
												{locationName(order.locationId)}
											</span>
										</span>
										<span className="flex flex-wrap items-center gap-2">
											<span className="text-sm">{order.contact.name}</span>
											{order.paymentStatus === 'pending' ? (
												<Badge variant="outline">
													<Trans>Awaiting payment</Trans>
												</Badge>
											) : (
												<BalanceStatus status={order.balance.status} />
											)}
										</span>
									</Link>
								</li>
							))}
						</ul>
					)}
				</TabsContent>

				{quotesEnabled ? (
					<TabsContent value="quotes" className="mt-3">
						{quotes.length === 0 ? (
							<div className="rounded-lg border p-8 text-center">
								<h3 className="font-medium">
									<Trans>No quotes or requests</Trans>
								</h3>
								<p className="text-muted-foreground mt-2 text-sm">
									<Trans>
										A guest&apos;s quote request appears here. You can also
										write a quote for a phone enquiry.
									</Trans>
								</p>
							</div>
						) : (
							<ul
								className="divide-border divide-y rounded-lg border"
								data-testid="catering-quotes"
							>
								{quotes.map((quote) => (
									<li key={quote.id}>
										<button
											type="button"
											className="hover:bg-muted/60 flex w-full flex-col gap-1 p-4 text-start"
											onClick={() => setEditing(quote)}
										>
											<span className="flex items-baseline justify-between gap-3">
												<span className="font-medium">
													{quote.contact.name || _(msg`Guest`)}
												</span>
												<span className="font-medium tabular-nums">
													<bdi>
														{quote.totalCents > 0
															? formatMoney(
																	quote.totalCents,
																	quote.currency,
																	i18n.locale,
																)
															: '—'}
													</bdi>
												</span>
											</span>
											<span className="text-muted-foreground text-sm">
												{when(quote.eventAt, quote.locationId)}
												{quote.guestCount ? (
													<span className="ms-2">
														<GuestCount count={quote.guestCount} />
													</span>
												) : null}
											</span>
											<span className="flex flex-wrap items-center gap-2">
												<QuoteStatus status={quote.status} />
												<Badge variant="outline">
													{quote.source === 'guest' ? (
														<Trans>Request</Trans>
													) : (
														<Trans>Phone quote</Trans>
													)}
												</Badge>
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</TabsContent>
				) : null}
			</Tabs>
		</div>
	)
}

const ERRORS: Record<string, ReturnType<typeof msg>> = {
	invalid_request: msg`Add the guest, the event time, at least one line and a total before sending.`,
	quote_not_editable: msg`This quote can no longer be changed.`,
	stale_version: msg`This quote changed. Close it and open it again.`,
	catering_disabled: msg`Catering is not turned on for this location.`,
}

function QuoteEditor({
	quote,
	locations,
	dishes,
	canWrite,
	onClose,
	request,
}: {
	quote: Quote | null
	locations: CateringTabLocation[]
	dishes: CateringTabDish[]
	canWrite: boolean
	onClose: (changed: boolean) => void
	request: ReturnType<typeof useOperatorClient>['request']
}) {
	const { _, i18n } = useLingui()
	const cateringLocations = locations.filter((location) => location.cateringOn)
	const [locationId, setLocationId] = useState(
		quote?.locationId ?? cateringLocations[0]?.id ?? locations[0]?.id ?? '',
	)
	const location = locations.find((candidate) => candidate.id === locationId)
	const timeZone = location?.timezone ?? 'UTC'
	const currency = quote?.currency ?? location?.currency ?? 'USD'
	const [name, setName] = useState(quote?.contact.name ?? '')
	const [phone, setPhone] = useState(quote?.contact.phone ?? '')
	const [email, setEmail] = useState(quote?.contact.email ?? '')
	const [eventAt, setEventAt] = useState(
		toLocalInput(quote?.eventAt ?? null, timeZone),
	)
	const [guests, setGuests] = useState(
		quote?.guestCount ? String(quote.guestCount) : '',
	)
	const [fulfillment, setFulfillment] = useState<'pickup' | 'delivery'>(
		quote?.fulfillment ?? 'pickup',
	)
	const [note, setNote] = useState(quote?.quoteNote ?? '')
	const [validDays, setValidDays] = useState(
		quote?.validDays ? String(quote.validDays) : '7',
	)
	const [deposit, setDeposit] = useState(
		quote?.depositPercent != null ? String(quote.depositPercent) : '',
	)
	const [lines, setLines] = useState<DraftLine[]>(
		(quote?.lines ?? []).map((line) => ({
			lineId: line.lineId,
			itemId: line.itemId,
			itemName: line.itemName,
			quantity: String(line.quantity),
			price: minorToMajorText(line.unitPriceCents, currency),
			taxable: line.taxable,
		})),
	)
	const [charges, setCharges] = useState<DraftCharge[]>(
		(quote?.charges ?? []).map((charge) => ({
			chargeId: charge.chargeId,
			kind: charge.kind,
			label: charge.label,
			amount: minorToMajorText(charge.amountCents, currency),
			taxable: charge.taxable,
		})),
	)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [sentLink, setSentLink] = useState<string | null>(null)
	const [sentNotice, setSentNotice] = useState<string | null>(null)
	const editable =
		canWrite && (!quote || ['draft', 'sent', 'expired'].includes(quote.status))
	const money = (cents: number) => formatMoney(cents, currency, i18n.locale)

	const body = () => {
		const linesBody = lines.map((line) => ({
			...(line.lineId ? { lineId: line.lineId } : {}),
			itemId: line.itemId,
			itemName: line.itemName,
			quantity: Math.max(1, Math.round(Number(line.quantity) || 1)),
			unitPriceCents: parseMoneyToMinor(line.price, { min: 0, currency }) ?? 0,
			taxable: line.taxable,
		}))
		const chargesBody = charges
			.filter((charge) => charge.label.trim())
			.map((charge) => ({
				...(charge.chargeId ? { chargeId: charge.chargeId } : {}),
				kind: charge.kind,
				label: charge.label.trim(),
				amountCents:
					parseMoneyToMinor(charge.amount, { min: 0, currency }) ?? 0,
				taxable: charge.taxable,
			}))
		return {
			...(quote ? {} : { locationId }),
			fulfillment,
			...(eventAt
				? {
						eventAt: new Date(
							parseLocalTimestamp(eventAt, timeZone),
						).toISOString(),
					}
				: {}),
			...(guests
				? { guestCount: Math.max(1, Math.round(Number(guests))) }
				: {}),
			contact: {
				...(name.trim() ? { name: name.trim() } : {}),
				...(phone.trim() ? { phone: phone.trim() } : {}),
				...(email.trim() ? { email: email.trim() } : {}),
			},
			quoteNote: note.trim() || null,
			validDays: Math.max(1, Math.round(Number(validDays) || 7)),
			depositPercent:
				deposit.trim() === '' ? null : Math.round(Number(deposit)),
			...(linesBody.length > 0 ? { lines: linesBody } : {}),
			charges: chargesBody,
		}
	}

	const save = async (send: boolean) => {
		setBusy(true)
		setError(null)
		try {
			const saved = quoteSchema.parse(
				quote
					? await request(`/quotes/${quote.id}`, {
							method: 'PATCH',
							body: JSON.stringify(body()),
						})
					: await request('/quotes', {
							method: 'POST',
							body: JSON.stringify(body()),
						}),
			)
			if (send) {
				const sent = z
					.object({ emailed: z.boolean(), link: z.string().nullable() })
					.parse(await request(`/quotes/${saved.id}/send`, { method: 'POST' }))
				if (sent.emailed) {
					setSentNotice(_(msg`The quote was sent by email.`))
				} else {
					setSentNotice(
						_(
							msg`The email could not be sent. Share this link with the guest:`,
						),
					)
					setSentLink(sent.link)
				}
				return
			}
			onClose(true)
		} catch (caught) {
			const code = caught instanceof OperatorRequestError ? caught.code : ''
			setError(
				ERRORS[code] ? _(ERRORS[code]!) : _(msg`That did not work. Try again.`),
			)
		} finally {
			setBusy(false)
		}
	}

	const cancelQuote = async () => {
		if (!quote) return
		setBusy(true)
		try {
			await request(`/quotes/${quote.id}/cancel`, { method: 'POST' })
			onClose(true)
		} catch {
			setError(_(msg`That did not work. Try again.`))
		} finally {
			setBusy(false)
		}
	}

	const subtotal =
		lines.reduce(
			(sum, line) =>
				sum +
				Math.max(1, Math.round(Number(line.quantity) || 1)) *
					(parseMoneyToMinor(line.price, { min: 0, currency }) ?? 0),
			0,
		) +
		charges.reduce(
			(sum, charge) =>
				sum + (parseMoneyToMinor(charge.amount, { min: 0, currency }) ?? 0),
			0,
		)

	const subtotalLabel = money(subtotal)
	const totalLabel = money(quote?.totalCents ?? 0)

	if (sentNotice) {
		return (
			<div
				className="space-y-3 rounded-lg border p-6"
				data-testid="catering-quote-sent"
			>
				<p role="status" className="font-medium">
					{sentNotice}
				</p>
				{sentLink ? (
					<p className="text-sm wrap-anywhere">
						<bdi dir="ltr">{sentLink}</bdi>
					</p>
				) : null}
				<Button onClick={() => onClose(true)}>
					<Trans>Done</Trans>
				</Button>
			</div>
		)
	}

	return (
		<div
			className="space-y-4 rounded-lg border p-4"
			data-testid="catering-quote-editor"
		>
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-lg font-medium">
					{quote ? <Trans>Quote</Trans> : <Trans>New quote</Trans>}
				</h2>
				{quote ? <QuoteStatus status={quote.status} /> : null}
			</div>
			{quote?.eventNotes ? (
				<div className="bg-muted/40 rounded-md p-3 text-sm">
					<p className="text-muted-foreground text-xs">
						<Trans>The guest wrote</Trans>
					</p>
					<p dir="auto" className="whitespace-pre-wrap">
						{quote.eventNotes}
					</p>
				</div>
			) : null}
			{quote && quote.sentAt && quote.status === 'sent' ? (
				<p className="text-muted-foreground text-xs">
					<Trans>
						Changing a quote that was sent replaces its link: the old link stops
						working until you send it again.
					</Trans>
				</p>
			) : null}
			<div className="grid gap-3 sm:grid-cols-2">
				{!quote ? (
					<SelectField
						id="quote-location"
						label={<Trans>Location</Trans>}
						options={cateringLocations.map((candidate) => ({
							value: candidate.id,
							label: candidate.name,
						}))}
						value={locationId}
						onValueChange={(value) => value && setLocationId(value)}
					/>
				) : null}
				<TextField
					id="quote-name"
					label={<Trans>Guest name</Trans>}
					value={name}
					disabled={!editable}
					onChange={(event) => setName(event.target.value)}
				/>
				<TextField
					id="quote-email"
					label={<Trans>Email</Trans>}
					type="email"
					dir="ltr"
					value={email}
					disabled={!editable}
					onChange={(event) => setEmail(event.target.value)}
				/>
				<TextField
					id="quote-phone"
					label={<Trans>Phone</Trans>}
					type="tel"
					dir="ltr"
					value={phone}
					disabled={!editable}
					onChange={(event) => setPhone(event.target.value)}
				/>
				<TextField
					id="quote-event"
					label={<Trans>Event date and time</Trans>}
					type="datetime-local"
					value={eventAt}
					disabled={!editable}
					onChange={(event) => setEventAt(event.target.value)}
				/>
				<TextField
					id="quote-guests"
					label={<Trans>Guests</Trans>}
					type="number"
					min={1}
					value={guests}
					disabled={!editable}
					onChange={(event) => setGuests(event.target.value)}
				/>
				<SelectField
					id="quote-fulfillment"
					label={<Trans>Pickup or delivery</Trans>}
					options={[
						{ value: 'pickup', label: _(msg`Pickup`) },
						{ value: 'delivery', label: _(msg`Delivery`) },
					]}
					value={fulfillment}
					disabled={!editable}
					onValueChange={(value) =>
						value && setFulfillment(value as 'pickup' | 'delivery')
					}
				/>
			</div>

			<section className="space-y-2" aria-label={_(msg`Lines`)}>
				<h3 className="text-sm font-medium">
					<Trans>Lines</Trans>
				</h3>
				{lines.map((line, index) => (
					<div
						key={line.lineId ?? index}
						className="grid gap-2 sm:grid-cols-[1fr_6rem_8rem_auto]"
					>
						<TextField
							id={`quote-line-name-${index}`}
							label={<Trans>Item</Trans>}
							value={line.itemName}
							disabled={!editable}
							onChange={(event) =>
								setLines(
									lines.map((candidate, at) =>
										at === index
											? { ...candidate, itemName: event.target.value }
											: candidate,
									),
								)
							}
						/>
						<TextField
							id={`quote-line-qty-${index}`}
							label={<Trans>Quantity</Trans>}
							type="number"
							min={1}
							value={line.quantity}
							disabled={!editable}
							onChange={(event) =>
								setLines(
									lines.map((candidate, at) =>
										at === index
											? { ...candidate, quantity: event.target.value }
											: candidate,
									),
								)
							}
						/>
						<TextField
							id={`quote-line-price-${index}`}
							label={<Trans>Price each</Trans>}
							inputMode="decimal"
							dir="ltr"
							value={line.price}
							disabled={!editable}
							onChange={(event) =>
								setLines(
									lines.map((candidate, at) =>
										at === index
											? { ...candidate, price: event.target.value }
											: candidate,
									),
								)
							}
						/>
						{editable ? (
							<Button
								variant="ghost"
								size="sm"
								className="self-end"
								onClick={() => setLines(lines.filter((_, at) => at !== index))}
							>
								<Trans>Remove</Trans>
							</Button>
						) : null}
					</div>
				))}
				{editable ? (
					<div className="flex flex-wrap items-end gap-2">
						{dishes.length > 0 ? (
							<SelectField
								id="quote-add-dish"
								label={<Trans>Add a dish from the catering menu</Trans>}
								options={dishes.map((dish) => ({
									value: dish.id,
									label: `${dish.name} (${money(dish.priceCents)})`,
								}))}
								value=""
								placeholder={_(msg`Choose a dish`)}
								onValueChange={(value) => {
									const dish = dishes.find(
										(candidate) => candidate.id === value,
									)
									if (!dish) return
									setLines([
										...lines,
										{
											itemId: dish.id,
											itemName: dish.name,
											quantity: '1',
											price: minorToMajorText(dish.priceCents, currency),
											taxable: true,
										},
									])
								}}
							/>
						) : null}
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								setLines([
									...lines,
									{
										itemId: null,
										itemName: '',
										quantity: '1',
										price: '',
										taxable: true,
									},
								])
							}
						>
							<Trans>Add another line</Trans>
						</Button>
					</div>
				) : null}
			</section>

			<section className="space-y-2" aria-label={_(msg`Charges`)}>
				<h3 className="text-sm font-medium">
					<Trans>Delivery, setup and other charges</Trans>
				</h3>
				{charges.map((charge, index) => (
					<div
						key={charge.chargeId ?? index}
						className="grid gap-2 sm:grid-cols-[10rem_1fr_8rem_auto]"
					>
						<SelectField
							id={`quote-charge-kind-${index}`}
							label={<Trans>Type</Trans>}
							options={[
								{ value: 'delivery', label: _(msg`Delivery`) },
								{ value: 'setup', label: _(msg`Setup`) },
								{ value: 'service', label: _(msg`Service`) },
								{ value: 'other', label: _(msg`Other`) },
							]}
							value={charge.kind}
							disabled={!editable}
							onValueChange={(value) =>
								value &&
								setCharges(
									charges.map((candidate, at) =>
										at === index
											? { ...candidate, kind: value as DraftCharge['kind'] }
											: candidate,
									),
								)
							}
						/>
						<TextField
							id={`quote-charge-label-${index}`}
							label={<Trans>Label</Trans>}
							value={charge.label}
							disabled={!editable}
							onChange={(event) =>
								setCharges(
									charges.map((candidate, at) =>
										at === index
											? { ...candidate, label: event.target.value }
											: candidate,
									),
								)
							}
						/>
						<TextField
							id={`quote-charge-amount-${index}`}
							label={<Trans>Amount</Trans>}
							inputMode="decimal"
							dir="ltr"
							value={charge.amount}
							disabled={!editable}
							onChange={(event) =>
								setCharges(
									charges.map((candidate, at) =>
										at === index
											? { ...candidate, amount: event.target.value }
											: candidate,
									),
								)
							}
						/>
						{editable ? (
							<Button
								variant="ghost"
								size="sm"
								className="self-end"
								onClick={() =>
									setCharges(charges.filter((_, at) => at !== index))
								}
							>
								<Trans>Remove</Trans>
							</Button>
						) : null}
					</div>
				))}
				{editable && charges.length < 10 ? (
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							setCharges([
								...charges,
								{
									kind: 'delivery',
									label: _(msg`Delivery`),
									amount: '',
									taxable: false,
								},
							])
						}
					>
						<Trans>Add a charge</Trans>
					</Button>
				) : null}
			</section>

			<TextAreaField
				id="quote-note"
				label={<Trans>Note for the guest</Trans>}
				optional
				rows={3}
				maxLength={1000}
				value={note}
				disabled={!editable}
				onChange={(event) => setNote(event.target.value)}
			/>
			<div className="grid gap-3 sm:grid-cols-2">
				<TextField
					id="quote-valid"
					label={<Trans>Open for (days after sending)</Trans>}
					type="number"
					min={1}
					max={90}
					value={validDays}
					disabled={!editable}
					onChange={(event) => setValidDays(event.target.value)}
				/>
				<TextField
					id="quote-deposit"
					label={<Trans>Deposit for this quote (percent)</Trans>}
					hint={<Trans>Leave empty to use the location&apos;s deposit.</Trans>}
					type="number"
					min={0}
					max={100}
					value={deposit}
					disabled={!editable}
					onChange={(event) => setDeposit(event.target.value)}
				/>
			</div>
			<p className="text-muted-foreground text-sm">
				<Trans>
					Before tax: <bdi>{subtotalLabel}</bdi>. The restaurant&apos;s tax
					settings add the tax when you save.
				</Trans>
			</p>
			{quote && quote.totalCents > 0 ? (
				<p className="text-sm font-medium" data-testid="catering-quote-total">
					<Trans>
						Guest pays <bdi>{totalLabel}</bdi> with tax.
					</Trans>
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			<div className="flex flex-wrap gap-2">
				{editable ? (
					<>
						<Button
							disabled={busy}
							variant="outline"
							onClick={() => void save(false)}
							data-testid="catering-quote-save"
						>
							<Trans>Save</Trans>
						</Button>
						<Button
							disabled={busy}
							onClick={() => void save(true)}
							data-testid="catering-quote-send"
						>
							{quote?.status === 'sent' ? (
								<Trans>Save and send again</Trans>
							) : (
								<Trans>Save and send</Trans>
							)}
						</Button>
						{quote ? (
							<Button
								disabled={busy}
								variant="ghost"
								onClick={() => void cancelQuote()}
							>
								<Trans>Cancel this quote</Trans>
							</Button>
						) : null}
					</>
				) : null}
				<Button variant="ghost" onClick={() => onClose(false)}>
					<Trans>Close</Trans>
				</Button>
			</div>
		</div>
	)
}
