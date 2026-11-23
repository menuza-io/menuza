import { Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_CATEGORIES,
	type InventoryBaseUnit,
	type InventoryCategory,
	recordDeliveryResultSchema,
	type StockItem,
	standardUnitsFor,
	type UnitRef,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { parseQuantityText } from '@repo/ui/quantity-input'
import { useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { ItemPicker } from '#app/components/inventory/item-picker.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import {
	defaultEntryUnit,
	formatMoney,
	thousandthsInUnit,
} from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	InvoicePhotoError,
	isAllowedInvoicePhotoType,
	uploadInvoicePhoto,
} from '#app/utils/inventory/invoice-photo.ts'
import {
	baseUnitFor,
	defaultMeasureUnit,
	MEASURED_IN,
	type MeasuredIn,
} from '#app/utils/inventory/item-form.ts'
import { categoryLabel } from '#app/utils/inventory/labels.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'
import { parseMoneyToMinor } from '#app/utils/money-input.ts'

type CashLineDraft = {
	key: string
	mode: 'pick' | 'draft'
	item: StockItem | null
	draftName: string
	measuredIn: MeasuredIn
	category: InventoryCategory
	quantityText: string
	unit: UnitRef
	amountText: string
}

function todayIso(): string {
	const now = new Date()
	const m = String(now.getMonth() + 1).padStart(2, '0')
	const d = String(now.getDate()).padStart(2, '0')
	return `${now.getFullYear()}-${m}-${d}`
}

function createEmptyLine(key: string, system: 'metric' | 'us'): CashLineDraft {
	return {
		key,
		mode: 'pick',
		item: null,
		draftName: '',
		measuredIn: 'weight',
		category: 'other',
		quantityText: '',
		unit: defaultMeasureUnit('weight', system),
		amountText: '',
	}
}

/**
 * Cash market purchase (#466): pick existing stock items OR type a new item
 * name with unit (saved as a draft item for the office to tidy), enter quantity
 * and amount paid, optionally attach a receipt photo, and save under
 * "Market / cash" marked paid.
 */
