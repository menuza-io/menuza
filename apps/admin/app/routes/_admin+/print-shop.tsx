import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	PRINT_VENDOR_CHECK_HOLDS,
	PRINT_VENDOR_NAMES,
} from '@repo/common/print-shop'
import { brand } from '@repo/config/brand'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
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
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { type ReactNode, useId, useRef, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { PRINT_VERTICAL_PRODUCT_LABELS } from '#app/components/print/vertical-labels.ts'
import { action, loader, type PrintAdminResult } from './print-shop.server.ts'

export { action, loader }

function money(cents: number, locale: string) {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency: 'USD',
	}).format(cents / 100)
}

const PRODUCT_LABELS: Record<string, MessageDescriptor> = {
	poster: msg`Poster`,
	flyer: msg`Flyer`,
	window_sticker: msg`Window sticker`,
	...PRINT_VERTICAL_PRODUCT_LABELS,
}

/** The platform is the merchant of shipped prints. */
const platform = brand.name

const STATUS_LABELS: Record<string, MessageDescriptor> = {
	quote: msg`Price ready`,
	awaiting_payment: msg`Waiting for payment`,
	paid: msg`Paid`,
	submitting: msg`Sending to the printer`,
	cancelling: msg`Cancelling`,
	submitted: msg`Sent to the printer`,
	in_production: msg`Printing`,
	shipped: msg`Shipped`,
	delivered: msg`Delivered`,
	held: msg`On hold`,
	failed: msg`Failed`,
	cancelled: msg`Cancelled`,
	refunded: msg`Refunded`,
}

const HOLD_LABELS: Record<string, MessageDescriptor> = {
	price_drift: msg`Wholesale price rose past the drift limit`,
	render_unavailable: msg`The print file could not be made`,
	vendor_unavailable: msg`The vendor did not answer`,
	vendor_unknown: msg`The vendor may have the order: check before retrying`,
	vendor_rejected: msg`The vendor refused the order`,
	vendor_failed: msg`The vendor failed the order`,
	vendor_cancelled: msg`The vendor cancelled the order`,
	cancelled_by_operator: msg`Cancelled by the organization`,
	refunded_by_admin: msg`Refunded by an admin`,
	payment_failed: msg`The payment failed`,
	submission_error: msg`Sending to the vendor failed unexpectedly`,
	refund_failed: msg`The vendor order was cancelled but the refund failed`,
	partial_cancel: msg`Some vendor orders were cancelled and others are printing: refund what was cancelled`,
	stale_claim: msg`A submission or cancellation stopped halfway: check the vendor before retrying`,
	late_payment: msg`Paid after it was cancelled, refunded automatically`,
}

/**
 * A fetcher action that asks first: money and catalog changes are not undone.
 * The dialog stays open until the action succeeds and shows a refusal inside
 * itself (never behind the overlay); extra fields (an amount) go in children.
 */
