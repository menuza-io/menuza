import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	MAX_ORDER_PACKS,
	type OrderDetail,
	orderDetailSchema,
	type OrderSendChannel,
	orderTextSchema,
	type SendOrderResult,
	sendOrderResultSchema,
	supplierDetailSchema,
	type SupplierProduct,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { QuantityStepper } from '@repo/ui/quantity-stepper'
import { Skeleton } from '@repo/ui/skeleton'
import { Textarea } from '@repo/ui/textarea'
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { SendOrderDialog } from '#app/components/inventory/send-order-dialog.tsx'
import { MenuFormHeader } from '#app/components/menu/menu-form-header.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import {
	inventoryReceivePath,
	inventoryTabPath,
} from '#app/utils/inventory/nav.ts'
import {
	cutoffText,
	defaultSendChannel,
	type DraftOrderLine,
	draftLinesFromOrder,
	draftTotals,
	linesChanged,
	ORDER_STATUS_LABELS,
	orderIsOpen,
	orderLinesPayload,
	orderStatusVariant,
	packStep,
	packsText,
	SEND_CHANNEL_LABELS,
	shortDayText,
	textLocale,
} from '#app/utils/inventory/order-view.ts'

/**
 * Review order, a full page: the lines in packs with steppers, the total
 * against the supplier's minimum and cut-off, the expected date and a note.
 * A draft is edited and saved here; Send lives in a menu and asks once more
 * before it leaves (email, WhatsApp, copy the text, or print as a PDF).
 * Nothing is ever sent without this review.
 */
