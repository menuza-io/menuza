import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	standardUnitsFor,
	type StationExpectedDelivery,
	type StationItem,
	type UnitRef,
} from '@repo/inventory'
import { Icon } from '@repo/ui/icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BigStepper } from './BigStepper.tsx'
import {
	deliveryLines,
	deliveryPayloadSchema,
	filterItems,
	hasShortLines,
	lineFromItem,
	lineFromProduct,
	type StationSupplierProduct,
	linesFromExpected,
	mayReceive,
	unitChoices,
	unitLabel,
	unitStep,
	unitTakesFractions,
	type DeliveryLineDraft,
} from './model.ts'
import { prepareInvoicePhoto, PhotoError, type InvoicePhoto } from './photo.ts'
import { newClientId, recordDelivery, StockQueueFullError } from './queue.ts'
import { StockNotices } from './StockNotices.tsx'
import { type StockState } from './useStock.ts'
import {
	Button,
	Checkbox,
	Chip,
	cn,
	fieldClass,
	Input,
	Modal,
	Select,
} from '~/ui/primitives.tsx'

type Source =
	| { kind: 'order'; delivery: StationExpectedDelivery }
	/** `supplierId` null: a market or cash-and-carry purchase, no supplier on file. */
	| { kind: 'free'; supplierId: string | null }

/** Items offered beyond a supplier's own products; more asks for a few letters. */
const MAX_OTHER_ITEMS = 20

/**
 * Receive a delivery, quantities only: tick each line that came, change the
 * packs for a short line, type the real weight for a line priced by weight,
 * add the invoice number and a photo of the invoice. An item with no supplier
 * product (or a purchase at the market) is received by quantity in any unit
 * the item has. No price is shown or
 * typed; the office confirms prices in the Menuza app ("check prices"). It is
 * saved on the tablet and sent when it can be (a delivery made offline is
 * flagged late by the office if it arrives after two days).
 */