export function CashPurchaseDialog({
	open,
	onOpenChange,
	locationId,
	currency,
	onSaved,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	locationId: string
	currency: string
	onSaved: () => void
}) {
	const { t, i18n } = useLingui()
	const client = useInventoryClient()
	const { request } = client
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const idPrefix = useId()
	const counter = useRef(1)
	const clientIdRef = useRef(newClientId('cash'))
	const photoInputRef = useRef<HTMLInputElement>(null)

	const [date, setDate] = useState(todayIso)
	const [lines, setLines] = useState<CashLineDraft[]>(() => [
		createEmptyLine('cash-1', quantity.system),
	])
	const [photo, setPhoto] = useState<File | null>(null)
	const [photoProblem, setPhotoProblem] = useState<string | null>(null)
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)

	function reset() {
		counter.current += 1
		clientIdRef.current = newClientId('cash')
		setDate(todayIso())
		setLines([createEmptyLine(`cash-${counter.current}`, quantity.system)])
		setPhoto(null)
		setPhotoProblem(null)
		setError(null)
	}

	function patchLine(
		key: string,
		updater: (line: CashLineDraft) => CashLineDraft,
	) {
		setLines((current) =>
			current.map((line) => (line.key === key ? updater(line) : line)),
		)
	}

	function addLine() {
		counter.current += 1
		setLines((current) => [
			...current,
			createEmptyLine(`cash-${counter.current}`, quantity.system),
		])
	}

	const totalPaidMinor = lines.reduce((sum, line) => {
		const minor = parseMoneyToMinor(line.amountText, { currency, min: 0 })
		return sum + (minor ?? 0)
	}, 0)

	async function submit() {
		if (submitting) return
		setError(null)

		const payloadLines: Array<Record<string, unknown>> = []
		for (const line of lines) {
			const baseUnit: InventoryBaseUnit =
				line.mode === 'pick'
					? (line.item?.baseUnit ?? 'g')
					: baseUnitFor(line.measuredIn)
			if (line.mode === 'pick' && !line.item) {
				setError(t`Choose an item or switch to New item on every line.`)
				return
			}
			if (line.mode === 'draft' && line.draftName.trim() === '') {
				setError(t`Enter a name for each new item.`)
				return
			}
			const qtyNum = parseQuantityText(line.quantityText)
			const perUnit = thousandthsInUnit(
				line.unit,
				baseUnit,
				line.item?.units ?? [],
			)
			if (qtyNum === null || qtyNum <= 0 || perUnit === null) {
				setError(t`Enter a quantity above zero on every line.`)
				return
			}
			const baseQty = Math.round(qtyNum * perUnit)
			if (baseQty < 1) {
				setError(t`Enter a quantity above zero on every line.`)
				return
			}
			const amountMinor = parseMoneyToMinor(line.amountText, {
				currency,
				min: 0,
			})
			if (amountMinor === null) {
				setError(t`Enter the amount paid on every line.`)
				return
			}

			payloadLines.push({
				...(line.mode === 'pick' && line.item
					? { itemId: line.item.id }
					: {
							draftItem: {
								name: line.draftName.trim(),
								baseUnit,
								category: line.category,
							},
						}),
				quantity: baseQty,
				lineTotalMinor: amountMinor,
			})
		}

		setSubmitting(true)
		try {
			const result = recordDeliveryResultSchema.parse(
				await request('/deliveries', {
					method: 'POST',
					body: JSON.stringify({
						clientId: clientIdRef.current,
						locationId,
						supplierId: null,
						isCashPurchase: true,
						paid: true,
						currency,
						...(date ? { invoiceDate: date } : {}),
						lines: payloadLines,
					}),
				}),
			)
			if (photo) {
				try {
					await uploadInvoicePhoto(request, result.delivery.id, photo)
				} catch (caught) {
					toast.warning(
						caught instanceof InvoicePhotoError && caught.code !== 'upload'
							? t`Cash purchase saved, but the receipt photo was not attached.`
							: t`Cash purchase saved, but the receipt photo could not be uploaded.`,
					)
				}
			}
			toast.success(t`Cash purchase recorded.`)
			notifyChanged()
			onSaved()
			reset()
			onOpenChange(false)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (submitting) return
				if (!next) reset()
				onOpenChange(next)
			}}
		>
			<DialogContent
				className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
				data-testid="cash-purchase-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Cash purchase</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Record something bought from the market with cash. Saved under
							Market / cash and marked paid.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{error ? (
					<Alert variant="destructive" data-testid="cash-purchase-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<TextField
					label={<Trans>Date</Trans>}
					type="date"
					value={date}
					onChange={(event) => setDate(event.target.value)}
					dir="ltr"
					data-testid="cash-purchase-date"
				/>

				<ul className="flex flex-col gap-3" data-testid="cash-purchase-lines">
					{lines.map((line, index) => {
						const baseUnit =
							line.mode === 'pick'
								? (line.item?.baseUnit ?? 'g')
								: baseUnitFor(line.measuredIn)
						const unitOptions = standardUnitsFor(baseUnit, quantity.system)
						return (
							<li
								key={line.key}
								className="bg-card flex flex-col gap-3 rounded-xl border p-3"
								data-testid={`cash-purchase-line-${index}`}
							>
								<div className="flex items-center justify-between gap-2">
									<div className="flex gap-1">
										<Button
											type="button"
											size="sm"
											variant={line.mode === 'pick' ? 'secondary' : 'outline'}
											onClick={() =>
												patchLine(line.key, (current) => ({
													...current,
													mode: 'pick',
												}))
											}
											data-testid={`cash-line-mode-pick-${index}`}
										>
											<Trans>Existing item</Trans>
										</Button>
										<Button
											type="button"
											size="sm"
											variant={line.mode === 'draft' ? 'secondary' : 'outline'}
											onClick={() =>
												patchLine(line.key, (current) => ({
													...current,
													mode: 'draft',
													unit: defaultMeasureUnit(
														current.measuredIn,
														quantity.system,
													),
												}))
											}
											data-testid={`cash-line-mode-draft-${index}`}
										>
											<Trans>New item (draft)</Trans>
										</Button>
									</div>
									{lines.length > 1 ? (
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-8"
											aria-label={t`Remove line`}
											onClick={() =>
												setLines((current) =>
													current.filter((entry) => entry.key !== line.key),
												)
											}
										>
											<Icon name="x" />
										</Button>
									) : null}
								</div>

								{line.mode === 'pick' ? (
									<ItemPicker
										label={<Trans>Item</Trans>}
										client={client}
										locationId={locationId}
										value={line.item}
										onChange={(item) =>
											patchLine(line.key, (current) => ({
												...current,
												item,
												unit: defaultEntryUnit(
													item.baseUnit,
													item.countUnit,
													item.units,
													quantity.system,
												),
											}))
										}
										placeholder={t`Search your items`}
										testId={`cash-line-item-${index}`}
									/>
								) : (
									<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
										<TextField
											label={<Trans>New item name</Trans>}
											value={line.draftName}
											onChange={(event) =>
												patchLine(line.key, (current) => ({
													...current,
													draftName: event.target.value,
												}))
											}
											placeholder={t`Fresh mint`}
											dir="auto"
											data-testid={`cash-line-draft-name-${index}`}
										/>
										<SelectField
											label={<Trans>Measured in</Trans>}
											testId={`cash-line-draft-unit-${index}`}
											options={MEASURED_IN.map((val) => ({
												value: val,
												label: quantity.unitName(
													defaultMeasureUnit(val, quantity.system),
													[],
												),
											}))}
											value={line.measuredIn}
											onValueChange={(next) => {
												const measuredIn = next as MeasuredIn
												patchLine(line.key, (current) => ({
													...current,
													measuredIn,
													unit: defaultMeasureUnit(measuredIn, quantity.system),
												}))
											}}
										/>
										<SelectField
											label={<Trans>Category</Trans>}
											options={INVENTORY_CATEGORIES.map((category) => ({
												value: category,
												label: categoryLabel(category, i18n),
											}))}
											value={line.category}
											onValueChange={(next) =>
												patchLine(line.key, (current) => ({
													...current,
													category: next as InventoryCategory,
												}))
											}
										/>
									</div>
								)}

								<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
									<div className="flex flex-col gap-1.5">
										<Label className="text-sm font-medium">
											<Trans>Quantity</Trans>
										</Label>
										<div className="flex gap-1">
											<Input
												value={line.quantityText}
												onChange={(event) =>
													patchLine(line.key, (current) => ({
														...current,
														quantityText: event.target.value,
													}))
												}
												inputMode="decimal"
												dir="ltr"
												placeholder="2"
												className="h-11 tabular-nums md:h-8"
												data-testid={`cash-line-qty-${index}`}
											/>
											<SelectField
												label={
													<span className="sr-only">
														<Trans>Unit</Trans>
													</span>
												}
												options={unitOptions.map((u) => ({
													value: u,
													label: quantity.unitName(u, []),
												}))}
												value={line.unit}
												onValueChange={(next) =>
													patchLine(line.key, (current) => ({
														...current,
														unit: next as UnitRef,
													}))
												}
											/>
										</div>
									</div>
									<TextField
										label={<Trans>Amount paid ({currency})</Trans>}
										value={line.amountText}
										onChange={(event) =>
											patchLine(line.key, (current) => ({
												...current,
												amountText: event.target.value,
											}))
										}
										inputMode="decimal"
										dir="ltr"
										placeholder="25.00"
										data-testid={`cash-line-amount-${index}`}
									/>
								</div>
							</li>
						)
					})}
				</ul>

				<div className="flex flex-wrap items-center justify-between gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={addLine}
						data-testid="cash-purchase-add-line"
					>
						<Icon name="plus" />
						<Trans>Add another item</Trans>
					</Button>
					<span className="text-sm font-medium tabular-nums">
						{(() => {
							const totalPaidText = formatMoney(
								totalPaidMinor,
								currency,
								i18n.locale,
							)
							return (
								<Trans>
									Total paid: <bdi dir="ltr">{totalPaidText}</bdi>
								</Trans>
							)
						})()}
					</span>
				</div>

				<div className="flex flex-col gap-2">
					<Label
						htmlFor={`${idPrefix}-receipt`}
						className="text-sm font-medium"
					>
						<Trans>Receipt photo (optional)</Trans>
					</Label>
					{photoProblem ? (
						<p className="text-destructive text-xs" role="alert">
							{photoProblem}
						</p>
					) : null}
					<div className="flex flex-wrap items-center gap-2">
						<input
							id={`${idPrefix}-receipt`}
							ref={photoInputRef}
							type="file"
							accept="image/jpeg,image/png,image/webp"
							capture="environment"
							className="sr-only"
							onChange={(event) => {
								const file = event.target.files?.[0] ?? null
								event.target.value = ''
								if (!file) return
								if (!isAllowedInvoicePhotoType(file.type)) {
									setPhoto(null)
									setPhotoProblem(t`Choose a JPEG, PNG or WebP picture.`)
								} else {
									setPhoto(file)
									setPhotoProblem(null)
								}
							}}
							data-testid="cash-purchase-photo-input"
						/>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => photoInputRef.current?.click()}
							data-testid="cash-purchase-photo-button"
						>
							<Icon name="camera" />
							{photo ? (
								<span className="wrap-anywhere">{photo.name}</span>
							) : (
								<Trans>Add receipt photo</Trans>
							)}
						</Button>
						{photo ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => setPhoto(null)}
							>
								<Trans>Remove</Trans>
							</Button>
						) : null}
					</div>
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							reset()
							onOpenChange(false)
						}}
						disabled={submitting}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={submitting}
						onClick={() => void submit()}
						data-testid="cash-purchase-submit"
					>
						{submitting ? (
							<Trans>Saving…</Trans>
						) : (
							<Trans>Save cash purchase</Trans>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