function ConfirmedAction({
	fetcher,
	fields,
	label,
	accessibleLabel,
	title,
	description,
	confirmLabel,
	variant = 'ghost',
	destructive = false,
	children,
	onDone,
}: {
	fetcher: ReturnType<typeof useFetcher<PrintAdminResult>>
	fields: Record<string, string>
	label: string
	accessibleLabel: string
	title: string
	description: string
	confirmLabel: string
	variant?: 'ghost' | 'outline' | 'default'
	destructive?: boolean
	children?: ReactNode
	/** After this action's request finished (its button may be gone). */
	onDone?: () => void
}) {
	const { _ } = useLingui()
	const formId = useId()
	const [wantsOpen, setWantsOpen] = useState(false)
	// Several actions share a row's fetcher, which still holds the previous
	// answer when this one is sent: only an answer after the send counts.
	const [sentOver, setSentOver] = useState<PrintAdminResult | undefined | null>(
		null,
	)
	const answered =
		sentOver !== null && fetcher.state === 'idle' && fetcher.data !== sentOver
	// Its own answer was a success: close for good (adjusted during render),
	// so a later action on the shared fetcher does not bring this dialog back.
	if (wantsOpen && answered && fetcher.data?.ok === true) {
		setWantsOpen(false)
		setSentOver(null)
	}
	return (
		<AlertDialog
			open={wantsOpen}
			onOpenChange={(next) => {
				setWantsOpen(next)
				setSentOver(null)
			}}
		>
			<AlertDialogTrigger
				render={
					<Button
						size="sm"
						variant={variant}
						aria-label={accessibleLabel}
						disabled={fetcher.state !== 'idle'}
					>
						{label}
					</Button>
				}
			/>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<fetcher.Form
					id={formId}
					method="POST"
					onSubmit={(event) => {
						event.preventDefault()
						setSentOver(fetcher.data)
						// The promise settles after the reload, even when that removed
						// this control: the row then puts focus back where it belongs.
						void fetcher.submit(event.currentTarget).then(() => onDone?.())
					}}
				>
					{Object.entries(fields).map(([name, value]) => (
						<input key={name} type="hidden" name={name} value={value} />
					))}
					{children}
				</fetcher.Form>
				{answered && fetcher.data?.ok === false ? (
					<Result data={fetcher.data} />
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel>{_(msg`Cancel`)}</AlertDialogCancel>
					<Button
						type="submit"
						form={formId}
						variant={destructive ? 'destructive' : 'default'}
						disabled={fetcher.state !== 'idle'}
					>
						{confirmLabel}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

/** Refusals from the App and this route, in the admin's language. */
const ERROR_MESSAGES: Record<string, MessageDescriptor> = {
	app_not_configured: msg`The App link is not set up (APP_URL or INTERNAL_COMMAND_TOKEN).`,
	app_unreachable: msg`The App did not answer. Try again.`,
	app_error: msg`The App could not do that. Try again.`,
	invalid_form: msg`Check the form values.`,
	invalid_request: msg`Check the form values.`,
	not_shippable: msg`That product and size cannot ship.`,
	missing_vendor_order_id: msg`Enter the vendor order id.`,
	check_vendor: msg`The vendor may already have this order. Search the vendor dashboard for its references first.`,
	vendor_printing: msg`A vendor already started printing this order, so nothing was refunded. Use "Refund, vendor keeps printing" if the vendor should still ship it.`,
	invalid_amount: msg`Enter an amount above zero and no more than what is left to refund.`,
	not_partial: msg`Only an order held after a partial cancel can be refunded in part.`,
	not_refundable: msg`Only a paid order can be refunded.`,
	order_busy: msg`This order is changing right now. Refresh and try again.`,
	partial_cancel: msg`Part of this order was already printing. Refund what was cancelled.`,
	refund_needed: msg`Vendors were cancelled for this order: refund it instead of retrying.`,
	not_held: msg`Only a held order can be retried or updated.`,
	not_pending: msg`That vendor order is not waiting to be sent.`,
	vendor_order_not_found: msg`The vendor does not know that order id. Check it and try again.`,
}

function ErrorMessage({ code, fallback }: { code: string; fallback: string }) {
	const { _ } = useLingui()
	const message = ERROR_MESSAGES[code]
	return <>{message ? _(message) : fallback}</>
}

function Result({
	data,
	item,
}: {
	data: PrintAdminResult | undefined
	/** Names the row the message belongs to, for screen readers. */
	item?: string
}) {
	if (!data) return null
	if (!data.ok) {
		return (
			<p role="alert" className="text-destructive text-sm">
				<ErrorMessage code={data.code} fallback={data.message} />
			</p>
		)
	}
	return (
		<p role="status" className="text-muted-foreground text-sm">
			{data.done === 'refunded' ? (
				<Trans>Refund sent.</Trans>
			) : data.done === 'sent' ? (
				<Trans>Sent to the vendor again.</Trans>
			) : data.done === 'recorded' ? (
				<Trans>Vendor order recorded. Tracking resumes.</Trans>
			) : item ? (
				<Trans>Saved: {item}</Trans>
			) : (
				<Trans>Saved.</Trans>
			)}
		</p>
	)
}

function SettingsCard({
	settings,
}: {
	settings: { markupBp: number; driftHoldBp: number; quoteTtlMinutes: number }
}) {
	const fetcher = useFetcher<PrintAdminResult>()
	const id = useId()
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Pricing rules</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Retail is the vendor's wholesale price plus the markup; shipping is
						passed through. A paid order whose wholesale price rose by more than
						the drift limit is held here.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<fetcher.Form method="POST" className="flex flex-wrap items-end gap-4">
					<input type="hidden" name="_action" value="settings" />
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-markup`}>
							<Trans>Markup (%)</Trans>
						</Label>
						<Input
							id={`${id}-markup`}
							name="markupPercent"
							inputMode="decimal"
							defaultValue={settings.markupBp / 100}
							className="w-28"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-drift`}>
							<Trans>Drift limit (%)</Trans>
						</Label>
						<Input
							id={`${id}-drift`}
							name="driftPercent"
							inputMode="decimal"
							defaultValue={settings.driftHoldBp / 100}
							className="w-28"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor={`${id}-ttl`}>
							<Trans>Quote valid (minutes)</Trans>
						</Label>
						<Input
							id={`${id}-ttl`}
							name="quoteTtlMinutes"
							inputMode="numeric"
							defaultValue={settings.quoteTtlMinutes}
							className="w-28"
						/>
					</div>
					<Button type="submit" disabled={fetcher.state !== 'idle'}>
						<Trans>Save</Trans>
					</Button>
				</fetcher.Form>
				<Result data={fetcher.data} />
			</CardContent>
		</Card>
	)
}

function CatalogCard({
	sizes,
	catalog,
}: {
	sizes: Array<{ product: string; sizeKey: string; label: string }>
	catalog: Array<{
		id: string
		product: string
		sizeKey: string
		vendor: string
		vendorSku: string
		bleedMm: number
	}>
}) {
	const { _ } = useLingui()
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Vendor catalog</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Each shippable product and size prints at one vendor. Changing the
						vendor here is how orders are rerouted: retrying a held order picks
						up the new mapping.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{_(msg`Product and size`)}</TableHead>
							<TableHead>{_(msg`Vendor`)}</TableHead>
							<TableHead>{_(msg`Vendor SKU`)}</TableHead>
							<TableHead>{_(msg`Bleed (mm)`)}</TableHead>
							<TableHead>
								<span className="sr-only">{_(msg`Actions`)}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{sizes.map((size) => {
							const current = catalog.find(
								(row) =>
									row.product === size.product && row.sizeKey === size.sizeKey,
							)
							return (
								<CatalogRow
									key={`${size.product}:${size.sizeKey}`}
									size={size}
									current={current}
								/>
							)
						})}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	)
}

function CatalogRow({
	size,
	current,
}: {
	size: { product: string; sizeKey: string; label: string }
	current?: { id: string; vendor: string; vendorSku: string; bleedMm: number }
}) {
	const fetcher = useFetcher<PrintAdminResult>()
	const { _ } = useLingui()
	const formId = `catalog-${size.product}-${size.sizeKey}`
	// Every control names its row: a screen reader hears "Vendor, Poster A3",
	// not fifteen identical "Vendor" fields.
	const item = `${
		PRODUCT_LABELS[size.product]
			? _(PRODUCT_LABELS[size.product]!)
			: size.product
	} ${size.label}`
	return (
		<TableRow>
			<TableCell>
				<span className="font-medium">
					{PRODUCT_LABELS[size.product]
						? _(PRODUCT_LABELS[size.product]!)
						: size.product}
				</span>{' '}
				<bdi className="text-muted-foreground">{size.label}</bdi>
				<fetcher.Form id={formId} method="POST">
					<input type="hidden" name="_action" value="catalog" />
					<input type="hidden" name="product" value={size.product} />
					<input type="hidden" name="sizeKey" value={size.sizeKey} />
				</fetcher.Form>
				<Result data={fetcher.data} item={item} />
			</TableCell>
			<TableCell>
				<select
					form={formId}
					name="vendor"
					defaultValue={current?.vendor ?? 'gelato'}
					aria-label={_(msg`Vendor, ${item}`)}
					className="border-input bg-background h-9 rounded-md border px-2 text-sm"
				>
					{PRINT_VENDOR_NAMES.map((vendor) => (
						<option key={vendor} value={vendor}>
							{vendor}
						</option>
					))}
				</select>
			</TableCell>
			<TableCell>
				<Input
					form={formId}
					name="vendorSku"
					defaultValue={current?.vendorSku ?? ''}
					aria-label={_(msg`Vendor SKU, ${item}`)}
					className="min-w-48"
				/>
			</TableCell>
			<TableCell>
				<Input
					form={formId}
					name="bleedMm"
					inputMode="numeric"
					defaultValue={current?.bleedMm ?? 3}
					aria-label={_(msg`Bleed in millimetres, ${item}`)}
					className="w-20"
				/>
			</TableCell>
			<TableCell className="whitespace-nowrap">
				<Button
					type="submit"
					form={formId}
					size="sm"
					disabled={fetcher.state !== 'idle'}
					aria-label={current ? _(msg`Update ${item}`) : _(msg`Enable ${item}`)}
				>
					{current ? _(msg`Update`) : _(msg`Enable`)}
				</Button>
				{current ? (
					<ConfirmedAction
						fetcher={fetcher}
						fields={{ _action: 'catalog-remove', id: current.id }}
						label={_(msg`Stop shipping`)}
						accessibleLabel={(() => {
							return _(msg`Stop shipping ${item}`)
						})()}
						title={_(msg`Stop shipping this size?`)}
						description={_(
							msg`No organization can order it shipped until it is enabled again. Downloads keep working.`,
						)}
						confirmLabel={_(msg`Stop shipping`)}
						destructive
					/>
				) : null}
			</TableCell>
		</TableRow>
	)
}

function VendorOrderField({
	reference,
	name,
}: {
	reference: string
	name: string
}) {
	const { _ } = useLingui()
	const id = useId()
	return (
		<div className="flex flex-col gap-1">
			<Label htmlFor={id}>{_(msg`Vendor order id for ${reference}`)}</Label>
			<Input id={id} name={name} required maxLength={200} />
		</div>
	)
}

function OrderActions({
	order,
}: {
	order: {
		id: string
		status: string
		organization: string
		totalCents: number
		refundCents: number
		holdReason: string | null
		vendorReferences: Array<{ id: string; vendor: string; pending: boolean }>
		createdAt: string
	}
}) {
	const fetcher = useFetcher<PrintAdminResult>()
	const retryFetcher = useFetcher<PrintAdminResult>()
	const partId = useId()
	const rowRef = useRef<HTMLDivElement>(null)
	// A successful action can remove the button (and the dialog) that had
	// focus: land on this order's actions instead of the top of the page.
	const returnFocus = () => {
		const check = () => {
			const active = document.activeElement
			if (!active || active === document.body || !active.isConnected) {
				rowRef.current?.focus()
			}
		}
		// Once now, and once after a closing dialog has handed focus back
		// (possibly to a button the reload removed).
		window.requestAnimationFrame(check)
		window.setTimeout(check, 300)
	}
	const { _, i18n } = useLingui()
	// A vendor may already be printing (or has shipped): refunding in full
	// then means the platform still pays the vendor, so it is its own action.
	const vendorMayPrint = [
		'in_production',
		'shipped',
		'delivered',
		'held',
	].includes(order.status)
	const left = money(order.totalCents - order.refundCents, i18n.locale)
	const refundable = ![
		'refunded',
		'cancelled',
		'quote',
		'awaiting_payment',
	].includes(order.status)
	const organization = order.organization
	const amount = money(order.totalCents, i18n.locale)
	const placed = new Intl.DateTimeFormat(i18n.locale, {
		dateStyle: 'medium',
	}).format(new Date(order.createdAt))
	// One organization can have several orders: every label names this one.
	const orderName = _(
		msg`the ${amount} order of ${organization} placed ${placed}`,
	)
	const references = order.vendorReferences.map(
		(reference) => `${reference.vendor}: ${reference.id}`,
	)
	const pendingReferences = order.vendorReferences.filter(
		(reference) => reference.pending,
	)
	// After a send that may have reached the vendor, a refund needs the same
	// look at the vendor as a retry.
	const vendorCheck = PRINT_VENDOR_CHECK_HOLDS.includes(order.holdReason ?? '')
	const checkFields: Record<string, string> = vendorCheck
		? { checkedVendor: 'true' }
		: {}
	const checkNote = vendorCheck
		? ' ' +
			_(
				msg`The vendor may already have this order: search the vendor dashboard first and cancel it there if you find it.`,
			)
		: ''
	return (
		<div
			ref={rowRef}
			tabIndex={-1}
			role="group"
			aria-label={orderName}
			className="flex flex-wrap gap-2 outline-none"
		>
			{order.status === 'held' &&
			PRINT_VENDOR_CHECK_HOLDS.includes(order.holdReason ?? '') ? (
				<ConfirmedAction
					fetcher={fetcher}
					onDone={returnFocus}
					fields={{ _action: 'retry-checked', orderId: order.id }}
					label={_(msg`Retry`)}
					accessibleLabel={_(msg`Retry, ${orderName}`)}
					title={_(msg`Did the vendor get this order?`)}
					description={
						references.length > 0
							? (() => {
									const list = new Intl.ListFormat(i18n.locale, {
										type: 'unit',
									}).format(references)
									return _(
										msg`The last attempt stopped after the order was sent, so the vendor may already have it. Search the vendor dashboard for: ${list}. If the vendor has it, do not retry (it would print twice): refund or wait for its status. Retry only if you find nothing.`,
									)
								})()
							: _(
									msg`The last attempt stopped after the order was sent, so the vendor may already have it, and no reference was recorded. Search the vendor dashboard by date and recipient. If the vendor has it, do not retry (it would print twice). Retry only if you find nothing.`,
								)
					}
					confirmLabel={_(msg`I found nothing, retry`)}
					variant="outline"
				/>
			) : null}
			{order.status === 'held' &&
			vendorCheck &&
			pendingReferences.length > 0 ? (
				<ConfirmedAction
					fetcher={fetcher}
					onDone={returnFocus}
					fields={{ _action: 'record-vendor-order', orderId: order.id }}
					label={_(msg`Found it at the vendor`)}
					accessibleLabel={_(msg`Found it at the vendor, ${orderName}`)}
					title={_(msg`Record the vendor's order`)}
					description={_(
						msg`Enter the order id the vendor shows for each reference. Nothing is sent again; tracking, cancelling and refunds then follow the vendor's order.`,
					)}
					confirmLabel={_(msg`Record and track`)}
					variant="outline"
				>
					<div className="flex flex-col gap-3">
						{pendingReferences.map((reference) => (
							<VendorOrderField
								key={reference.id}
								reference={`${reference.vendor}: ${reference.id}`}
								name={`vendorOrder.${reference.id}`}
							/>
						))}
					</div>
				</ConfirmedAction>
			) : null}
			{order.status === 'held' && vendorCheck ? null : order.status ===
			  'held' ? (
				<>
					<retryFetcher.Form
						method="POST"
						onSubmit={(event) => {
							event.preventDefault()
							void retryFetcher.submit(event.currentTarget).then(returnFocus)
						}}
					>
						<input type="hidden" name="_action" value="retry" />
						<input type="hidden" name="orderId" value={order.id} />
						<Button
							type="submit"
							size="sm"
							disabled={
								fetcher.state !== 'idle' || retryFetcher.state !== 'idle'
							}
							aria-label={_(msg`Retry, ${orderName}`)}
						>
							{_(msg`Retry`)}
						</Button>
					</retryFetcher.Form>
					<ConfirmedAction
						fetcher={fetcher}
						onDone={returnFocus}
						fields={{ _action: 'retry-accept', orderId: order.id }}
						label={_(msg`Accept new price`)}
						accessibleLabel={_(msg`Accept new price, ${orderName}`)}
						title={_(msg`Accept the new wholesale price?`)}
						description={_(
							msg`The order goes to the vendor at today's price. The organization already paid ${amount}; ${platform} absorbs the difference.`,
						)}
						confirmLabel={_(msg`Accept and send`)}
						variant="outline"
					/>
				</>
			) : null}
			{refundable ? (
				<ConfirmedAction
					fetcher={fetcher}
					onDone={returnFocus}
					fields={{ _action: 'refund', orderId: order.id, ...checkFields }}
					label={_(msg`Refund in full`)}
					accessibleLabel={_(msg`Refund in full, ${orderName}`)}
					title={_(msg`Refund ${amount} to ${organization}?`)}
					description={
						_(
							msg`Vendor orders not yet printing are cancelled first, then the full amount goes back to the card they paid with. If a vendor already started, nothing is refunded. This cannot be undone.`,
						) + checkNote
					}
					confirmLabel={_(msg`Refund in full`)}
					destructive
				/>
			) : null}
			{refundable && vendorMayPrint ? (
				<ConfirmedAction
					fetcher={fetcher}
					onDone={returnFocus}
					fields={{ _action: 'refund-keep', orderId: order.id, ...checkFields }}
					label={_(msg`Refund, vendor keeps printing`)}
					accessibleLabel={_(msg`Refund, vendor keeps printing, ${orderName}`)}
					title={_(msg`Refund ${amount} and keep the vendor order?`)}
					description={
						_(
							msg`For a defect claim or a lost parcel: the full amount goes back to the card, and the vendor keeps printing and shipping at ${platform}'s cost. This cannot be undone.`,
						) + checkNote
					}
					confirmLabel={_(msg`Refund in full`)}
					destructive
				/>
			) : null}
			{refundable && order.holdReason === 'partial_cancel' ? (
				<ConfirmedAction
					fetcher={fetcher}
					onDone={returnFocus}
					fields={{ _action: 'refund-part', orderId: order.id }}
					label={_(msg`Refund part`)}
					accessibleLabel={_(msg`Refund part, ${orderName}`)}
					title={_(msg`Refund part of this order to ${organization}?`)}
					description={_(
						msg`Refund what the vendors cancelled. The order leaves hold and the rest keeps printing and is tracked again. This cannot be undone.`,
					)}
					confirmLabel={_(msg`Refund this amount`)}
					variant="outline"
					destructive
				>
					<div className="flex flex-col gap-1">
						<Label htmlFor={partId}>
							{_(msg`Amount in US dollars, up to ${left}`)}
						</Label>
						<Input
							id={partId}
							name="amount"
							inputMode="decimal"
							required
							className="w-32"
						/>
					</div>
				</ConfirmedAction>
			) : null}
			{/* Dialog refusals show inside their dialog; the row reports successes. */}
			{fetcher.data?.ok ? <Result data={fetcher.data} /> : null}
			<Result data={retryFetcher.data} />
		</div>
	)
}

export default function PrintShopAdminRoute() {
	const { _, i18n } = useLingui()
	const data = useLoaderData<typeof loader>()
	const margin = data.orders.reduce((sum, order) => sum + order.marginCents, 0)
	return (
		<div className="space-y-6">
			<PageHeader
				title={_(msg`Print shop`)}
				description={_(
					msg`Shipped prints across all organizations: pricing, vendors and orders.`,
				)}
			/>
			<SettingsCard settings={data.settings} />
			<CatalogCard sizes={data.sizes} catalog={data.catalog} />
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Orders</Trans>
					</CardTitle>
					<CardDescription>
						{(() => {
							const total = money(margin, i18n.locale)
							return _(msg`Margin on the orders below: ${total}`)
						})()}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{_(msg`Organization`)}</TableHead>
								<TableHead>{_(msg`Status`)}</TableHead>
								<TableHead>{_(msg`Total`)}</TableHead>
								<TableHead>{_(msg`Wholesale`)}</TableHead>
								<TableHead>{_(msg`Margin`)}</TableHead>
								<TableHead>{_(msg`Placed`)}</TableHead>
								<TableHead>
									<span className="sr-only">{_(msg`Actions`)}</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.orders.map((order) => (
								<TableRow key={order.id}>
									<TableCell className="wrap-anywhere">
										{order.organization}
									</TableCell>
									<TableCell>
										<Badge
											variant={
												order.status === 'held' ? 'warning' : 'secondary'
											}
										>
											{STATUS_LABELS[order.status]
												? _(STATUS_LABELS[order.status]!)
												: order.status}
										</Badge>
										{order.holdReason || order.failureReason ? (
											<span className="text-muted-foreground block text-xs">
												{(() => {
													const reason = (order.holdReason ??
														order.failureReason)!
													return HOLD_LABELS[reason]
														? _(HOLD_LABELS[reason]!)
														: reason
												})()}
											</span>
										) : null}
									</TableCell>
									<TableCell className="tabular-nums">
										{money(order.totalCents, i18n.locale)}
									</TableCell>
									<TableCell className="tabular-nums">
										{money(order.wholesaleCents, i18n.locale)}
									</TableCell>
									<TableCell className="tabular-nums">
										{money(order.marginCents, i18n.locale)}
									</TableCell>
									<TableCell>
										{new Date(order.createdAt).toLocaleString(i18n.locale)}
									</TableCell>
									<TableCell>
										<OrderActions order={order} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
			</Card>
		</div>
	)
}
