import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	type DeliveryDetail,
	INVENTORY_BASE_UNITS,
	INVENTORY_CATEGORIES,
	type InventoryBaseUnit,
	type InventoryCategory,
	type InvoiceRead,
	invoiceReadSchema,
	recordDeliveryResultSchema,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { InvoiceWarningBadges } from '#app/components/inventory/invoice-warning-badges.tsx'
import { ItemPicker } from '#app/components/inventory/item-picker.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import {
	buildConfirmPrices,
	type ConfirmExtraLineDraft,
	type ConfirmHeaderDraft,
	type ConfirmLineDraft,
	type ConfirmLineProblem,
	confirmLineDrafts,
	confirmLineHint,
	matchInvoiceReadToConfirm,
} from '#app/utils/inventory/confirm-prices.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	inventorySaveErrorMessage,
	invoiceReadErrorMessage,
	isInvoiceReaderMissing,
} from '#app/utils/inventory/inventory-errors.ts'
import { categoryLabel } from '#app/utils/inventory/labels.ts'
import { packsText } from '#app/utils/inventory/order-view.ts'
import { minorToMajorText } from '#app/utils/money-input.ts'

/**
 * "Confirm prices": a delivery was recorded as quantities only. Read the
 * invoice (or click "Use invoice lines" to prefill from the invoice photo) and
 * verify what each line cost; saving posts the prices, updates item costs and
 * supplier pack prices, adds any extra lines, and clears "prices to confirm".
 * Needs the purchasing role.
 */