export function DeliverySheet({
	stock,
	open,
	onClose,
}: {
	stock: StockState
	open: boolean
	onClose: () => void
}) {
	const { _, i18n } = useLingui()
	const { catalog, ctx, role } = stock
	const [source, setSource] = useState<Source | null>(null)
	const [lines, setLines] = useState<DeliveryLineDraft[]>([])
	const [invoice, setInvoice] = useState('')
	const [closeOrder, setCloseOrder] = useState(false)
	const [photo, setPhoto] = useState<(InvoicePhoto & { url: string }) | null>(
		null,
	)
	const [photoProblem, setPhotoProblem] = useState<string | null>(null)
	const [problem, setProblem] = useState<string | null>(null)
	const [done, setDone] = useState(false)
	const [query, setQuery] = useState('')
	const [saving, setSaving] = useState(false)
	const picker = useRef<HTMLInputElement>(null)
	// The delivery's id is made before the tap and kept for this sheet: a double tap records it once.
	const draftId = useRef(newClientId())
	const submitting = useRef(false)

	useEffect(() => {
		if (open) return
		draftId.current = newClientId()
		submitting.current = false
		setSaving(false)
		setSource(null)
		setLines([])
		setInvoice('')
		setCloseOrder(false)
		setPhoto(null)
		setPhotoProblem(null)
		setProblem(null)
		setDone(false)
		setQuery('')
	}, [open])
	// A photo's preview address is released when it goes.
	useEffect(() => {
		const url = photo?.url
		return () => {
			if (url) URL.revokeObjectURL(url)
		}
	}, [photo?.url])

	const items = useMemo(
		() => new Map(catalog?.items.map((item) => [item.id, item]) ?? []),
		[catalog],
	)
	const allowed = catalog ? mayReceive(catalog, role) : false
	const supplier =
		source?.kind === 'free' && source.supplierId !== null
			? catalog?.suppliers.find((entry) => entry.id === source.supplierId)
			: null
	const order = source?.kind === 'order' ? source.delivery : null
	const ready = deliveryLines(lines).length > 0

	const choose = (next: Source) => {
		setSource(next)
		setProblem(null)
		setCloseOrder(false)
		setLines(next.kind === 'order' ? linesFromExpected(next.delivery) : [])
	}
	const patch = (key: string, change: Partial<DeliveryLineDraft>) =>
		setLines((before) =>
			before.map((line) => (line.key === key ? { ...line, ...change } : line)),
		)
	const addProduct = (product: StationSupplierProduct) => {
		const item = items.get(product.itemId)
		if (!item) return
		setLines((before) =>
			before.some((line) => line.key === `product:${product.id}`)
				? before
				: [...before, lineFromProduct(product, item)],
		)
	}

	const addItem = (item: StationItem) =>
		setLines((before) =>
			before.some((line) => line.key === `item:${item.id}`)
				? before
				: [...before, lineFromItem(item)],
		)

	const pickPhoto = async (file: File | undefined) => {
		if (!file || !catalog) return
		setPhotoProblem(null)
		try {
			const prepared = await prepareInvoicePhoto(
				file,
				catalog.settings.photoMaxBytes,
			)
			setPhoto({ ...prepared, url: URL.createObjectURL(prepared.blob) })
		} catch (failure) {
			setPhotoProblem(
				failure instanceof PhotoError && failure.reason === 'too_large'
					? _(
							t`That photo is too large. Take it again from a little further away.`,
						)
					: _(t`That photo could not be read.`),
			)
		}
	}

	const submit = async () => {
		if (!source || !ctx || submitting.current) return
		const received = deliveryLines(lines)
		if (received.length === 0) return
		const payload = {
			supplierId:
				source.kind === 'order'
					? source.delivery.supplierId
					: source.supplierId,
			...(source.kind === 'order' ? { orderId: source.delivery.orderId } : {}),
			...(source.kind === 'order' && closeOrder ? { closeOrder: true } : {}),
			invoiceNumber: invoice.trim() ? invoice.trim() : null,
			lines: received,
		}
		const checked = deliveryPayloadSchema.safeParse(payload)
		if (!checked.success) {
			setProblem(_(t`Check the amounts: one of them cannot be sent.`))
			return
		}
		submitting.current = true
		setSaving(true)
		try {
			await recordDelivery(
				ctx,
				checked.data,
				photo ? { blob: photo.blob, contentType: photo.contentType } : null,
				draftId.current,
			)
			setDone(true)
			void stock.sync()
		} catch (failure) {
			submitting.current = false
			setSaving(false)
			setProblem(
				failure instanceof StockQueueFullError
					? _(
							t`Too much is waiting to send from this tablet. Connect and let it send first.`,
						)
					: _(t`This could not be saved on the tablet.`),
			)
		}
	}

	const footer = done ? (
		<div className="pb-3">
			<Button variant="primary" size="lg" className="w-full" onClick={onClose}>
				<Trans>Done</Trans>
			</Button>
		</div>
	) : source ? (
		<div className="flex flex-col gap-2 pb-3 sm:flex-row-reverse">
			<Button
				variant="primary"
				size="lg"
				disabled={!ready || saving}
				onClick={() => void submit()}
				className="sm:min-w-56"
			>
				<Icon name="check" className="size-5" />
				<Trans>Save delivery</Trans>
			</Button>
			<Button size="lg" onClick={() => setSource(null)}>
				<Trans>Back</Trans>
			</Button>
		</div>
	) : undefined

	const matches = supplier
		? filterItems(
				supplier.products.map((product) => ({
					product,
					name: items.get(product.itemId)?.name ?? '',
				})),
				query,
			)
		: []
	// Items this supplier has no product for (or any item at the market): quantity only.
	const withProduct = new Set(supplier?.products.map((entry) => entry.itemId))
	const otherItems =
		source?.kind === 'free' && catalog
			? filterItems(
					catalog.items.filter((item) => !withProduct.has(item.id)),
					query,
				).slice(0, MAX_OTHER_ITEMS)
			: []

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={_(t`Receive delivery`)}
			size="full"
			footer={footer}
		>
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-5">
				<StockNotices stock={stock} compact />
				{!catalog ? (
					<p className="text-muted-foreground">
						{stock.loading ? (
							<Trans>Loading the stock list…</Trans>
						) : (
							<Trans>
								The stock list has not loaded yet. Connect once so this tablet
								can get it.
							</Trans>
						)}
					</p>
				) : !allowed ? (
					<div className="flex flex-col items-start gap-3">
						<p className="text-base">
							<Trans>A manager must sign in to receive a delivery.</Trans>
						</p>
						<Button onClick={onClose}>
							<Trans>Close</Trans>
						</Button>
					</div>
				) : done ? (
					<div className="flex flex-col items-start gap-3">
						<div className="flex items-center gap-3">
							<Icon name="check-circle" className="text-success size-8" />
							<h3 className="text-xl font-semibold">
								<Trans>Delivery saved</Trans>
							</h3>
						</div>
						<p className="text-muted-foreground">
							{stock.reachable
								? _(
										t`It is being sent to the office. They will check the prices.`,
									)
								: _(
										t`It is saved on this tablet and goes to the office when it is connected. They will check the prices.`,
									)}
						</p>
					</div>
				) : !source ? (
					<div className="flex flex-col gap-5">
						{catalog.settings.ordersEnabled &&
						catalog.expectedDeliveries.length > 0 ? (
							<section className="flex flex-col gap-2">
								<h3 className="text-base font-semibold">
									<Trans>Expected deliveries</Trans>
								</h3>
								<ul className="flex flex-col gap-2">
									{catalog.expectedDeliveries.map((delivery) => {
										const number = delivery.number
										const lineCount = delivery.lines.length
										return (
											<li key={delivery.orderId}>
												<button
													type="button"
													onClick={() => choose({ kind: 'order', delivery })}
													className="border-border bg-card hover:bg-accent flex min-h-16 w-full items-center justify-between gap-3 rounded-(--station-panel-radius) border px-4 py-3 text-start"
												>
													<span className="min-w-0">
														<span className="block font-semibold break-words">
															{delivery.supplierName}
														</span>
														<span className="text-muted-foreground block text-sm">
															{_(t`Order ${number}`)}
															{' · '}
															{_(
																plural(lineCount, {
																	one: '# item',
																	other: '# items',
																}),
															)}
														</span>
													</span>
													<Icon
														name="chevron-right"
														className="size-5 shrink-0 rtl:rotate-180"
														aria-hidden
													/>
												</button>
											</li>
										)
									})}
								</ul>
							</section>
						) : null}
						<section className="flex flex-col gap-2">
							<h3 className="text-base font-semibold">
								<Trans>Delivery without an order</Trans>
							</h3>
							{catalog.suppliers.length === 0 ? (
								<p className="text-muted-foreground">
									<Trans>
										No supplier is set up yet. A manager adds suppliers in the
										Menuza app. You can still receive what came from the market.
									</Trans>
								</p>
							) : null}
							<div className="flex flex-wrap gap-2">
								{catalog.suppliers.map((entry) => (
									<Chip
										key={entry.id}
										size="lg"
										look="outlined"
										selected={false}
										onClick={() =>
											choose({ kind: 'free', supplierId: entry.id })
										}
									>
										{entry.name}
									</Chip>
								))}
								<Chip
									size="lg"
									look="outlined"
									selected={false}
									onClick={() => choose({ kind: 'free', supplierId: null })}
								>
									<Trans>Market or other supplier</Trans>
								</Chip>
							</div>
						</section>
					</div>
				) : (
					<div className="flex flex-col gap-5">
						<h3 className="text-xl font-semibold break-words">
							{order
								? order.supplierName
								: supplier
									? supplier.name
									: _(t`Market or other supplier`)}
						</h3>
						<ul className="flex flex-col gap-3">
							{lines.map((line) => (
								<DeliveryLine
									key={line.key}
									line={line}
									locale={i18n.locale}
									onPatch={(change) => patch(line.key, change)}
									onRemove={
										order
											? undefined
											: () =>
													setLines((before) =>
														before.filter((entry) => entry.key !== line.key),
													)
									}
								/>
							))}
						</ul>
						{source?.kind === 'free' ? (
							<section className="flex flex-col gap-2">
								<h4 className="text-base font-semibold">
									<Trans>Add an item</Trans>
								</h4>
								<input
									type="search"
									className={fieldClass}
									value={query}
									placeholder={_(t`Search items`)}
									autoComplete="off"
									onChange={(event) => setQuery(event.target.value)}
								/>
								{supplier && supplier.products.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										<Trans>
											This supplier has no items set up yet. Search for any item
											below.
										</Trans>
									</p>
								) : null}
								{supplier ? (
									<ul className="flex flex-col gap-2">
										{matches.map(({ product, name }) => {
											const added = lines.some(
												(line) => line.key === `product:${product.id}`,
											)
											return (
												<li key={product.id}>
													<button
														type="button"
														disabled={added}
														onClick={() => addProduct(product)}
														className="border-border bg-card hover:bg-accent flex min-h-14 w-full items-center justify-between gap-3 rounded-(--station-control-radius) border px-4 py-2 text-start disabled:opacity-50"
													>
														<span className="min-w-0 break-words">
															<span className="font-medium">{name}</span>
															<span className="text-muted-foreground">
																{' · '}
																{product.packName}
															</span>
														</span>
														<Icon
															name={added ? 'check' : 'plus'}
															className="size-5 shrink-0"
															aria-hidden
														/>
													</button>
												</li>
											)
										})}
									</ul>
								) : null}
								{otherItems.length > 0 ? (
									<>
										{supplier ? (
											<h5 className="text-muted-foreground pt-2 text-sm font-semibold">
												<Trans>Other items, by quantity</Trans>
											</h5>
										) : null}
										<ul className="flex flex-col gap-2">
											{otherItems.map((item) => {
												const added = lines.some(
													(line) => line.key === `item:${item.id}`,
												)
												return (
													<li key={item.id}>
														<button
															type="button"
															disabled={added}
															onClick={() => addItem(item)}
															className="border-border bg-card hover:bg-accent flex min-h-14 w-full items-center justify-between gap-3 rounded-(--station-control-radius) border px-4 py-2 text-start disabled:opacity-50"
														>
															<span className="min-w-0 font-medium break-words">
																{item.name}
															</span>
															<Icon
																name={added ? 'check' : 'plus'}
																className="size-5 shrink-0"
																aria-hidden
															/>
														</button>
													</li>
												)
											})}
										</ul>
									</>
								) : null}
							</section>
						) : null}
						<label className="flex flex-col gap-2">
							<span className="text-base font-semibold">
								<Trans>Invoice number (optional)</Trans>
							</span>
							<Input
								value={invoice}
								maxLength={60}
								onChange={(event) => setInvoice(event.target.value)}
							/>
						</label>
						<section className="flex flex-col gap-2">
							<h4 className="text-base font-semibold">
								<Trans>Photo of the invoice (optional)</Trans>
							</h4>
							<input
								ref={picker}
								type="file"
								accept="image/*"
								capture="environment"
								className="sr-only"
								tabIndex={-1}
								aria-label={_(t`Invoice photo file`)}
								onChange={(event) => {
									void pickPhoto(event.target.files?.[0])
									event.target.value = ''
								}}
							/>
							<div className="flex flex-wrap items-center gap-3">
								<Button onClick={() => picker.current?.click()}>
									<Icon name="camera" className="size-5" />
									{photo ? (
										<Trans>Take it again</Trans>
									) : (
										<Trans>Take a photo</Trans>
									)}
								</Button>
								{photo ? (
									<>
										<img
											src={photo.url}
											alt={_(t`The invoice photo`)}
											className="border-border h-16 rounded-(--station-control-radius) border object-cover"
										/>
										<Button variant="ghost" onClick={() => setPhoto(null)}>
											<Icon name="x" className="size-4" />
											<Trans>Remove</Trans>
										</Button>
									</>
								) : null}
							</div>
							{photo ? (
								<p className="text-muted-foreground text-sm">
									<Trans>
										The photo is sent after the delivery. If it cannot be
										uploaded it tries again by itself; the delivery is never
										held up.
									</Trans>
								</p>
							) : null}
							{photoProblem ? (
								<p role="alert" className="text-destructive text-sm">
									{photoProblem}
								</p>
							) : null}
						</section>
						{order && hasShortLines(lines) ? (
							<label className="flex items-center gap-3">
								<Checkbox
									checked={closeOrder}
									onChange={(event) => setCloseOrder(event.target.checked)}
								/>
								<span className="text-base">
									<Trans>Nothing more is coming for this order</Trans>
								</span>
							</label>
						) : null}
						{problem ? (
							<p role="alert" className="text-destructive text-sm">
								{problem}
							</p>
						) : null}
					</div>
				)}
			</div>
		</Modal>
	)
}