export function ReviewOrderScreen({
	orgSlug,
	orderId,
	currency,
	canEdit,
	canSeeCost,
	canManagePurchasing,
	search,
}: {
	orgSlug: string
	orderId: string
	currency: string
	canEdit: boolean
	canSeeCost: boolean
	canManagePurchasing: boolean
	search: string
}) {
	const { t, i18n } = useLingui()
	const navigate = useNavigate()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const backHref = `${inventoryTabPath(orgSlug, 'purchasing')}${search}`

	const query = useInventoryQuery(
		`/orders/${encodeURIComponent(orderId)}`,
		orderDetailSchema,
	)
	const order = query.data

	const [lines, setLines] = useState<DraftOrderLine[]>([])
	const [note, setNote] = useState('')
	const [expectedDate, setExpectedDate] = useState('')
	const [seededFor, setSeededFor] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [sendChannel, setSendChannel] = useState<OrderSendChannel | null>(null)
	const [cancelOpen, setCancelOpen] = useState(false)
	const [cancelNote, setCancelNote] = useState('')
	const [cancelling, setCancelling] = useState(false)
	const [printing, setPrinting] = useState<string | null>(null)
	const [localKey, setLocalKey] = useState(0)

	// The editor starts from what the region has, and starts over whenever a
	// save changes the version.
	const seedKey = order ? `${order.id}:${order.version}` : null
	useEffect(() => {
		if (!order || seedKey === seededFor) return
		setLines(draftLinesFromOrder(order))
		setNote(order.note ?? '')
		setExpectedDate(order.expectedDate ?? '')
		setSeededFor(seedKey)
	}, [order, seedKey, seededFor])

	const editable = order?.status === 'draft' && canManagePurchasing
	const detailsEditable =
		order !== null && orderIsOpen(order.status) && canManagePurchasing
	const supplier = useInventoryQuery(
		order && editable
			? `/suppliers/${encodeURIComponent(order.supplierId)}`
			: null,
		supplierDetailSchema,
	)

	useEffect(() => {
		if (!printing) return
		const clear = () => setPrinting(null)
		window.addEventListener('afterprint', clear, { once: true })
		const timer = window.setTimeout(() => window.print(), 50)
		return () => {
			window.clearTimeout(timer)
			window.removeEventListener('afterprint', clear)
		}
	}, [printing])

	const dirty =
		order !== null &&
		seededFor === seedKey &&
		((editable && linesChanged(lines, order.lines)) ||
			(detailsEditable &&
				(note.trim() !== (order.note ?? '') ||
					expectedDate !== (order.expectedDate ?? ''))))

	const money = (minor: number) =>
		formatMoney(minor, order?.currency ?? currency, i18n.locale)

	const totals = useMemo(
		() =>
			draftTotals(
				lines,
				order?.minimumOrderMinor,
				canSeeCost && order?.totalMinor !== undefined,
			),
		[lines, order?.minimumOrderMinor, order?.totalMinor, canSeeCost],
	)

	function patchLine(
		key: string,
		update: (line: DraftOrderLine) => DraftOrderLine,
	) {
		setLines((current) =>
			current.map((line) => (line.key === key ? update(line) : line)),
		)
	}

	function addProduct(product: SupplierProduct) {
		const key = `new-${localKey}`
		setLocalKey((current) => current + 1)
		setLines((current) => [
			...current,
			{
				key,
				itemId: product.itemId,
				itemName: product.itemName,
				supplierProductId: product.id,
				packName: product.packName,
				packBaseQuantity: product.packBaseQuantity,
				pricedByWeight: product.pricedByWeight,
				baseUnit: null,
				countUnit: null,
				packs: packStep(product),
				suggestedPacks: null,
				onHand: null,
				fillUpToQuantity: null,
				packPriceMinor: canSeeCost ? (product.priceMinor ?? null) : null,
			},
		])
	}

	/** PATCH what changed; the region answers the order with its new version. */
	async function save(): Promise<OrderDetail> {
		if (!order) throw new Error('no order')
		const body: Record<string, unknown> = { expectedVersion: order.version }
		if (editable && linesChanged(lines, order.lines)) {
			body.lines = orderLinesPayload(lines)
		}
		if (detailsEditable) {
			if (expectedDate !== (order.expectedDate ?? '')) {
				body.expectedDate = expectedDate === '' ? null : expectedDate
			}
			if (note.trim() !== (order.note ?? '')) {
				body.note = note.trim() === '' ? null : note.trim()
			}
		}
		if (Object.keys(body).length === 1) return order
		const saved = orderDetailSchema.parse(
			await request(`/orders/${encodeURIComponent(order.id)}`, {
				method: 'PATCH',
				body: JSON.stringify(body),
			}),
		)
		notifyChanged()
		query.reload()
		return saved
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (saving || !dirty) return
		setSaving(true)
		setError(null)
		try {
			await save()
			toast.success(
				order?.status === 'draft' ? t`Draft saved.` : t`Order updated.`,
			)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setSaving(false)
		}
	}

	async function sendNow(channel: OrderSendChannel) {
		if (!order) throw new Error('no order')
		const saved = dirty ? await save() : order
		const result: SendOrderResult = sendOrderResultSchema.parse(
			await request(`/orders/${encodeURIComponent(order.id)}/send`, {
				method: 'POST',
				body: JSON.stringify({
					expectedVersion: saved.version,
					channel,
					locale: textLocale(i18n.locale),
				}),
			}),
		)
		notifyChanged()
		query.reload()
		return result
	}

	async function cancelOrder() {
		if (!order || cancelling) return
		setCancelling(true)
		setError(null)
		try {
			orderDetailSchema.parse(
				await request(`/orders/${encodeURIComponent(order.id)}/cancel`, {
					method: 'POST',
					body: JSON.stringify({
						expectedVersion: order.version,
						...(cancelNote.trim() === '' ? {} : { note: cancelNote.trim() }),
					}),
				}),
			)
			toast.success(t`Order cancelled.`)
			notifyChanged()
			void navigate(backHref)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
			setCancelOpen(false)
			query.reload()
		} finally {
			setCancelling(false)
		}
	}

	async function printNow() {
		if (!order) return
		try {
			const { text } = orderTextSchema.parse(
				await request(
					`/orders/${encodeURIComponent(order.id)}/text?locale=${textLocale(i18n.locale)}`,
				),
			)
			setPrinting(text)
		} catch (caught) {
			toast.error(i18n._(inventoryErrorMessage(caught)))
		}
	}

	if (query.error && !order) {
		return (
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
				<Alert variant="destructive" data-testid="order-load-error">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(query.error))}
					</AlertDescription>
				</Alert>
				<div className="flex gap-2">
					<Button variant="outline" onClick={query.reload}>
						<Trans>Try again</Trans>
					</Button>
					<Button variant="outline" render={<Link to={backHref} />}>
						<Trans>Back to purchasing</Trans>
					</Button>
				</div>
			</div>
		)
	}

	if (!order) {
		return (
			<div
				role="status"
				className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8"
			>
				<span className="sr-only">
					<Trans>Loading the order</Trans>
				</span>
				<Skeleton className="h-8 w-1/3" />
				<Skeleton className="h-48 w-full rounded-xl" />
			</div>
		)
	}

	const number = order.number
	const supplierName = order.supplierName
	const open = orderIsOpen(order.status)
	const itemCount = orderLinesPayload(lines).length
	const productsLeft = (supplier.data?.products ?? []).filter(
		(product) => !lines.some((line) => line.supplierProductId === product.id),
	)
	const shortOfMinimum = money(totals.shortOfMinimumMinor)
	const minimumOrder = money(order.minimumOrderMinor ?? 0)
	const email = order.supplierEmail
	const phone = order.supplierPhone
	const defaultChannel = defaultSendChannel(order.supplierOrderChannel, {
		email: email !== null && email !== '',
		phone: phone !== null && phone !== '',
	})
	const cutoff =
		order.cutoff && order.status === 'draft'
			? cutoffText(order.cutoff, i18n.locale)
			: null
	const canSend = canManagePurchasing && open && itemCount > 0
	const sentLabel = order.sentAt
		? new Intl.DateTimeFormat(i18n.locale, {
				dateStyle: 'medium',
				timeStyle: 'short',
			}).format(new Date(order.sentAt))
		: null

	const sendMenu =
		canManagePurchasing && open ? (
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							type="button"
							variant={order.status === 'draft' ? 'default' : 'outline'}
							disabled={!canSend || saving}
							data-testid="order-send-menu"
						>
							<Icon name="send" />
							{order.status === 'draft' ? (
								<Trans>Send</Trans>
							) : (
								<Trans>Send again</Trans>
							)}
							<Icon name="chevron-down" />
						</Button>
					}
				/>
				<DropdownMenuContent align="end">
					{(['email', 'whatsapp', 'copy', 'pdf'] as const).map((channel) => (
						<DropdownMenuItem
							key={channel}
							onClick={() => setSendChannel(channel)}
							data-testid={`order-send-${channel}`}
						>
							<Icon
								name={
									channel === 'email'
										? 'mail'
										: channel === 'whatsapp'
											? 'message-circle'
											: channel === 'copy'
												? 'copy'
												: 'printer'
								}
							/>
							{i18n._(SEND_CHANNEL_LABELS[channel])}
							{channel === defaultChannel ? (
								<span className="text-muted-foreground ms-auto text-xs">
									<Trans>Usual</Trans>
								</span>
							) : null}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		) : null

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			className="flex flex-1 flex-col"
			data-testid="review-order"
		>
			<MenuFormHeader
				pageTitle={<Trans>Order {number}</Trans>}
				titleAccessory={
					<Badge
						variant={orderStatusVariant(order.status)}
						data-testid="order-status"
					>
						{i18n._(ORDER_STATUS_LABELS[order.status])}
					</Badge>
				}
				backHref={backHref}
				backLabel={t`Back to purchasing`}
				saveButtonText={
					order.status === 'draft' ? t`Save draft` : t`Save changes`
				}
				isSubmitting={saving}
				saveDisabled={!dirty || !(editable || detailsEditable)}
				showCancel={false}
				secondaryAction={sendMenu}
			/>

			<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 lg:px-8">
				<div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
					<div className="flex flex-col gap-6 lg:col-span-8">
						{error ? (
							<Alert variant="destructive" data-testid="order-form-error">
								<Icon name="alert-triangle" />
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						{!canManagePurchasing ? (
							<Alert data-testid="order-read-only">
								<AlertDescription>
									<Trans>
										You can look at this order. Changing and sending orders
										needs the purchasing role.
									</Trans>
								</AlertDescription>
							</Alert>
						) : null}

						<Frame>
							<FrameHeader>
								<FrameTitle className="text-base">
									<Trans>Items</Trans>
								</FrameTitle>
								<FrameDescription>
									{editable ? (
										<Trans>
											Quantities are in packs, the way the supplier sells them.
										</Trans>
									) : (
										<Trans>
											What was ordered from{' '}
											<span className="wrap-anywhere">{supplierName}</span>.
										</Trans>
									)}
								</FrameDescription>
							</FrameHeader>
							<FramePanel className="flex flex-col gap-4">
								{lines.length === 0 ? (
									<p
										className="text-muted-foreground text-sm"
										data-testid="order-no-lines"
									>
										<Trans>No items yet. Add one below.</Trans>
									</p>
								) : (
									<ul className="flex flex-col gap-3" data-testid="order-lines">
										{lines.map((line) => {
											const saved = order.lines.find(
												(entry) => entry.id === line.key,
											)
											return (
												<OrderLine
													key={line.key}
													line={line}
													received={saved?.receivedQuantity ?? null}
													editable={editable}
													showStatus={!editable && order.status !== 'draft'}
													money={canSeeCost ? money : null}
													onChange={(packs) =>
														patchLine(line.key, (current) => ({
															...current,
															packs,
														}))
													}
													onRemove={() =>
														setLines((current) =>
															current.filter((entry) => entry.key !== line.key),
														)
													}
												/>
											)
										})}
									</ul>
								)}
								{editable && productsLeft.length > 0 ? (
									<SelectField
										label={<Trans>Add an item</Trans>}
										testId="order-add-item"
										placeholder={t`Choose an item this supplier sells`}
										options={productsLeft.map((product) => ({
											value: product.id,
											label: `${product.itemName} · ${product.packName}`,
										}))}
										value=""
										onValueChange={(id) => {
											const product = productsLeft.find((p) => p.id === id)
											if (product) addProduct(product)
										}}
									/>
								) : null}
							</FramePanel>
						</Frame>

						<Frame>
							<FrameHeader>
								<FrameTitle className="text-base">
									<Trans>Delivery and note</Trans>
								</FrameTitle>
							</FrameHeader>
							<FramePanel className="flex flex-col gap-4">
								<TextField
									label={<Trans>Expected delivery date</Trans>}
									optional
									type="date"
									value={expectedDate}
									disabled={!detailsEditable}
									onChange={(event) => setExpectedDate(event.target.value)}
									dir="ltr"
									hint={
										cutoff ? (
											<Trans>
												Send it by <bdi dir="ltr">{cutoff}</bdi> to make this
												delivery.
											</Trans>
										) : undefined
									}
									data-testid="order-expected-date"
								/>
								<div className="flex flex-col gap-2">
									<label htmlFor="order-note" className="text-sm font-medium">
										<Trans>Note for the supplier</Trans>{' '}
										<span className="text-muted-foreground font-normal">
											<Trans>(optional)</Trans>
										</span>
									</label>
									<Textarea
										id="order-note"
										value={note}
										disabled={!detailsEditable}
										onChange={(event) =>
											setNote(event.target.value.replace(/[\r\n]+/g, ' '))
										}
										rows={3}
										maxLength={500}
										dir="auto"
										data-testid="order-note"
									/>
								</div>
							</FramePanel>
						</Frame>
					</div>

					<aside className="lg:col-span-4">
						<div className="flex flex-col gap-4 lg:sticky lg:top-24">
							<Frame>
								<FrameHeader>
									<FrameTitle className="text-base">
										<Trans>Summary</Trans>
									</FrameTitle>
								</FrameHeader>
								<FramePanel className="flex flex-col gap-3">
									<dl
										className="flex flex-col gap-2 text-sm"
										data-testid="order-summary"
									>
										<div className="flex justify-between gap-3">
											<dt className="text-muted-foreground">
												<Trans>Supplier</Trans>
											</dt>
											<dd className="text-end wrap-anywhere">{supplierName}</dd>
										</div>
										<div className="flex justify-between gap-3">
											<dt className="text-muted-foreground">
												<Trans>Items</Trans>
											</dt>
											<dd
												className="tabular-nums"
												data-testid="order-item-count"
											>
												<bdi dir="ltr">{itemCount}</bdi>
											</dd>
										</div>
										{totals.totalMinor !== null ? (
											<div className="flex justify-between gap-3 font-medium">
												<dt>
													<Trans>Total</Trans>
												</dt>
												<dd className="tabular-nums" data-testid="order-total">
													<bdi dir="ltr">{money(totals.totalMinor)}</bdi>
												</dd>
											</div>
										) : null}
										{order.expectedDate ? (
											<div className="flex justify-between gap-3">
												<dt className="text-muted-foreground">
													<Trans>Expected</Trans>
												</dt>
												<dd>
													<bdi dir="ltr">
														{shortDayText(order.expectedDate, i18n.locale)}
													</bdi>
												</dd>
											</div>
										) : null}
										{sentLabel ? (
											<div className="flex justify-between gap-3">
												<dt className="text-muted-foreground">
													<Trans>Sent</Trans>
												</dt>
												<dd>
													<bdi dir="ltr">{sentLabel}</bdi>
												</dd>
											</div>
										) : null}
									</dl>
									{totals.totalMinor !== null && totals.unpricedLines > 0 ? (
										<p className="text-muted-foreground text-sm">
											<Plural
												value={totals.unpricedLines}
												one="# item has no price yet and is left out of the total."
												other="# items have no price yet and are left out of the total."
											/>
										</p>
									) : null}
									{totals.shortOfMinimumMinor > 0 &&
									order.minimumOrderMinor !== undefined &&
									order.minimumOrderMinor !== null ? (
										<p
											className="text-warning text-sm"
											data-testid="order-minimum"
										>
											<Trans>
												<bdi dir="ltr">{shortOfMinimum}</bdi> short of the
												supplier's minimum order of{' '}
												<bdi dir="ltr">{minimumOrder}</bdi>.
											</Trans>
										</p>
									) : null}
									{cutoff ? (
										<p className="text-sm" data-testid="order-cutoff">
											<Trans>
												Order by <bdi dir="ltr">{cutoff}</bdi>
											</Trans>
										</p>
									) : null}
								</FramePanel>
							</Frame>

							{order.deliveries.length > 0 ? (
								<Frame>
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Deliveries</Trans>
										</FrameTitle>
									</FrameHeader>
									<FramePanel>
										<ul
											className="flex flex-col gap-1 text-sm"
											data-testid="order-deliveries"
										>
											{order.deliveries.map((delivery) => (
												<li key={delivery.id}>
													<Link
														to={`${inventoryTabPath(orgSlug, 'purchasing')}/deliveries/${encodeURIComponent(delivery.id)}${search}`}
														className="underline"
													>
														{delivery.receivedAt ? (
															<bdi dir="ltr">
																{new Intl.DateTimeFormat(i18n.locale, {
																	dateStyle: 'medium',
																}).format(new Date(delivery.receivedAt))}
															</bdi>
														) : (
															<Trans>Delivery</Trans>
														)}
														{delivery.invoiceNumber ? (
															<>
																{' · '}
																<bdi dir="ltr">{delivery.invoiceNumber}</bdi>
															</>
														) : null}
													</Link>
												</li>
											))}
										</ul>
									</FramePanel>
								</Frame>
							) : null}

							<div className="flex flex-col gap-2">
								{canEdit && open ? (
									<Button
										type="button"
										variant="outline"
										render={
											<Link
												to={`${inventoryReceivePath(orgSlug, order.id)}${search.replace('?', '&')}`}
											/>
										}
										data-testid="order-receive"
									>
										<Trans>Receive delivery</Trans>
									</Button>
								) : null}
								<Button
									type="button"
									variant="outline"
									onClick={() => void printNow()}
									data-testid="order-print"
								>
									<Icon name="printer" />
									<Trans>Print</Trans>
								</Button>
								{canManagePurchasing && open ? (
									<Button
										type="button"
										variant="ghost"
										className="text-destructive"
										onClick={() => setCancelOpen(true)}
										data-testid="order-cancel"
									>
										<Trans>Cancel order</Trans>
									</Button>
								) : null}
							</div>
						</div>
					</aside>
				</div>
			</div>

			{sendChannel ? (
				<SendOrderDialog
					open
					onOpenChange={(next) => {
						if (!next) setSendChannel(null)
					}}
					channel={sendChannel}
					supplierName={supplierName}
					supplierEmail={email}
					supplierPhone={phone}
					itemCount={itemCount}
					onSend={sendNow}
					onPrint={setPrinting}
				/>
			) : null}

			<AlertDialog
				open={cancelOpen}
				onOpenChange={(next) => {
					if (!cancelling) setCancelOpen(next)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Cancel this order?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								The order is closed and cannot be received any more. Stock you
								already received stays. If you already sent it, tell the
								supplier.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<Textarea
						value={cancelNote}
						onChange={(event) =>
							setCancelNote(event.target.value.replace(/[\r\n]+/g, ' '))
						}
						rows={2}
						maxLength={500}
						placeholder={t`Why? (optional)`}
						aria-label={t`Why is it cancelled?`}
						data-testid="order-cancel-note"
					/>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={cancelling}>
							<Trans>Keep the order</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={cancelling}
							onClick={() => void cancelOrder()}
							data-testid="order-cancel-confirm"
						>
							<Trans>Cancel order</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{printing ? (
				<section
					data-print-root
					className="hidden print:block"
					data-testid="order-print-sheet"
				>
					<h1 className="mb-4 text-xl font-semibold">
						<Trans>
							Order {number} for{' '}
							<span className="wrap-anywhere">{supplierName}</span>
						</Trans>
					</h1>
					<pre className="font-sans text-base whitespace-pre-wrap" dir="auto">
						{printing}
					</pre>
				</section>
			) : null}
		</form>
	)
}

function OrderLine({
	line,
	received,
	editable,
	showStatus,
	money,
	onChange,
	onRemove,
}: {
	line: DraftOrderLine
	/** Base thousandths received so far (a saved line of a sent order). */
	received: number | null
	editable: boolean
	showStatus: boolean
	money: ((minor: number) => string) | null
	onChange: (packs: number | null) => void
	onRemove: () => void
}) {
	const { t, i18n } = useLingui()
	const quantity = useQuantityFormat()
	const itemName = line.itemName
	const packName = line.packName
	const packs = line.packs
	const step = packStep(line)
	const baseUnit = line.baseUnit
	const packSize = baseUnit
		? quantity.format(line.packBaseQuantity, { baseUnit })
		: null
	const total =
		baseUnit && packs !== null
			? quantity.format(Math.round(packs * line.packBaseQuantity), {
					baseUnit,
				})
			: null
	const lineMoney =
		money && line.packPriceMinor !== null && packs !== null && packs > 0
			? money(Math.round(packs * line.packPriceMinor))
			: null
	const changed =
		line.suggestedPacks !== null &&
		packs !== null &&
		packs !== line.suggestedPacks
	const suggested = line.suggestedPacks
	const suggestedText =
		suggested === null ? '' : packsText(suggested, i18n.locale)
	const onHand =
		baseUnit && line.onHand !== null
			? quantity.format(line.onHand, { baseUnit, countUnit: line.countUnit })
			: null
	const receivedText =
		baseUnit && received !== null && received > 0
			? quantity.format(received, { baseUnit })
			: null
	return (
		<li
			className="bg-card flex flex-col gap-3 rounded-xl border p-3"
			data-testid={`order-line-${line.key}`}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="flex min-w-0 flex-col">
					<span className="font-medium wrap-anywhere">{itemName}</span>
					<span className="text-muted-foreground text-xs">
						{packName}
						{packSize ? (
							<>
								{' · '}
								<bdi dir="ltr">{packSize}</bdi>
							</>
						) : null}
						{line.pricedByWeight ? (
							<>
								{' · '}
								<Trans>priced by weight</Trans>
							</>
						) : null}
					</span>
				</div>
				{editable ? (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-11 shrink-0 md:size-8"
						aria-label={t`Remove ${itemName}`}
						onClick={onRemove}
						data-testid={`order-line-remove-${line.key}`}
					>
						<Icon name="x" />
					</Button>
				) : null}
			</div>

			{editable ? (
				<div className="flex flex-wrap items-center gap-3">
					<QuantityStepper
						value={packs}
						onValueChange={onChange}
						step={step}
						min={0}
						max={MAX_ORDER_PACKS}
						placeholder="0"
						decrementLabel={t`Fewer`}
						incrementLabel={t`More`}
						aria-label={t`${itemName}, packs of ${packName}`}
						data-testid={`order-line-packs-${line.key}`}
					/>
					<span className="text-muted-foreground text-sm">
						{total ? (
							<bdi dir="ltr" className="tabular-nums">
								{total}
							</bdi>
						) : null}
						{lineMoney ? (
							<>
								{total ? ' · ' : null}
								<bdi dir="ltr" className="tabular-nums">
									{lineMoney}
								</bdi>
							</>
						) : null}
					</span>
				</div>
			) : (
				<p className="text-sm">
					<bdi dir="ltr" className="tabular-nums">
						{packs !== null
							? new Intl.NumberFormat(i18n.locale, {
									maximumFractionDigits: 3,
								}).format(packs)
							: ''}
					</bdi>
					{' × '}
					<span className="wrap-anywhere">{packName}</span>
					{total ? (
						<>
							{' · '}
							<bdi dir="ltr" className="tabular-nums">
								{total}
							</bdi>
						</>
					) : null}
					{lineMoney ? (
						<>
							{' · '}
							<bdi dir="ltr" className="tabular-nums">
								{lineMoney}
							</bdi>
						</>
					) : null}
				</p>
			)}

			<p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
				{onHand ? (
					<span>
						<Trans>
							On hand <bdi dir="ltr">{onHand}</bdi>
						</Trans>
					</span>
				) : null}
				{editable && changed && suggested !== null ? (
					<span data-testid={`order-line-suggested-${line.key}`}>
						<Trans>
							Suggested <bdi dir="ltr">{suggestedText}</bdi>
						</Trans>
					</span>
				) : null}
				{showStatus && receivedText ? (
					<span data-testid={`order-line-received-${line.key}`}>
						<Trans>
							Received <bdi dir="ltr">{receivedText}</bdi>
						</Trans>
					</span>
				) : null}
				{showStatus && received === 0 ? (
					<span>
						<Trans>Nothing received yet</Trans>
					</span>
				) : null}
			</p>
		</li>
	)
}
