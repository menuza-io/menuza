import { plural } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type ApplySetupImportResult,
	applySetupImportResultSchema,
	INVENTORY_BASE_UNITS,
	INVENTORY_CATEGORIES,
	type InventoryBaseUnit,
	type InventoryCategory,
	MAX_SETUP_IMPORT_FILES,
	type SetupImportDetail,
	setupImportDetailSchema,
	standardUnitsFor,
	type UnitRef,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Progress } from '@repo/ui/progress'
import { parseQuantityText } from '@repo/ui/quantity-input'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import {
	fileToBase64,
	inferUploadContentType,
	isSupportedDocumentUpload,
	MAX_DOCUMENT_UPLOAD_BYTES,
	MAX_SETUP_BATCH_BYTES,
} from '#app/utils/inventory/file-base64.ts'
import {
	defaultEntryUnit,
	thousandthsInUnit,
} from '#app/utils/inventory/format.ts'
import {
	inventorySaveErrorMessage,
	invoiceReadErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { categoryLabel } from '#app/utils/inventory/labels.ts'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'

type EditableSetupItem = {
	tempKey: string
	include: boolean
	existingItemId: string | null
	itemName: string
	category: InventoryCategory
	baseUnit: InventoryBaseUnit
	packName: string
	packAmountText: string
	packAmountUnit: UnitRef
	priceText: string
	rawPriceMinor: number | null
	sku: string | null
	sourceFiles: string[]
	mergedAliases: string[]
}

type EditableSetupSupplier = {
	tempKey: string
	include: boolean
	existingSupplierId: string | null
	name: string
	sourceFiles: string[]
	items: EditableSetupItem[]
}

function toEditableSuppliers(
	detail: SetupImportDetail,
	currency: string,
	system: 'metric' | 'us',
): EditableSetupSupplier[] {
	return detail.suppliers.map((supplier) => ({
		tempKey: supplier.tempKey,
		include: true,
		existingSupplierId: supplier.existingSupplierId,
		name: supplier.name,
		sourceFiles: supplier.sourceFiles,
		items: supplier.items.map((item) => {
			const unit = defaultEntryUnit(item.baseUnit, null, [], system)
			const perUnit = thousandthsInUnit(unit, item.baseUnit) ?? 1000
			const amount = Math.max(
				0.001,
				Math.round((item.packBaseQuantity / perUnit) * 1000) / 1000,
			)
			return {
				tempKey: item.tempKey,
				include: true,
				existingItemId: item.existingItemId,
				itemName: item.itemName,
				category: item.category as InventoryCategory,
				baseUnit: item.baseUnit,
				packName: item.packName,
				packAmountText: String(amount),
				packAmountUnit: unit,
				priceText:
					item.priceMinor != null
						? minorToMajorText(item.priceMinor, currency)
						: '',
				rawPriceMinor: item.priceMinor ?? null,
				sku: item.sku,
				sourceFiles: item.sourceFiles,
				mergedAliases: item.mergedAliases,
			}
		}),
	}))
}

const POLL_MS = 1500

/**
 * "Start from your invoices" (#506): upload up to 50 past invoices or price
 * lists, track background reading, leave & resume across reloads, review
 * grouped by supplier -> proposed items (with merged aliases), and create in
 * one batch. Nothing is written to Stock or Suppliers until Apply.
 */
export function SetupImportFlow({
	currency,
	canSeeCost,
	existingImports,
	onApplied,
	onCancel,
}: {
	currency: string
	canSeeCost: boolean
	existingImports: readonly SetupImportDetail[]
	onApplied: (result: ApplySetupImportResult) => void
	onCancel: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const idPrefix = useId()
	const fileInputRef = useRef<HTMLInputElement>(null)

	const resumable = existingImports.filter(
		(entry) => entry.status === 'reading' || entry.status === 'ready',
	)
	const [selectedFiles, setSelectedFiles] = useState<File[]>([])
	const [activeImport, setActiveImport] = useState<SetupImportDetail | null>(
		null,
	)
	const [suppliers, setSuppliers] = useState<EditableSetupSupplier[]>([])
	const [seededForId, setSeededForId] = useState<string | null>(null)
	const [starting, setStarting] = useState(false)
	const [applying, setApplying] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [appliedResult, setAppliedResult] =
		useState<ApplySetupImportResult | null>(null)

	// Seed editable supplier/item proposal once an import reaches `ready`.
	useEffect(() => {
		if (!activeImport || activeImport.status !== 'ready') return
		if (seededForId === activeImport.id) return
		setSuppliers(
			toEditableSuppliers(
				activeImport,
				activeImport.currency || currency,
				quantity.system,
			),
		)
		setSeededForId(activeImport.id)
	}, [activeImport, seededForId, currency, quantity.system])

	const activeImportId = activeImport?.id
	const activeImportStatus = activeImport?.status

	// Poll background progress while status is `reading`.
	useEffect(() => {
		if (!activeImportId || activeImportStatus !== 'reading') return
		let live = true
		let consecutiveErrors = 0
		const timer = setInterval(() => {
			request(`/setup/imports/${encodeURIComponent(activeImportId)}`).then(
				(body) => {
					if (!live) return
					const parsed = setupImportDetailSchema.safeParse(body)
					if (parsed.success) {
						consecutiveErrors = 0
						setActiveImport(parsed.data)
					} else {
						consecutiveErrors += 1
						if (consecutiveErrors >= 5) {
							clearInterval(timer)
							setError(
								t`Unable to check reading progress. Leave and resume later.`,
							)
						}
					}
				},
				() => {
					if (!live) return
					consecutiveErrors += 1
					if (consecutiveErrors >= 5) {
						clearInterval(timer)
						setError(
							t`Unable to check reading progress. Leave and resume later.`,
						)
					}
				},
			)
		}, POLL_MS)
		return () => {
			live = false
			clearInterval(timer)
		}
	}, [activeImportId, activeImportStatus, request, t])

	function addFiles(fileList: FileList | null) {
		if (!fileList || fileList.length === 0) return
		const incoming = Array.from(fileList)
		let rejectedType = false
		let rejectedSingleSize = false
		const valid: File[] = []
		for (const file of incoming) {
			if (!isSupportedDocumentUpload(file)) {
				rejectedType = true
				continue
			}
			if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
				rejectedSingleSize = true
				continue
			}
			valid.push(file)
		}

		const next: File[] = [...selectedFiles]
		let totalBytes = next.reduce((sum, f) => sum + f.size, 0)
		let rejectedBatchSize = false
		let rejectedCount = false
		for (const file of valid) {
			if (next.length >= MAX_SETUP_IMPORT_FILES) {
				rejectedCount = true
				break
			}
			if (totalBytes + file.size > MAX_SETUP_BATCH_BYTES) {
				rejectedBatchSize = true
				continue
			}
			totalBytes += file.size
			next.push(file)
		}

		setSelectedFiles(next)
		if (rejectedType) {
			setError(
				t`Only CSV, TSV, Excel (XLSX), PDF, or image files are supported.`,
			)
		} else if (rejectedSingleSize) {
			setError(t`Each file must be 7.5 MB or smaller.`)
		} else if (rejectedBatchSize) {
			setError(t`Total batch size cannot exceed 18 MB.`)
		} else if (rejectedCount) {
			setError(
				t`You can upload up to ${MAX_SETUP_IMPORT_FILES} files in one batch.`,
			)
		} else {
			setError(null)
		}
	}

	async function startImport() {
		if (starting || selectedFiles.length === 0) return
		setStarting(true)
		setError(null)
		try {
			const files = await Promise.all(
				selectedFiles.map(async (file) => ({
					fileName: file.name,
					contentType: inferUploadContentType(file),
					contentBase64: await fileToBase64(file),
				})),
			)
			const started = setupImportDetailSchema.parse(
				await request('/setup/imports', {
					method: 'POST',
					body: JSON.stringify({ files }),
				}),
			)
			setSelectedFiles([])
			setSeededForId(null)
			setActiveImport(started)
		} catch (caught) {
			setError(i18n._(invoiceReadErrorMessage(caught)))
		} finally {
			setStarting(false)
		}
	}

	async function resumeImport(entry: SetupImportDetail) {
		setError(null)
		setSeededForId(null)
		try {
			const fresh = setupImportDetailSchema.parse(
				await request(`/setup/imports/${encodeURIComponent(entry.id)}`),
			)
			setActiveImport(fresh)
		} catch {
			setActiveImport(entry)
		}
	}

	function patchSupplier(
		tempKey: string,
		update: (supplier: EditableSetupSupplier) => EditableSetupSupplier,
	) {
		setSuppliers((current) =>
			current.map((supplier) =>
				supplier.tempKey === tempKey ? update(supplier) : supplier,
			),
		)
	}

	function patchItem(
		supplierKey: string,
		itemKey: string,
		update: (item: EditableSetupItem) => EditableSetupItem,
	) {
		patchSupplier(supplierKey, (supplier) => ({
			...supplier,
			items: supplier.items.map((item) =>
				item.tempKey === itemKey ? update(item) : item,
			),
		}))
	}

	async function applyImport() {
		if (!activeImport || applying) return
		setError(null)
		const activeCurrency = activeImport.currency || currency
		const payloadSuppliers = []
		let includedItemCount = 0

		for (const supplier of suppliers) {
			if (supplier.include && supplier.name.trim() === '') {
				setError(t`Enter a name for every included supplier.`)
				return
			}
			const payloadItems = []
			for (const item of supplier.items) {
				const parsedAmount = parseQuantityText(item.packAmountText)
				const perUnit = thousandthsInUnit(item.packAmountUnit, item.baseUnit)
				const packBaseQuantity =
					parsedAmount !== null && parsedAmount > 0 && perUnit !== null
						? Math.round(parsedAmount * perUnit)
						: 1000
				const priceMinor = canSeeCost
					? item.priceText.trim() === ''
						? null
						: parseMoneyToMinor(item.priceText, {
								currency: activeCurrency,
								min: 0,
							})
					: item.rawPriceMinor
				if (supplier.include && item.include) {
					const itemLabel = item.itemName
					if (item.itemName.trim() === '') {
						setError(t`Enter a name for every included item.`)
						return
					}
					if (packBaseQuantity < 1) {
						setError(t`Check the pack size on "${itemLabel}".`)
						return
					}
					if (
						canSeeCost &&
						item.priceText.trim() !== '' &&
						priceMinor === null
					) {
						setError(t`Check the price on "${itemLabel}".`)
						return
					}
					includedItemCount += 1
				}
				payloadItems.push({
					include: supplier.include && item.include,
					...(item.existingItemId
						? { existingItemId: item.existingItemId }
						: {}),
					itemName: item.itemName.trim() || 'Item',
					category: item.category,
					baseUnit: item.baseUnit,
					packName: item.packName.trim() || 'Pack',
					packBaseQuantity: Math.max(1, packBaseQuantity),
					...(priceMinor !== null ? { priceMinor } : {}),
					...(item.sku ? { sku: item.sku } : {}),
				})
			}
			payloadSuppliers.push({
				include: supplier.include,
				...(supplier.existingSupplierId
					? { existingSupplierId: supplier.existingSupplierId }
					: {}),
				name: supplier.name.trim() || 'Supplier',
				items: payloadItems,
			})
		}

		if (includedItemCount === 0) {
			setError(t`Select at least one item to create.`)
			return
		}

		setApplying(true)
		try {
			const res = applySetupImportResultSchema.parse(
				await request(
					`/setup/imports/${encodeURIComponent(activeImport.id)}/apply`,
					{
						method: 'POST',
						body: JSON.stringify({
							currency: activeCurrency,
							suppliers: payloadSuppliers,
						}),
					},
				),
			)
			setAppliedResult(res)
			notifyChanged()
			toast.success(
				plural(res.itemsCreated, {
					one: '# item added.',
					other: '# items added.',
				}),
			)
			onApplied(res)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setApplying(false)
		}
	}

	if (appliedResult) {
		const { suppliersCreated, itemsCreated, productsUpserted } = appliedResult
		return (
			<div className="flex flex-col gap-4" data-testid="setup-import-done">
				<Alert>
					<Icon name="check-circle" />
					<AlertDescription>
						<Trans>
							Created <bdi dir="ltr">{suppliersCreated}</bdi> suppliers,{' '}
							<bdi dir="ltr">{itemsCreated}</bdi> stock items, and{' '}
							<bdi dir="ltr">{productsUpserted}</bdi> supplier products.
						</Trans>
					</AlertDescription>
				</Alert>
				<div className="flex justify-end">
					<Button
						type="button"
						onClick={onCancel}
						data-testid="setup-import-close"
					>
						<Trans>Done</Trans>
					</Button>
				</div>
			</div>
		)
	}

	if (!activeImport) {
		return (
			<div className="flex flex-col gap-4" data-testid="setup-import-upload">
				{error ? (
					<Alert variant="destructive" data-testid="setup-import-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				{resumable.length > 0 ? (
					<div
						className="flex flex-col gap-2 rounded-xl border p-3"
						data-testid="setup-import-resumable"
					>
						<h4 className="text-sm font-semibold">
							<Trans>Saved invoice batches</Trans>
						</h4>
						<ul className="flex flex-col divide-y">
							{resumable.map((entry) => (
								<li
									key={entry.id}
									className="flex items-center justify-between gap-3 py-2 text-sm"
								>
									<div className="flex min-w-0 flex-col">
										<span className="font-medium">
											<Plural
												value={entry.totalFiles}
												one="# file"
												other="# files"
											/>
											{' · '}
											{entry.status === 'reading' ? (
												<Trans>Reading…</Trans>
											) : (
												<Trans>Ready to review</Trans>
											)}
										</span>
										<span className="text-muted-foreground text-xs">
											<bdi dir="ltr">
												{new Intl.DateTimeFormat(i18n.locale, {
													dateStyle: 'medium',
													timeStyle: 'short',
												}).format(new Date(entry.createdAt))}
											</bdi>
										</span>
									</div>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => void resumeImport(entry)}
										data-testid={`setup-import-resume-${entry.id}`}
									>
										<Trans>Resume</Trans>
									</Button>
								</li>
							))}
						</ul>
					</div>
				) : null}

				<input
					ref={fileInputRef}
					type="file"
					multiple
					accept=".pdf,.csv,.tsv,.xlsx,image/jpeg,image/png,image/webp"
					className="sr-only"
					onChange={(event) => {
						addFiles(event.target.files)
						event.target.value = ''
					}}
					data-testid="setup-import-file-input"
				/>
				<Button
					type="button"
					variant="outline"
					onClick={() => fileInputRef.current?.click()}
					className="h-24 flex-col gap-2 border-dashed"
					data-testid="setup-import-choose"
				>
					<Icon name="arrow-up-from-line" />
					<Trans>Choose up to 50 invoices or price lists</Trans>
					<span className="text-muted-foreground text-xs font-normal">
						<Trans>PDF, photo, CSV, or Excel (XLSX)</Trans>
					</span>
				</Button>

				{selectedFiles.length > 0 ? (
					<div className="flex flex-col gap-2">
						<p className="text-sm font-medium">
							<Plural
								value={selectedFiles.length}
								one="# file selected"
								other="# files selected"
							/>
						</p>
						<ul
							className="flex max-h-48 flex-col divide-y overflow-y-auto rounded-xl border"
							data-testid="setup-import-selected-files"
						>
							{selectedFiles.map((file, index) => {
								const fileName = file.name
								return (
									<li
										key={`${fileName}-${index}`}
										className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
									>
										<span className="min-w-0 truncate wrap-anywhere">
											{fileName}
										</span>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-8 shrink-0"
											aria-label={t`Remove ${fileName}`}
											onClick={() =>
												setSelectedFiles((current) =>
													current.filter((_, i) => i !== index),
												)
											}
										>
											<Icon name="x" />
										</Button>
									</li>
								)
							})}
						</ul>
					</div>
				) : null}

				<div className="flex justify-end gap-2 pt-2">
					<Button type="button" variant="outline" onClick={onCancel}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={starting || selectedFiles.length === 0}
						onClick={() => void startImport()}
						data-testid="setup-import-start"
					>
						{starting ? (
							<>
								<Icon name="loader" className="animate-spin" />
								<Trans>Uploading…</Trans>
							</>
						) : (
							<Trans>Read invoices</Trans>
						)}
					</Button>
				</div>
			</div>
		)
	}

	if (activeImport.status === 'reading') {
		const pct =
			activeImport.totalFiles > 0
				? Math.round(
						(activeImport.completedFiles / activeImport.totalFiles) * 100,
					)
				: 0
		return (
			<div
				className="flex flex-col gap-4"
				role="status"
				aria-live="polite"
				data-testid="setup-import-progress"
			>
				{error ? (
					<Alert variant="destructive" data-testid="setup-import-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between text-sm">
						<span className="font-medium">
							<Trans>Reading your invoices…</Trans>
						</span>
						<bdi dir="ltr" className="text-muted-foreground tabular-nums">
							{activeImport.completedFiles}/{activeImport.totalFiles}
						</bdi>
					</div>
					<Progress value={pct} aria-label={t`Reading progress`} />
					<p className="text-muted-foreground text-xs">
						<Trans>
							You can close this sheet and come back anytime to resume. Nothing
							is created until you review and confirm.
						</Trans>
					</p>
				</div>
				<ul className="flex max-h-60 flex-col divide-y overflow-y-auto rounded-xl border text-sm">
					{activeImport.files.map((file) => (
						<li
							key={file.id}
							className="flex items-center justify-between gap-2 px-3 py-2"
						>
							<span className="min-w-0 truncate wrap-anywhere">
								{file.fileName}
							</span>
							<Badge
								variant={
									file.status === 'done'
										? 'success'
										: file.status === 'failed'
											? 'destructive'
											: 'outline'
								}
							>
								{file.status === 'done' ? (
									<Trans>Done</Trans>
								) : file.status === 'failed' ? (
									<Trans>Failed</Trans>
								) : file.status === 'reading' ? (
									<Trans>Reading…</Trans>
								) : (
									<Trans>Pending</Trans>
								)}
							</Badge>
						</li>
					))}
				</ul>
				<div className="flex justify-end">
					<Button type="button" variant="outline" onClick={onCancel}>
						<Trans>Leave and resume later</Trans>
					</Button>
				</div>
			</div>
		)
	}

	if (activeImport.status === 'failed' && suppliers.length === 0) {
		return (
			<div className="flex flex-col gap-4" data-testid="setup-import-failed">
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>
							We could not read items from those files. Try clearer photos or a
							spreadsheet.
						</Trans>
					</AlertDescription>
				</Alert>
				<div className="flex justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => setActiveImport(null)}
					>
						<Trans>Start over</Trans>
					</Button>
				</div>
			</div>
		)
	}

	const totalIncluded = suppliers.reduce(
		(sum, s) =>
			s.include ? sum + s.items.filter((item) => item.include).length : sum,
		0,
	)

	return (
		<div className="flex flex-col gap-4" data-testid="setup-import-review">
			{error ? (
				<Alert variant="destructive" data-testid="setup-import-error">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			<p className="text-muted-foreground text-sm">
				<Trans>
					Review suppliers and items found across your files. Nothing is created
					until you confirm.
				</Trans>
			</p>
			<div className="flex flex-col gap-4">
				{suppliers.map((supplier) => {
					const supplierName = supplier.name
					return (
						<div
							key={supplier.tempKey}
							className="flex flex-col gap-3 rounded-xl border p-3"
							data-testid={`setup-import-supplier-${supplier.tempKey}`}
						>
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div className="flex min-w-0 flex-1 items-center gap-2">
									<Checkbox
										id={`${idPrefix}-s-${supplier.tempKey}`}
										checked={supplier.include}
										aria-label={t`Include supplier ${supplierName}`}
										onCheckedChange={(checked) =>
											patchSupplier(supplier.tempKey, (current) => ({
												...current,
												include: checked,
											}))
										}
										data-testid={`setup-import-supplier-include-${supplier.tempKey}`}
									/>
									<Input
										value={supplier.name}
										disabled={!supplier.include}
										onChange={(event) =>
											patchSupplier(supplier.tempKey, (current) => ({
												...current,
												name: event.target.value,
											}))
										}
										aria-label={t`Supplier name for ${supplierName}`}
										dir="auto"
										className="h-9 max-w-xs font-medium"
									/>
									<Badge variant="outline">
										{supplier.existingSupplierId ? (
											<Trans>Existing supplier</Trans>
										) : (
											<Trans>New supplier</Trans>
										)}
									</Badge>
								</div>
								<span className="text-muted-foreground text-xs">
									<Plural
										value={supplier.items.length}
										one="# item"
										other="# items"
									/>
								</span>
							</div>

							{supplier.include ? (
								<ul className="flex flex-col gap-2">
									{supplier.items.map((item) => {
										const units = standardUnitsFor(
											item.baseUnit,
											quantity.system,
										)
										const itemName = item.itemName
										const mergedText = item.mergedAliases.join(', ')
										return (
											<li
												key={item.tempKey}
												className="bg-muted/20 flex flex-col gap-2 rounded-lg border p-2.5"
												data-testid={`setup-import-item-${item.tempKey}`}
											>
												<div className="flex flex-wrap items-center justify-between gap-2">
													<div className="flex items-center gap-2">
														<Checkbox
															checked={item.include}
															onCheckedChange={(checked) =>
																patchItem(
																	supplier.tempKey,
																	item.tempKey,
																	(current) => ({
																		...current,
																		include: checked,
																	}),
																)
															}
															aria-label={t`Include ${itemName}`}
															data-testid={`setup-import-item-include-${item.tempKey}`}
														/>
														<Label className="font-medium wrap-anywhere">
															{itemName}
														</Label>
													</div>
													{item.mergedAliases.length > 0 ? (
														<Badge
															variant="secondary"
															data-testid={`setup-import-merged-${item.tempKey}`}
														>
															<Trans>
																Merged:{' '}
																<span className="wrap-anywhere">
																	{mergedText}
																</span>
															</Trans>
														</Badge>
													) : null}
												</div>
												{item.include ? (
													<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
														<TextField
															label={<Trans>Name</Trans>}
															value={item.itemName}
															onChange={(event) =>
																patchItem(
																	supplier.tempKey,
																	item.tempKey,
																	(current) => ({
																		...current,
																		itemName: event.target.value,
																	}),
																)
															}
															dir="auto"
														/>
														<SelectField
															label={<Trans>Category</Trans>}
															options={INVENTORY_CATEGORIES.map((category) => ({
																value: category,
																label: categoryLabel(category, i18n),
															}))}
															value={item.category}
															onValueChange={(next) =>
																patchItem(
																	supplier.tempKey,
																	item.tempKey,
																	(current) => ({
																		...current,
																		category: next as InventoryCategory,
																	}),
																)
															}
														/>
														<div className="grid grid-cols-2 gap-1.5">
															<SelectField
																label={<Trans>Base unit</Trans>}
																options={INVENTORY_BASE_UNITS.map((unit) => ({
																	value: unit,
																	label: unit,
																}))}
																value={item.baseUnit}
																onValueChange={(next) => {
																	const base = next as InventoryBaseUnit
																	patchItem(
																		supplier.tempKey,
																		item.tempKey,
																		(current) => ({
																			...current,
																			baseUnit: base,
																			packAmountUnit: defaultEntryUnit(
																				base,
																				null,
																				[],
																				quantity.system,
																			),
																		}),
																	)
																}}
															/>
															<TextField
																label={<Trans>Pack</Trans>}
																value={item.packName}
																onChange={(event) =>
																	patchItem(
																		supplier.tempKey,
																		item.tempKey,
																		(current) => ({
																			...current,
																			packName: event.target.value,
																		}),
																	)
																}
																dir="auto"
															/>
														</div>
														<div className="grid grid-cols-2 gap-1.5">
															<div className="flex flex-col gap-1.5">
																<Label className="text-sm font-medium">
																	<Trans>Pack size</Trans>
																</Label>
																<div className="flex gap-1">
																	<Input
																		value={item.packAmountText}
																		onChange={(event) =>
																			patchItem(
																				supplier.tempKey,
																				item.tempKey,
																				(current) => ({
																					...current,
																					packAmountText: event.target.value,
																				}),
																			)
																		}
																		inputMode="decimal"
																		dir="ltr"
																		className="h-11 w-16 tabular-nums md:h-8"
																	/>
																	<SelectField
																		label={
																			<span className="sr-only">
																				<Trans>Unit</Trans>
																			</span>
																		}
																		options={units.map((u) => ({
																			value: u,
																			label: quantity.unitName(u, []),
																		}))}
																		value={item.packAmountUnit}
																		onValueChange={(next) =>
																			patchItem(
																				supplier.tempKey,
																				item.tempKey,
																				(current) => ({
																					...current,
																					packAmountUnit: next as UnitRef,
																				}),
																			)
																		}
																	/>
																</div>
															</div>
															{canSeeCost ? (
																<TextField
																	label={<Trans>Latest price</Trans>}
																	value={item.priceText}
																	onChange={(event) =>
																		patchItem(
																			supplier.tempKey,
																			item.tempKey,
																			(current) => ({
																				...current,
																				priceText: event.target.value,
																			}),
																		)
																	}
																	inputMode="decimal"
																	dir="ltr"
																/>
															) : null}
														</div>
													</div>
												) : null}
											</li>
										)
									})}
								</ul>
							) : null}
						</div>
					)
				})}
			</div>

			<div className="flex justify-end gap-2 pt-2">
				<Button
					type="button"
					variant="outline"
					onClick={() => setActiveImport(null)}
					disabled={applying}
				>
					<Trans>Back</Trans>
				</Button>
				<Button
					type="button"
					disabled={applying || totalIncluded === 0}
					onClick={() => void applyImport()}
					data-testid="setup-import-apply"
				>
					{applying ? (
						<Trans>Creating…</Trans>
					) : (
						<Plural
							value={totalIncluded}
							one="Create # item"
							other="Create # items"
						/>
					)}
				</Button>
			</div>
		</div>
	)
}