function DeliveryLine({
	line,
	locale,
	onPatch,
	onRemove,
}: {
	line: DeliveryLineDraft
	locale: string
	onPatch: (change: Partial<DeliveryLineDraft>) => void
	onRemove?: () => void
}) {
	const { _ } = useLingui()
	const name = line.itemName
	const pack = line.packName
	const ordered = line.orderedPacks
	const short = line.received && ordered !== null && (line.packs ?? 0) < ordered
	return (
		<li
			className={cn(
				'border-border bg-card flex flex-col gap-3 rounded-(--station-panel-radius) border p-4',
				!line.received && 'opacity-70',
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-start gap-3">
					{line.orderLineId ? (
						<Checkbox
							className="mt-1"
							checked={line.received}
							aria-label={_(t`${name} arrived`)}
							onChange={(event) => onPatch({ received: event.target.checked })}
						/>
					) : null}
					<div className="min-w-0">
						<p className="text-base font-semibold break-words">
							{line.itemName}
						</p>
						<p className="text-muted-foreground text-sm break-words">
							{pack}
							{ordered !== null ? (
								<>
									{' · '}
									{_(t`Ordered`)}{' '}
									<bdi dir="ltr" className="tnum">
										{ordered}
									</bdi>
								</>
							) : null}
						</p>
					</div>
				</div>
				{onRemove ? (
					<Button
						variant="ghost"
						aria-label={_(t`Remove ${name}`)}
						onClick={onRemove}
					>
						<Icon name="trash-2" className="size-5" />
					</Button>
				) : null}
			</div>
			{line.received && line.plain ? (
				<PlainQuantity line={line} locale={locale} onPatch={onPatch} />
			) : line.received ? (
				<div className="flex flex-wrap items-start gap-4">
					<div className="flex flex-col gap-1">
						<span className="text-muted-foreground text-sm">
							<Trans>Packs that came</Trans>
						</span>
						<BigStepper
							value={line.packs}
							label={_(t`${pack} of ${name}`)}
							fractions
							onChange={(packs) => onPatch({ packs })}
						/>
						{short ? (
							<span className="text-warning text-sm">
								<Trans>Short</Trans>
							</span>
						) : null}
					</div>
					{line.pricedByWeight ? (
						<div className="flex flex-col gap-1">
							<span className="text-muted-foreground text-sm">
								<Trans>Real weight from the scale</Trans>
							</span>
							<div className="flex flex-wrap items-start gap-2">
								<BigStepper
									value={line.weight}
									label={_(t`Weight of ${name}`)}
									fractions={false}
									step={
										line.weightUnit === 'g' || line.weightUnit === 'ml'
											? 100
											: 1
									}
									onChange={(weight) => onPatch({ weight })}
								/>
								<Select
									aria-label={_(t`Weight unit for ${name}`)}
									containerClassName="w-32"
									value={line.weightUnit}
									onChange={(event) =>
										onPatch({ weightUnit: event.target.value, weight: null })
									}
								>
									{standardUnitsFor(line.baseUnit).map((unit) => (
										<option key={unit} value={unit}>
											{unitLabel(unit, [], locale)}
										</option>
									))}
								</Select>
							</div>
						</div>
					) : null}
				</div>
			) : null}
		</li>
	)
}

/** How much of an item with no supplier product came, in any unit the item has. */
function PlainQuantity({
	line,
	locale,
	onPatch,
}: {
	line: DeliveryLineDraft
	locale: string
	onPatch: (change: Partial<DeliveryLineDraft>) => void
}) {
	const { _ } = useLingui()
	const plain = line.plain!
	const name = line.itemName
	const choices = unitChoices({
		baseUnit: line.baseUnit,
		units: plain.units,
		countUnit: plain.countUnit,
	})
	const unit: UnitRef = plain.unit
	return (
		<div className="flex flex-col gap-1">
			<span className="text-muted-foreground text-sm">
				<Trans>How much came</Trans>
			</span>
			<div className="flex flex-wrap items-start gap-2">
				<BigStepper
					value={plain.amount}
					label={name}
					step={unitStep(unit)}
					fractions={unitTakesFractions(unit)}
					onChange={(amount) => onPatch({ plain: { ...plain, amount } })}
				/>
				<Select
					aria-label={_(t`Unit for ${name}`)}
					containerClassName="w-40"
					value={unit}
					onChange={(event) =>
						onPatch({
							plain: { ...plain, unit: event.target.value, amount: null },
						})
					}
				>
					{choices.map((ref) => (
						<option key={ref} value={ref}>
							{unitLabel(ref, plain.units, locale)}
						</option>
					))}
				</Select>
			</div>
		</div>
	)
}
