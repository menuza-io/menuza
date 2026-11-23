import { plural } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_BASE_UNITS,
	INVENTORY_CATEGORIES,
	type InventoryBaseUnit,
	type InventoryCategory,
	priceListApplyResultSchema,
	type PriceListParseResult,
	priceListParseResultSchema,
	type PriceListProposalLine,
	standardUnitsFor,
	type UnitRef,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
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
import { useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { ItemPicker } from '#app/components/inventory/item-picker.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import {
	fileToBase64,
	inferUploadContentType,
	isSupportedDocumentUpload,
	MAX_DOCUMENT_UPLOAD_BYTES,
} from '#app/utils/inventory/file-base64.ts'
import {
	defaultEntryUnit,
	formatMoney,
	thousandthsInUnit,
} from '#app/utils/inventory/format.ts'
import {
	inventorySaveErrorMessage,
	invoiceReadErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { categoryLabel } from '#app/utils/inventory/labels.ts'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'

type EditablePriceLine = {
	lineKey: string
	rawText: string
	action: 'upsert' | 'skip'
	sku: string
	itemMode: 'match' | 'create'
	matchedItemId: string | null
	matchedItemName: string | null
	createItemName: string
	baseUnit: InventoryBaseUnit
	category: InventoryCategory
	existingProductId: string | null
	packName: string
	packAmountText: string
	packAmountUnit: UnitRef
	priceText: string
	pricedByWeight: boolean
	changeKind: PriceListProposalLine['changeKind']
	previousPriceMinor: number | null
	warnings: string[]
}

function todayIso(): string {
	const now = new Date()
	const month = String(now.getMonth() + 1).padStart(2, '0')
	const day = String(now.getDate()).padStart(2, '0')
	return `${now.getFullYear()}-${month}-${day}`
}

function defaultUnitForBase(
	baseUnit: InventoryBaseUnit,
	system: 'metric' | 'us',
): UnitRef {
	return defaultEntryUnit(baseUnit, null, [], system)
}

function toEditableLine(
	line: PriceListProposalLine,
	currency: string,
	system: 'metric' | 'us',
): EditablePriceLine {
	const unit = defaultUnitForBase(line.baseUnit, system)
	const perUnit = thousandthsInUnit(unit, line.baseUnit) ?? 1000
	const amount = Math.max(
		0.001,
		Math.round((line.packBaseQuantity / perUnit) * 1000) / 1000,
	)
	const isMatch = line.matchedItemId !== null
	return {
		lineKey: line.lineKey,
		rawText: line.rawText,
		action: line.priceMinor !== null ? 'upsert' : 'skip',
		sku: line.sku ?? '',
		itemMode: isMatch ? 'match' : 'create',
		matchedItemId: line.matchedItemId,
		matchedItemName: line.matchedItemName,
		createItemName: line.name,
		baseUnit: line.baseUnit,
		category: line.category as InventoryCategory,
		existingProductId: line.existingProductId,
		packName: line.packName,
		packAmountText: String(amount),
		packAmountUnit: unit,
		priceText:
			line.priceMinor !== null
				? minorToMajorText(line.priceMinor, currency)
				: '',
		pricedByWeight: line.pricedByWeight,
		changeKind: line.changeKind,
		previousPriceMinor: line.previousPriceMinor,
		warnings: line.warnings,
	}
}

function computePackBaseQuantity(line: EditablePriceLine): number | null {
	const parsed = parseQuantityText(line.packAmountText)
	if (parsed === null || parsed <= 0) return null
	const perUnit = thousandthsInUnit(line.packAmountUnit, line.baseUnit)
	if (perUnit === null) return null
	const base = Math.round(parsed * perUnit)
	return base >= 1 ? base : null
}

/**
 * Import a supplier price list from CSV, XLSX, PDF, or photo (#505).
 * Parses into a review table first (nothing is saved until Apply). On
 * re-import, highlights what is new or price-changed and collapses unchanged
 * lines by default, while offering missing products to archive.
 */
export function PriceListImportDialog({
	open,
	onOpenChange,
	supplierId,
	supplierName,
	currency,
	locationId,
	onImported,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	supplierId: string
	supplierName: string
	currency: string
	locationId: string
	onImported: () => void
}) {
	const { t, i18n } = useLingui()
	const client = useInventoryClient()
	const { request } = client
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const idPrefix = useId()
	const fileInputRef = useRef<HTMLInputElement>(null)

	const [parsing, setParsing] = useState(false)
	const [applying, setApplying] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [confirmDiscard, setConfirmDiscard] = useState(false)
	const [parsed, setParsed] = useState<PriceListParseResult | null>(null)
	const [lines, setLines] = useState<EditablePriceLine[]>([])
	const [effectiveDate, setEffectiveDate] = useState(todayIso)
	const [archiveGoneIds, setArchiveGoneIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	)
	const [showUnchanged, setShowUnchanged] = useState(false)
	const [changedOnlyFilter, setChangedOnlyFilter] = useState(true)

	function reset() {
		setParsing(false)
		setApplying(false)
		setError(null)
		setConfirmDiscard(false)
		setParsed(null)
		setLines([])
		setEffectiveDate(todayIso())
		setArchiveGoneIds(new Set())
		setShowUnchanged(false)
		setChangedOnlyFilter(true)
	}

	async function handleFile(file: File | undefined) {
		if (!file || parsing) return
		if (!isSupportedDocumentUpload(file)) {
			setError(
				t`Only CSV, TSV, Excel (XLSX), PDF, or image files are supported.`,
			)
			return
		}
		if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
			setError(t`File must be 7.5 MB or smaller.`)
			return
		}
		setParsing(true)
		setError(null)
		setConfirmDiscard(false)
		try {
			const contentBase64 = await fileToBase64(file)
			const contentType = inferUploadContentType(file)
			const result = priceListParseResultSchema.parse(
				await request(
					`/suppliers/${encodeURIComponent(supplierId)}/price-list/parse`,
					{
						method: 'POST',
						body: JSON.stringify({
							fileName: file.name,
							contentType,
							contentBase64,
						}),
					},
				),
			)
			setParsed(result)
			setLines(
				result.lines.map((line) =>
					toEditableLine(line, result.currency || currency, quantity.system),
				),
			)
			setArchiveGoneIds(new Set())
			const hasExisting = result.lines.some((line) => line.changeKind !== 'new')
			setChangedOnlyFilter(hasExisting)
			setShowUnchanged(!hasExisting)
		} catch (caught) {
			setError(i18n._(invoiceReadErrorMessage(caught)))
		} finally {
			setParsing(false)
		}
	}

	function patchLine(
		lineKey: string,
		update: (line: EditablePriceLine) => EditablePriceLine,
	) {
		setLines((current) =>
			current.map((line) => (line.lineKey === lineKey ? update(line) : line)),
		)
	}

	const isReimport = useMemo(
		() =>
			parsed !== null &&
			(parsed.lines.some((line) => line.changeKind !== 'new') ||
				parsed.goneProducts.length > 0),
		[parsed],
	)

	const changedLines = useMemo(
		() => lines.filter((line) => line.changeKind !== 'unchanged'),
		[lines],
	)
	const unchangedLines = useMemo(
		() => lines.filter((line) => line.changeKind === 'unchanged'),
		[lines],
	)
	const acceptedCount = useMemo(
		() => lines.filter((line) => line.action === 'upsert').length,
		[lines],
	)
	const allAccepted = lines.length > 0 && acceptedCount === lines.length

	function toggleAcceptAll(checked: boolean) {
		setLines((current) =>
			current.map((line) => ({
				...line,
				action: checked ? 'upsert' : 'skip',
			})),
		)
	}

	async function applyImport() {
		if (!parsed || applying) return
		setError(null)
		const activeCurrency = parsed.currency || currency
		const payloadLines: Array<{
			action: 'upsert' | 'skip'
			existingProductId?: string | null
			matchedItemId?: string | null
			createItem?: {
				name: string
				baseUnit: InventoryBaseUnit
				category?: InventoryCategory
			}
			packName: string
			packBaseQuantity: number
			priceMinor: number
			pricedByWeight: boolean
			sku?: string | null
		}> = []

		for (const line of lines) {
			const packBaseQuantity = computePackBaseQuantity(line)
			const priceMinor = parseMoneyToMinor(line.priceText, {
				currency: activeCurrency,
				min: 0,
			})
			if (line.action === 'skip') {
				payloadLines.push({
					action: 'skip',
					existingProductId: line.existingProductId,
					matchedItemId: line.matchedItemId,
					packName: line.packName.trim() || 'Pack',
					packBaseQuantity: packBaseQuantity ?? 1000,
					priceMinor: priceMinor ?? 0,
					pricedByWeight: line.pricedByWeight,
					sku: line.sku.trim() || null,
				})
				continue
			}

			const label = line.createItemName || line.rawText
			const raw = line.rawText
			if (packBaseQuantity === null) {
				setError(t`Check the pack size on "${label}".`)
				return
			}
			if (priceMinor === null) {
				setError(t`Enter a valid price on "${label}".`)
				return
			}
			if (line.packName.trim() === '') {
				setError(t`Enter a pack name on "${label}".`)
				return
			}
			if (line.itemMode === 'match' && !line.matchedItemId) {
				setError(t`Pick an item or switch to New item on "${raw}".`)
				return
			}
			if (line.itemMode === 'create' && line.createItemName.trim() === '') {
				setError(t`Enter a name for each new item.`)
				return
			}

			payloadLines.push({
				action: 'upsert',
				...(line.existingProductId
					? { existingProductId: line.existingProductId }
					: {}),
				...(line.itemMode === 'match'
					? { matchedItemId: line.matchedItemId }
					: {
							createItem: {
								name: line.createItemName.trim(),
								baseUnit: line.baseUnit,
								category: line.category,
							},
						}),
				packName: line.packName.trim(),
				packBaseQuantity,
				priceMinor,
				pricedByWeight: line.pricedByWeight,
				sku: line.sku.trim() || null,
			})
		}

		if (payloadLines.length === 0) {
			setError(t`No lines to apply.`)
			return
		}

		setApplying(true)
		try {
			const res = priceListApplyResultSchema.parse(
				await request(
					`/suppliers/${encodeURIComponent(supplierId)}/price-list/apply`,
					{
						method: 'POST',
						body: JSON.stringify({
							...(effectiveDate ? { effectiveDate } : {}),
							currency: activeCurrency,
							lines: payloadLines,
							...(archiveGoneIds.size > 0
								? { archiveGoneProductIds: [...archiveGoneIds] }
								: {}),
						}),
					},
				),
			)
			toast.success(t`Price list applied.`, {
				description: plural(res.recordedPrices, {
					one: '# price saved to history.',
					other: '# prices saved to history.',
				}),
			})
			notifyChanged()
			onImported()
			reset()
			onOpenChange(false)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setApplying(false)
		}
	}

	const money = (minor: number, code?: string) =>
		formatMoney(minor, code ?? parsed?.currency ?? currency, i18n.locale)

	const visibleChanged = changedOnlyFilter ? changedLines : lines

	return (
		<Dialog
			open={open}
			disablePointerDismissal={Boolean(parsed)}
			onOpenChange={(next, details) => {
				if (parsing || applying) return
				if (
					!next &&
					parsed &&
					details?.reason === 'escape-key' &&
					!confirmDiscard
				) {
					setConfirmDiscard(true)
					return
				}
				if (!next) reset()
				onOpenChange(next)
			}}
		>
			<DialogContent
				className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
				data-testid="price-list-import-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Import price list</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Upload a CSV, Excel (XLSX), PDF, or photo from{' '}
							<span className="wrap-anywhere">{supplierName}</span>. Review
							every line before anything is saved.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{error ? (
					<Alert variant="destructive" data-testid="price-list-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				{!parsed ? (
					<div className="flex flex-col gap-4 py-2">
						<input
							ref={fileInputRef}
							type="file"
							accept=".csv,.tsv,.xlsx,.pdf,image/jpeg,image/png,image/webp"
							className="sr-only"
							onChange={(event) => {
								const file = event.target.files?.[0]
								event.target.value = ''
								void handleFile(file)
							}}
							data-testid="price-list-file-input"
						/>
						<Button
							type="button"
							variant="outline"
							disabled={parsing}
							onClick={() => fileInputRef.current?.click()}
							className="h-24 flex-col gap-2 border-dashed"
							data-testid="price-list-upload-button"
						>
							<Icon name={parsing ? 'loader' : 'arrow-up-from-line'} />
							{parsing ? (
								<Trans>Reading price list…</Trans>
							) : (
								<Trans>Choose CSV, XLSX, PDF, or photo</Trans>
							)}
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border p-3">
							<div className="flex flex-col gap-1 text-sm">
								<span className="font-medium wrap-anywhere">
									{parsed.fileName}
								</span>
								<span className="text-muted-foreground text-xs">
									<Plural
										value={parsed.lines.length}
										one="# line parsed"
										other="# lines parsed"
									/>
									{parsed.truncated ? (
										<>
											{' · '}
											<Trans>First 500 lines shown</Trans>
										</>
									) : null}
								</span>
							</div>
							<div className="flex flex-wrap items-end gap-3">
								<TextField
									label={<Trans>Price list date</Trans>}
									type="date"
									value={effectiveDate}
									onChange={(event) => setEffectiveDate(event.target.value)}
									dir="ltr"
									data-testid="price-list-effective-date"
								/>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => fileInputRef.current?.click()}
									disabled={parsing || applying}
								>
									<Trans>Choose another file</Trans>
								</Button>
								<input
									ref={fileInputRef}
									type="file"
									accept=".csv,.tsv,.xlsx,.pdf,image/jpeg,image/png,image/webp"
									className="sr-only"
									onChange={(event) => {
										const file = event.target.files?.[0]
										event.target.value = ''
										void handleFile(file)
									}}
									data-testid="price-list-file-input"
								/>
							</div>
						</div>

						<div className="flex flex-wrap items-center justify-between gap-3">
							<div className="flex items-center gap-2">
								<Checkbox
									id={`${idPrefix}-accept-all`}
									checked={allAccepted}
									onCheckedChange={toggleAcceptAll}
									data-testid="price-list-accept-all"
								/>
								<Label
									htmlFor={`${idPrefix}-accept-all`}
									className="cursor-pointer text-sm font-medium"
								>
									<Trans>Accept all</Trans>
								</Label>
								<span className="text-muted-foreground text-xs tabular-nums">
									(<bdi dir="ltr">{acceptedCount}</bdi>/
									<bdi dir="ltr">{lines.length}</bdi>)
								</span>
							</div>
							{isReimport ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setChangedOnlyFilter((v) => !v)}
									data-testid="price-list-filter-changed"
								>
									{changedOnlyFilter ? (
										<Trans>Showing changed &amp; new</Trans>
									) : (
										<Trans>Showing all lines</Trans>
									)}
								</Button>
							) : null}
						</div>

						{visibleChanged.length === 0 && isReimport ? (
							<Alert data-testid="price-list-no-changes">
								<AlertDescription>
									<Trans>
										No new products or price changes were found compared with
										your saved list.
									</Trans>
								</AlertDescription>
							</Alert>
						) : (
							<ul
								className="flex flex-col gap-3"
								data-testid="price-list-review-lines"
							>
								{visibleChanged.map((line) => (
									<PriceListLineCard
										key={line.lineKey}
										line={line}
										currency={parsed.currency || currency}
										locationId={locationId}
										client={client}
										system={quantity.system}
										money={money}
										onChange={(updater) => patchLine(line.lineKey, updater)}
									/>
								))}
							</ul>
						)}

						{isReimport && changedOnlyFilter && unchangedLines.length > 0 ? (
							<Collapsible
								open={showUnchanged}
								onOpenChange={setShowUnchanged}
								data-testid="price-list-unchanged-section"
							>
								<CollapsibleTrigger
									render={
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="gap-2"
											data-testid="price-list-toggle-unchanged"
										/>
									}
								>
									<Icon
										name={showUnchanged ? 'chevron-down' : 'chevron-right'}
									/>
									<Plural
										value={unchangedLines.length}
										one="# unchanged line"
										other="# unchanged lines"
									/>
								</CollapsibleTrigger>
								<CollapsibleContent className="mt-2">
									<ul className="flex flex-col gap-3">
										{unchangedLines.map((line) => (
											<PriceListLineCard
												key={line.lineKey}
												line={line}
												currency={parsed.currency || currency}
												locationId={locationId}
												client={client}
												system={quantity.system}
												money={money}
												onChange={(updater) => patchLine(line.lineKey, updater)}
											/>
										))}
									</ul>
								</CollapsibleContent>
							</Collapsible>
						) : null}

						{parsed.goneProducts.length > 0 ? (
							<div
								className="flex flex-col gap-2 rounded-xl border p-3"
								data-testid="price-list-gone-products"
							>
								<h4 className="text-sm font-semibold">
									<Trans>Missing from this price list</Trans>
								</h4>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Select any products this supplier no longer sells to archive
										them.
									</Trans>
								</p>
								<ul className="flex flex-col divide-y">
									{parsed.goneProducts.map((product) => {
										const checked = archiveGoneIds.has(product.productId)
										const itemName = product.itemName
										const packName = product.packName
										return (
											<li
												key={product.productId}
												className="flex items-center justify-between gap-3 py-2 text-sm"
											>
												<div className="flex items-center gap-2">
													<Checkbox
														checked={checked}
														aria-label={t`Archive ${itemName} (${packName})`}
														onCheckedChange={(next) =>
															setArchiveGoneIds((current) => {
																const copy = new Set(current)
																if (next) copy.add(product.productId)
																else copy.delete(product.productId)
																return copy
															})
														}
														data-testid={`price-list-gone-${product.productId}`}
													/>
													<span className="wrap-anywhere">
														{product.itemName} · {product.packName}
													</span>
												</div>
												{product.priceMinor !== null ? (
													<bdi
														dir="ltr"
														className="text-muted-foreground tabular-nums"
													>
														{money(product.priceMinor)}
													</bdi>
												) : null}
											</li>
										)
									})}
								</ul>
							</div>
						) : null}
					</div>
				)}

				{confirmDiscard ? (
					<Alert variant="destructive" data-testid="price-list-discard-warning">
						<AlertDescription>
							<Trans>
								Discard unsaved price list review? Click Cancel or press Esc
								again to close.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							reset()
							onOpenChange(false)
						}}
						disabled={parsing || applying}
					>
						<Trans>Cancel</Trans>
					</Button>
					{parsed ? (
						<Button
							type="button"
							disabled={applying || acceptedCount === 0}
							onClick={() => void applyImport()}
							data-testid="price-list-apply"
						>
							{applying ? (
								<Trans>Applying…</Trans>
							) : (
								<Plural
									value={acceptedCount}
									one="Apply # line"
									other="Apply # lines"
								/>
							)}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function PriceListLineCard({
	line,
	currency,
	locationId,
	client,
	system,
	money,
	onChange,
}: {
	line: EditablePriceLine
	currency: string
	locationId: string
	client: ReturnType<typeof useInventoryClient>
	system: 'metric' | 'us'
	money: (minor: number) => string
	onChange: (updater: (line: EditablePriceLine) => EditablePriceLine) => void
}) {
	const { t, i18n } = useLingui()
	const quantity = useQuantityFormat()
	const units = standardUnitsFor(line.baseUnit, system)
	const lineLabel = line.createItemName || line.rawText

	return (
		<li
			className="bg-card flex flex-col gap-3 rounded-xl border p-3"
			data-testid={`price-list-line-${line.lineKey}`}
		>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div className="flex items-start gap-2">
					<Checkbox
						checked={line.action === 'upsert'}
						onCheckedChange={(checked) =>
							onChange((current) => ({
								...current,
								action: checked ? 'upsert' : 'skip',
							}))
						}
						aria-label={t`Include ${lineLabel}`}
						data-testid={`price-list-line-accept-${line.lineKey}`}
					/>
					<div className="flex min-w-0 flex-col">
						<span className="text-sm font-medium wrap-anywhere">
							{line.rawText}
						</span>
						<div className="mt-1 flex flex-wrap gap-1">
							{line.changeKind === 'new' ? (
								<Badge variant="default">
									<Trans>New</Trans>
								</Badge>
							) : line.changeKind === 'price_changed' ? (
								<Badge variant="warning">
									<Trans>Price changed</Trans>
									{line.previousPriceMinor !== null ? (
										<>
											{' · '}
											<bdi dir="ltr">{money(line.previousPriceMinor)}</bdi> →
										</>
									) : null}
								</Badge>
							) : (
								<Badge variant="secondary">
									<Trans>Unchanged</Trans>
								</Badge>
							)}
							{line.warnings.map((warning) => (
								<Badge key={warning} variant="outline">
									{warning}
								</Badge>
							))}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant={line.itemMode === 'match' ? 'secondary' : 'outline'}
						size="sm"
						onClick={() =>
							onChange((current) => ({
								...current,
								itemMode: current.itemMode === 'match' ? 'create' : 'match',
							}))
						}
					>
						{line.itemMode === 'match' ? (
							<Trans>Match item</Trans>
						) : (
							<Trans>New item</Trans>
						)}
					</Button>
				</div>
			</div>

			{line.action === 'upsert' ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
					{line.itemMode === 'match' ? (
						<div className="sm:col-span-2">
							<ItemPicker
								label={<Trans>Stock item</Trans>}
								client={client}
								locationId={locationId}
								value={
									line.matchedItemId
										? {
												id: line.matchedItemId,
												name: line.matchedItemName ?? line.createItemName,
											}
										: null
								}
								onChange={(item) =>
									onChange((current) => ({
										...current,
										matchedItemId: item.id,
										matchedItemName: item.name,
										baseUnit: item.baseUnit,
										packAmountUnit: defaultUnitForBase(item.baseUnit, system),
									}))
								}
								placeholder={t`Choose an item`}
							/>
						</div>
					) : (
						<>
							<TextField
								label={<Trans>New item name</Trans>}
								value={line.createItemName}
								onChange={(event) =>
									onChange((current) => ({
										...current,
										createItemName: event.target.value,
									}))
								}
								dir="auto"
							/>
							<div className="grid grid-cols-2 gap-2">
								<SelectField
									label={<Trans>Unit</Trans>}
									options={INVENTORY_BASE_UNITS.map((unit) => ({
										value: unit,
										label: unit,
									}))}
									value={line.baseUnit}
									onValueChange={(next) => {
										const base = next as InventoryBaseUnit
										onChange((current) => ({
											...current,
											baseUnit: base,
											packAmountUnit: defaultUnitForBase(base, system),
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
										onChange((current) => ({
											...current,
											category: next as InventoryCategory,
										}))
									}
								/>
							</div>
						</>
					)}

					<div className="grid grid-cols-2 gap-2">
						<TextField
							label={<Trans>Pack</Trans>}
							value={line.packName}
							onChange={(event) =>
								onChange((current) => ({
									...current,
									packName: event.target.value,
								}))
							}
							dir="auto"
						/>
						<div className="flex flex-col gap-1.5">
							<Label className="text-sm font-medium">
								<Trans>Size</Trans>
							</Label>
							<div className="flex gap-1">
								<Input
									value={line.packAmountText}
									onChange={(event) =>
										onChange((current) => ({
											...current,
											packAmountText: event.target.value,
										}))
									}
									inputMode="decimal"
									dir="ltr"
									className="h-11 w-20 tabular-nums md:h-8"
								/>
								<SelectField
									label={
										<span className="sr-only">
											<Trans>Pack unit</Trans>
										</span>
									}
									options={units.map((unit) => ({
										value: unit,
										label: quantity.unitName(unit, []),
									}))}
									value={line.packAmountUnit}
									onValueChange={(next) =>
										onChange((current) => ({
											...current,
											packAmountUnit: next as UnitRef,
										}))
									}
								/>
							</div>
						</div>
					</div>

					<div className="grid grid-cols-2 gap-2">
						<TextField
							label={<Trans>Price ({currency})</Trans>}
							value={line.priceText}
							onChange={(event) =>
								onChange((current) => ({
									...current,
									priceText: event.target.value,
								}))
							}
							inputMode="decimal"
							dir="ltr"
							data-testid={`price-list-line-price-${line.lineKey}`}
						/>
						<TextField
							label={<Trans>SKU</Trans>}
							optional
							value={line.sku}
							onChange={(event) =>
								onChange((current) => ({ ...current, sku: event.target.value }))
							}
							dir="ltr"
						/>
					</div>
				</div>
			) : null}
		</li>
	)
}