export function ConfirmPricesDialog({
	open,
	onOpenChange,
	delivery,
	currency,
	onConfirmed,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	delivery: DeliveryDetail
	currency: string
	onConfirmed: () => void
}) {
	const { t, i18n } = useLingui()
	const client = useInventoryClient()
	const { request } = client
	const idPrefix = useId()
	const [lines, setLines] = useState<ConfirmLineDraft[]>(() =>
		confirmLineDrafts(delivery),
	)
	const [extraLines, setExtraLines] = useState<ConfirmExtraLineDraft[]>([])
	const [header, setHeader] = useState<ConfirmHeaderDraft>({
		invoiceNumber: delivery.invoiceNumber ?? '',
		invoiceDate: delivery.invoiceDate ?? '',
		vatText: '',
		totalText: '',
		paid: false,
	})
	const [problems, setProblems] = useState<{
		lines: Record<string, ConfirmLineProblem[]>
		extraLines?: Record<string, ConfirmLineProblem[]>
		header: string[]
	} | null>(null)
	const [pending, setPending] = useState(false)
	const [reading, setReading] = useState(false)
	const [readerMissing, setReaderMissing] = useState(false)
	const [invoiceRead, setInvoiceRead] = useState<InvoiceRead | null>(null)
	const [selectedReadLines, setSelectedReadLines] = useState<
		ReadonlySet<number>
	>(() => new Set())
	const [error, setError] = useState<string | null>(null)

	function patchLine(lineId: string, update: Partial<ConfirmLineDraft>) {
		setLines((current) =>
			current.map((line) =>
				line.lineId === lineId ? { ...line, ...update } : line,
			),
		)
	}

	function patchExtra(key: string, update: Partial<ConfirmExtraLineDraft>) {
		setExtraLines((current) =>
			current.map((extra) =>
				extra.key === key ? { ...extra, ...update } : extra,
			),
		)
	}

	async function fetchInvoiceLines() {
		if (reading) return
		setReading(true)
		setError(null)
		try {
			const read = invoiceReadSchema.parse(
				await request(
					`/deliveries/${encodeURIComponent(delivery.id)}/invoice-photo/read`,
					{ method: 'POST', body: JSON.stringify({}) },
				),
			)
			const allIndices = new Set(read.lines.map((_, index) => index))
			setInvoiceRead(read)
			setSelectedReadLines(allIndices)
			const matched = matchInvoiceReadToConfirm(
				read,
				confirmLineDrafts(delivery),
				currency,
				allIndices,
			)
			setLines(matched.lines)
			setExtraLines(matched.extraLines)
			setHeader((current) => ({
				...current,
				invoiceNumber:
					current.invoiceNumber.trim() === '' && read.invoiceNumber
						? read.invoiceNumber
						: current.invoiceNumber,
				totalText:
					current.totalText.trim() === '' &&
					read.totalMinor !== undefined &&
					read.totalMinor !== null
						? minorToMajorText(read.totalMinor, currency)
						: current.totalText,
			}))
		} catch (caught) {
			if (isInvoiceReaderMissing(caught)) {
				setReaderMissing(true)
			} else {
				setError(i18n._(invoiceReadErrorMessage(caught)))
			}
		} finally {
			setReading(false)
		}
	}

	function toggleReadLine(index: number, checked: boolean) {
		if (!invoiceRead) return
		const next = new Set(selectedReadLines)
		if (checked) next.add(index)
		else next.delete(index)
		setSelectedReadLines(next)
		const matched = matchInvoiceReadToConfirm(
			invoiceRead,
			confirmLineDrafts(delivery),
			currency,
			next,
		)
		setLines(matched.lines)
		setExtraLines((currentExtras) => {
			const byKey = new Map(currentExtras.map((entry) => [entry.key, entry]))
			return matched.extraLines.map((entry) => {
				const existing = byKey.get(entry.key)
				return existing ? { ...existing, include: entry.include } : entry
			})
		})
	}

	async function submit() {
		if (pending) return
		setError(null)
		const built = buildConfirmPrices(
			lines,
			header,
			{ expectedVersion: delivery.version, currency },
			extraLines,
		)
		if (!built.ok) {
			setProblems({
				lines: built.lines,
				extraLines: built.extraLines,
				header: built.header,
			})
			return
		}
		setProblems(null)
		setPending(true)
		try {
			const result = recordDeliveryResultSchema.parse(
				await request(
					`/deliveries/${encodeURIComponent(delivery.id)}/confirm-prices`,
					{ method: 'POST', body: JSON.stringify(built.payload) },
				),
			)
			const moved = result.priceChanges?.length ?? 0
			toast.success(t`Prices confirmed.`, {
				description:
					moved > 0
						? plural(moved, {
								one: 'Prices updated for # item',
								other: 'Prices updated for # items',
							})
						: undefined,
			})
			onConfirmed()
			onOpenChange(false)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(false)
		}
	}

	const canReadPhoto =
		(delivery.hasPhoto === true || Boolean(delivery.photo)) && !readerMissing

	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent
				className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
				data-testid="confirm-prices-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Confirm prices</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Type what each line cost on the invoice, before VAT. Item costs
							and supplier prices update when you save.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{canReadPhoto
					? (() => {
							const invoiceTotalText =
								invoiceRead &&
								invoiceRead.totalMinor !== undefined &&
								invoiceRead.totalMinor !== null
									? formatMoney(invoiceRead.totalMinor, currency, i18n.locale)
									: null
							return (
								<div className="flex flex-wrap items-center justify-between gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={reading || pending}
										onClick={() => void fetchInvoiceLines()}
										data-testid="confirm-use-invoice-lines"
									>
										<Icon name={reading ? 'loader' : 'sparkles'} />
										{reading ? (
											<Trans>Reading invoice…</Trans>
										) : (
											<Trans>Use invoice lines</Trans>
										)}
									</Button>
									{invoiceTotalText ? (
										<span className="text-muted-foreground text-xs">
											<Trans>
												Invoice total: <bdi dir="ltr">{invoiceTotalText}</bdi>
											</Trans>
										</span>
									) : null}
								</div>
							)
						})()
					: null}

				{invoiceRead?.invoiceTotalMismatch ? (
					<Alert
						variant="destructive"
						data-testid="confirm-invoice-total-mismatch"
					>
						<Icon name="alert-triangle" />
						<AlertDescription>
							<Trans>
								The lines read from the invoice do not add up to the printed
								invoice total. Check each line below.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				{invoiceRead && invoiceRead.lines.length > 0 ? (
					<div
						className="flex flex-col gap-2 rounded-xl border p-3"
						data-testid="confirm-invoice-read-preview"
					>
						<p className="text-xs font-medium">
							<Trans>Lines read from invoice (uncheck to leave out)</Trans>
						</p>
						<ul className="flex flex-col divide-y">
							{invoiceRead.lines.map((invLine, index) => (
								<li
									key={`${index}-${invLine.text}`}
									className="flex items-start justify-between gap-2 py-2 text-xs"
								>
									<div className="flex items-start gap-2">
										<Checkbox
											checked={selectedReadLines.has(index)}
											onCheckedChange={(checked) =>
												toggleReadLine(index, checked)
											}
											data-testid={`confirm-invoice-read-toggle-${index}`}
										/>
										<div className="flex flex-col gap-1">
											<span className="font-medium wrap-anywhere">
												{invLine.text}
											</span>
											<InvoiceWarningBadges warnings={invLine.warnings} />
										</div>
									</div>
									{invLine.lineTotalMinor !== undefined ? (
										<bdi dir="ltr" className="shrink-0 tabular-nums">
											{formatMoney(
												invLine.lineTotalMinor,
												currency,
												i18n.locale,
											)}
										</bdi>
									) : null}
								</li>
							))}
						</ul>
					</div>
				) : null}

				{error ? (
					<Alert variant="destructive" data-testid="confirm-prices-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<ul className="flex flex-col gap-3" data-testid="confirm-prices-lines">
					{lines.map((line) => {
						const found = problems?.lines[line.lineId] ?? []
						const name = line.itemName
						const packName = line.packName
						const rawText = line.rawInvoiceText
						const received =
							line.packs !== null && line.packName
								? `${packsText(line.packs, i18n.locale)} × ${line.packName}`
								: null
						return (
							<li
								key={line.lineId}
								className="bg-card flex flex-col gap-2 rounded-xl border p-3"
								data-testid={`confirm-line-${line.lineId}`}
							>
								<div className="flex flex-col gap-1">
									<span className="font-medium wrap-anywhere">{name}</span>
									{received ? (
										<span className="text-muted-foreground text-xs">
											<bdi dir="ltr">{received}</bdi>
										</span>
									) : null}
									{rawText ? (
										<span
											className="text-muted-foreground text-xs wrap-anywhere"
											data-testid={`confirm-line-raw-${line.lineId}`}
										>
											<Trans>Invoice: {rawText}</Trans>
										</span>
									) : null}
									<InvoiceWarningBadges warnings={line.warnings} />
								</div>
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									{line.packs !== null && !line.weighed ? (
										<TextField
											label={
												<Trans>
													Price of one {packName} ({currency})
												</Trans>
											}
											optional
											value={line.priceText}
											onChange={(event) =>
												patchLine(line.lineId, {
													priceText: event.target.value,
												})
											}
											error={
												found.includes('price')
													? t`Enter the price on the invoice, for example 28.50.`
													: null
											}
											inputMode="decimal"
											dir="ltr"
											data-testid={`confirm-price-${line.lineId}`}
										/>
									) : null}
									<TextField
										label={<Trans>Line total ({currency})</Trans>}
										value={line.totalText}
										placeholder={confirmLineHint(line, currency)}
										onChange={(event) =>
											patchLine(line.lineId, { totalText: event.target.value })
										}
										error={
											found.includes('total')
												? t`Enter the line total on the invoice.`
												: null
										}
										inputMode="decimal"
										dir="ltr"
										data-testid={`confirm-total-${line.lineId}`}
									/>
								</div>
							</li>
						)
					})}
				</ul>

				{extraLines.length > 0 ? (
					<div
						className="flex flex-col gap-2"
						data-testid="confirm-extra-lines"
					>
						<h4 className="text-sm font-semibold">
							<Trans>Extra lines on the invoice</Trans>
						</h4>
						<ul className="flex flex-col gap-3">
							{extraLines.map((extra) => {
								const extraFound = problems?.extraLines?.[extra.key] ?? []
								return (
									<li
										key={extra.key}
										className="bg-card flex flex-col gap-3 rounded-xl border p-3"
										data-testid={`confirm-extra-${extra.key}`}
									>
										<div className="flex flex-wrap items-start justify-between gap-2">
											<div className="flex items-start gap-2">
												<Checkbox
													checked={extra.include}
													onCheckedChange={(checked) =>
														patchExtra(extra.key, { include: checked })
													}
													data-testid={`confirm-extra-include-${extra.key}`}
												/>
												<div className="flex flex-col gap-1">
													<span className="text-sm font-medium wrap-anywhere">
														{extra.rawText}
													</span>
													<InvoiceWarningBadges warnings={extra.warnings} />
												</div>
											</div>
											<Badge variant="outline">
												<Trans>Extra line</Trans>
											</Badge>
										</div>

										{extra.include ? (
											<>
												<div className="flex flex-wrap items-center gap-2">
													<Button
														type="button"
														size="sm"
														variant={
															extra.itemMode === 'match'
																? 'secondary'
																: 'outline'
														}
														onClick={() =>
															patchExtra(extra.key, {
																itemMode:
																	extra.itemMode === 'match'
																		? 'create'
																		: 'match',
															})
														}
													>
														{extra.itemMode === 'match' ? (
															<Trans>Match existing item</Trans>
														) : (
															<Trans>Create new item</Trans>
														)}
													</Button>
												</div>

												{extra.itemMode === 'match' ? (
													<ItemPicker
														label={<Trans>Stock item</Trans>}
														client={client}
														locationId={delivery.locationId}
														value={
															extra.itemId
																? {
																		id: extra.itemId,
																		name:
																			extra.itemName ?? extra.createItemName,
																	}
																: null
														}
														onChange={(item) =>
															patchExtra(extra.key, {
																itemId: item.id,
																itemName: item.name,
																baseUnit: item.baseUnit,
															})
														}
														placeholder={t`Choose an item`}
														error={
															extraFound.includes('item')
																? t`Choose an item.`
																: null
														}
													/>
												) : (
													<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
														<TextField
															label={<Trans>New item name</Trans>}
															value={extra.createItemName}
															onChange={(event) =>
																patchExtra(extra.key, {
																	createItemName: event.target.value,
																})
															}
															error={
																extraFound.includes('item')
																	? t`Enter a name.`
																	: null
															}
															dir="auto"
														/>
														<SelectField
															label={<Trans>Unit</Trans>}
															options={INVENTORY_BASE_UNITS.map((unit) => ({
																value: unit,
																label: unit,
															}))}
															value={extra.baseUnit}
															onValueChange={(next) =>
																patchExtra(extra.key, {
																	baseUnit: next as InventoryBaseUnit,
																})
															}
														/>
														<SelectField
															label={<Trans>Category</Trans>}
															options={INVENTORY_CATEGORIES.map((category) => ({
																value: category,
																label: categoryLabel(category, i18n),
															}))}
															value={extra.category}
															onValueChange={(next) =>
																patchExtra(extra.key, {
																	category: next as InventoryCategory,
																})
															}
														/>
													</div>
												)}

												<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
													<TextField
														label={<Trans>Quantity</Trans>}
														value={extra.quantityText}
														onChange={(event) =>
															patchExtra(extra.key, {
																quantityText: event.target.value,
															})
														}
														error={
															extraFound.includes('quantity')
																? t`Enter a quantity above zero.`
																: null
														}
														inputMode="decimal"
														dir="ltr"
													/>
													<TextField
														label={<Trans>Line total ({currency})</Trans>}
														value={extra.totalText}
														onChange={(event) =>
															patchExtra(extra.key, {
																totalText: event.target.value,
															})
														}
														error={
															extraFound.includes('total')
																? t`Enter the line total.`
																: null
														}
														inputMode="decimal"
														dir="ltr"
													/>
												</div>
											</>
										) : null}
									</li>
								)
							})}
						</ul>
					</div>
				) : null}

				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<TextField
						label={<Trans>Invoice number</Trans>}
						optional
						value={header.invoiceNumber}
						onChange={(event) =>
							setHeader({ ...header, invoiceNumber: event.target.value })
						}
						maxLength={60}
						dir="ltr"
						data-testid="confirm-invoice-number"
					/>
					<TextField
						label={<Trans>VAT ({currency})</Trans>}
						optional
						value={header.vatText}
						onChange={(event) =>
							setHeader({ ...header, vatText: event.target.value })
						}
						error={
							problems?.header.includes('vat')
								? t`Enter the VAT amount, for example 106.80.`
								: null
						}
						inputMode="decimal"
						dir="ltr"
						data-testid="confirm-vat"
					/>
					<TextField
						label={<Trans>Invoice total ({currency})</Trans>}
						optional
						value={header.totalText}
						onChange={(event) =>
							setHeader({ ...header, totalText: event.target.value })
						}
						error={
							problems?.header.includes('total')
								? t`Enter the total on the invoice, for example 818.80.`
								: null
						}
						inputMode="decimal"
						dir="ltr"
						data-testid="confirm-invoice-total"
					/>
				</div>
				<div className="flex items-center gap-2">
					<Checkbox
						id={`${idPrefix}-paid`}
						checked={header.paid}
						onCheckedChange={(next) => setHeader({ ...header, paid: next })}
						data-testid="confirm-paid"
					/>
					<Label
						htmlFor={`${idPrefix}-paid`}
						className="cursor-pointer font-normal"
					>
						<Trans>Already paid</Trans>
					</Label>
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						onClick={() => void submit()}
						disabled={pending}
						data-testid="confirm-prices-submit"
					>
						<Trans>Confirm prices</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
