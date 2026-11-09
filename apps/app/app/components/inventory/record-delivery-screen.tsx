import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_CATEGORIES,
	itemDetailSchema,
	listSuppliersResultSchema,
	recordDeliveryResultSchema,
	standardUnitsFor,
	type StockItem,
	stockItemSchema,
	supplierDetailSchema,
	type UnitRef,
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
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import {
	type FormEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { ItemPicker } from '#app/components/inventory/item-picker.tsx'
import { MenuFormHeader } from '#app/components/menu/menu-form-header.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import {
	buildInlineItemPayload,
	buildRecordDelivery,
	computeLine,
	type DeliveryDraft,
	type DeliveryLineDraft,
	type DeliveryProblems,
	deliveryTotals,
	defaultPackChoice,
	newLineDraft,
	type PackChoice,
	packChoicesFor,
	reconcilePack,
	visiblePriceChangeBp,
	withPack,
} from '#app/utils/inventory/delivery-form.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	MEASURED_IN,
	type MeasuredIn,
	defaultMeasureUnit,
} from '#app/utils/inventory/item-form.ts'
import { categoryLabel } from '#app/utils/inventory/labels.ts'
import { inventoryTabPath } from '#app/utils/inventory/nav.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'
import { minorToMajorText } from '#app/utils/money-input.ts'

type ItemMeta = { countUnit: UnitRef | null; units: StockItem['units'] }

function today(): string {
	const now = new Date()
	const month = String(now.getMonth() + 1).padStart(2, '0')
	const day = String(now.getDate()).padStart(2, '0')
	return `${now.getFullYear()}-${month}-${day}`
}

/**
 * Record a delivery: the supplier, the lines (packs times pack size, or the
 * real weight for goods priced by weight), and the invoice's own numbers
 * (VAT apart from prices, a total to check the lines against). Saving puts
 * the stock in, updates last prices, and says which prices moved. It needs
 * the prices on the invoice, so it needs the cost grant.
 */
export function RecordDeliveryScreen({
	orgSlug,
	locationId,
	currency,
	dataRegion,
	canEdit,
	canSeeCost,
	canManagePurchasing,
	search,
}: {
	orgSlug: string
	locationId: string
	currency: string
	dataRegion: 'us' | 'ksa'
	canEdit: boolean
	canSeeCost: boolean
	canManagePurchasing: boolean
	search: string
}) {
	const { t, i18n } = useLingui()
	const navigate = useNavigate()
	const client = useInventoryClient()
	const { request } = client
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const idPrefix = useId()
	const backHref = `${inventoryTabPath(orgSlug, 'purchasing')}${search}`

	const [draft, setDraft] = useState<DeliveryDraft>({
		supplierId: '',
		invoiceNumber: '',
		invoiceDate: today(),
		vatText: '',
		invoiceTotalText: '',
		zatcaReference: '',
		paid: false,
		lines: [],
	})
	const [meta, setMeta] = useState<Record<string, ItemMeta>>({})
	const [attempted, setAttempted] = useState(false)
	const [problems, setProblems] = useState<DeliveryProblems | null>(null)
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [newItemOpen, setNewItemOpen] = useState(false)
	const clientIdRef = useRef(newClientId('d'))
	const lineCounter = useRef(0)

	const suppliers = useInventoryQuery('/suppliers', listSuppliersResultSchema)
	const supplierDetail = useInventoryQuery(
		draft.supplierId
			? `/suppliers/${encodeURIComponent(draft.supplierId)}`
			: null,
		supplierDetailSchema,
	)
	const products = useMemo(
		() =>
			draft.supplierId && supplierDetail.data?.id === draft.supplierId
				? supplierDetail.data.products
				: [],
		[draft.supplierId, supplierDetail.data],
	)

	const unitLabel = (unit: UnitRef) => quantity.unitName(unit, [])
	function choicesFor(line: DeliveryLineDraft): PackChoice[] {
		const itemMeta = meta[line.itemId]
		return packChoicesFor({
			baseUnit: line.baseUnit,
			units: itemMeta?.units ?? [],
			products: products.filter((product) => product.itemId === line.itemId),
			system: quantity.system,
			unitLabel,
		})
	}

	// When the supplier's packs arrive (or the supplier changes), lines move to
	// a pack that is still offered and take the supplier's remembered price.
	const supplierKey = draft.supplierId
	const loadedFor = supplierDetail.data?.id ?? ''
	useEffect(() => {
		if (supplierKey && loadedFor !== supplierKey) return
		setDraft((current) => ({
			...current,
			lines: current.lines.map((line) =>
				reconcilePack(
					line,
					choicesFor(line),
					meta[line.itemId]?.countUnit ?? null,
					currency,
				),
			),
		}))
		// `choicesFor` closes over the same inputs as these dependencies.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [supplierKey, loadedFor, products])

	function patch(update: Partial<DeliveryDraft>) {
		setDraft((current) => ({ ...current, ...update }))
	}

	function patchLine(
		key: string,
		update: (line: DeliveryLineDraft) => DeliveryLineDraft,
	) {
		setDraft((current) => ({
			...current,
			lines: current.lines.map((line) =>
				line.key === key ? update(line) : line,
			),
		}))
	}

	function addItem(item: StockItem) {
		lineCounter.current += 1
		const key = `line-${lineCounter.current}`
		const itemMeta: ItemMeta = { countUnit: item.countUnit, units: item.units }
		const choices = packChoicesFor({
			baseUnit: item.baseUnit,
			units: item.units,
			products: products.filter((product) => product.itemId === item.id),
			system: quantity.system,
			unitLabel,
		})
		const pack = defaultPackChoice(choices, item.countUnit)
		if (!pack) return
		setMeta((current) => ({ ...current, [item.id]: itemMeta }))
		setDraft((current) => ({
			...current,
			lines: [
				...current.lines,
				newLineDraft({
					key,
					itemId: item.id,
					itemName: item.name,
					baseUnit: item.baseUnit,
					pack,
					currency,
					system: quantity.system,
					previousCostMicro: item.costMicro ?? null,
				}),
			],
		}))
		// The item's last delivered price is what a price move is measured from.
		void request(
			`/items/${encodeURIComponent(item.id)}?locationId=${encodeURIComponent(locationId)}`,
		).then(
			(body) => {
				const parsed = itemDetailSchema.safeParse(body)
				const last = parsed.success ? parsed.data.cost?.lastCostMicro : null
				if (last !== null && last !== undefined) {
					patchLine(key, (line) => ({ ...line, previousCostMicro: last }))
				}
			},
			() => {},
		)
	}

	const computed = draft.lines.map((line) => computeLine(line, currency))
	const totals = deliveryTotals(computed, {
		vatText: draft.vatText,
		invoiceTotalText: draft.invoiceTotalText,
		currency,
	})
	const money = (minor: number) => formatMoney(minor, currency, i18n.locale)
	const gapText =
		totals.differenceMinor === null
			? ''
			: money(Math.abs(totals.differenceMinor))
	const percent = (bp: number) =>
		new Intl.NumberFormat(i18n.locale, {
			style: 'percent',
			maximumFractionDigits: 1,
			signDisplay: 'exceptZero',
		}).format(bp / 10_000)

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (submitting) return
		setAttempted(true)
		setError(null)
		const built = buildRecordDelivery(draft, {
			clientId: clientIdRef.current,
			locationId,
			currency,
		})
		if (!built.ok) {
			setProblems(built.problems)
			return
		}
		setProblems(null)
		setSubmitting(true)
		try {
			const result = recordDeliveryResultSchema.parse(
				await request('/deliveries', {
					method: 'POST',
					body: JSON.stringify(built.payload),
				}),
			)
			clientIdRef.current = newClientId('d')
			notifyChanged()
			const moved = result.priceChanges?.length ?? 0
			toast.success(t`Delivery recorded.`, {
				description:
					moved > 0
						? plural(moved, {
								one: 'Prices updated for # item',
								other: 'Prices updated for # items',
							})
						: undefined,
			})
			void navigate(backHref)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setSubmitting(false)
		}
	}

	if (!canEdit || !canSeeCost) {
		return (
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
				<Alert data-testid="delivery-needs-cost">
					<AlertDescription>
						{!canEdit ? (
							<Trans>You can look at deliveries but not record them.</Trans>
						) : (
							<Trans>
								Recording a delivery needs the prices on the invoice, so it
								needs access to costs. Ask an owner to check your role.
							</Trans>
						)}
					</AlertDescription>
				</Alert>
				<Button
					variant="outline"
					className="self-start"
					onClick={() => void navigate(backHref)}
				>
					<Trans>Back to purchasing</Trans>
				</Button>
			</div>
		)
	}

	const headerProblem = (field: DeliveryProblems['header'][number]) =>
		attempted && problems?.header.includes(field)
	const supplierRows =
		suppliers.data?.suppliers.filter((row) => !row.archived) ?? []
	const moved = computed
		.map((line, index) => ({
			line: draft.lines[index]!,
			bp: visiblePriceChangeBp(line.changeBp),
		}))
		.filter((entry) => entry.bp !== null)

	return (
		<form
			onSubmit={(event) => void submit(event)}
			noValidate
			className="flex flex-1 flex-col"
			data-testid="record-delivery"
		>
			<MenuFormHeader
				pageTitle={t`Record delivery`}
				backHref={backHref}
				backLabel={t`Back to purchasing`}
				saveButtonText={t`Save delivery`}
				isSubmitting={submitting}
			/>

			<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 lg:px-8">
				<div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
					<div className="flex flex-col gap-6 lg:col-span-8">
						{error ? (
							<Alert variant="destructive" data-testid="delivery-form-error">
								<Icon name="alert-triangle" />
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						{attempted && problems ? (
							<Alert variant="destructive" data-testid="delivery-form-problems">
								<Icon name="alert-triangle" />
								<AlertDescription>
									<Trans>Some fields need a look. They are marked below.</Trans>
								</AlertDescription>
							</Alert>
						) : null}

						<Frame>
							<FrameHeader>
								<FrameTitle className="text-base">
									<Trans>Supplier</Trans>
								</FrameTitle>
								<FrameDescription>
									<Trans>
										Who delivered. Their packs and prices fill in the lines.
									</Trans>
								</FrameDescription>
							</FrameHeader>
							<FramePanel>
								<SelectField
									label={<Trans>Supplier</Trans>}
									id={`${idPrefix}-supplier`}
									testId="delivery-supplier"
									options={[
										{ value: '', label: t`No supplier` },
										...supplierRows.map((row) => ({
											value: row.id,
											label: row.name,
										})),
									]}
									value={draft.supplierId}
									onValueChange={(next) => patch({ supplierId: next })}
								/>
							</FramePanel>
						</Frame>

						<Frame>
							<FrameHeader>
								<FrameTitle className="text-base">
									<Trans>What arrived</Trans>
								</FrameTitle>
								<FrameDescription>
									<Trans>
										Search your items and enter how many packs came and what
										each cost, before VAT.
									</Trans>
								</FrameDescription>
							</FrameHeader>
							<FramePanel className="flex flex-col gap-4">
								<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
									<div className="min-w-0 flex-1">
										<ItemPicker
											id={`${idPrefix}-add-item`}
											label={<Trans>Add an item</Trans>}
											client={client}
											locationId={locationId}
											value={null}
											onChange={addItem}
											placeholder={t`Search your items`}
											testId="delivery-add-item"
										/>
									</div>
									<Button
										type="button"
										variant="outline"
										onClick={() => setNewItemOpen(true)}
										data-testid="delivery-new-item"
									>
										<Icon name="plus" />
										<Trans>New item</Trans>
									</Button>
								</div>

								{headerProblem('lines') ? (
									<p className="text-destructive text-sm" role="alert">
										<Trans>Add at least one item.</Trans>
									</p>
								) : null}

								{draft.lines.length === 0 ? (
									<p
										className="text-muted-foreground text-sm"
										data-testid="delivery-no-lines"
									>
										<Trans>
											No items yet. Search above, or add one that is not in
											Stock yet.
										</Trans>
									</p>
								) : (
									<ul
										className="flex flex-col gap-3"
										data-testid="delivery-lines"
									>
										{draft.lines.map((line, index) => (
											<DeliveryLine
												key={line.key}
												line={line}
												computedLine={computed[index]!}
												choices={choicesFor(line)}
												currency={currency}
												problems={
													attempted ? (problems?.lines[line.key] ?? []) : []
												}
												onChange={(update) => patchLine(line.key, update)}
												onRemove={() =>
													setDraft((current) => ({
														...current,
														lines: current.lines.filter(
															(entry) => entry.key !== line.key,
														),
													}))
												}
												moneyText={money}
												percentText={percent}
											/>
										))}
									</ul>
								)}
							</FramePanel>
						</Frame>

						<Frame>
							<FrameHeader>
								<FrameTitle className="text-base">
									<Trans>Invoice</Trans>
								</FrameTitle>
								<FrameDescription>
									<Trans>
										From the paper invoice. VAT is kept apart from prices.
									</Trans>
								</FrameDescription>
							</FrameHeader>
							<FramePanel className="flex flex-col gap-4">
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
									<TextField
										label={<Trans>Invoice number</Trans>}
										optional
										value={draft.invoiceNumber}
										onChange={(event) =>
											patch({ invoiceNumber: event.target.value })
										}
										error={
											headerProblem('invoiceNumber')
												? t`Keep the invoice number under 60 characters.`
												: null
										}
										maxLength={60}
										dir="ltr"
										data-testid="delivery-invoice-number"
									/>
									<TextField
										label={<Trans>Invoice date</Trans>}
										optional
										type="date"
										value={draft.invoiceDate}
										onChange={(event) =>
											patch({ invoiceDate: event.target.value })
										}
										error={
											headerProblem('invoiceDate')
												? t`Choose the date on the invoice.`
												: null
										}
										dir="ltr"
										data-testid="delivery-invoice-date"
									/>
									<TextField
										label={<Trans>VAT ({currency})</Trans>}
										optional
										value={draft.vatText}
										onChange={(event) => patch({ vatText: event.target.value })}
										error={
											headerProblem('vat')
												? t`Enter the VAT amount, for example 106.80.`
												: null
										}
										inputMode="decimal"
										dir="ltr"
										data-testid="delivery-vat"
									/>
									<TextField
										label={<Trans>Invoice total ({currency})</Trans>}
										optional
										value={draft.invoiceTotalText}
										onChange={(event) =>
											patch({ invoiceTotalText: event.target.value })
										}
										error={
											headerProblem('invoiceTotal')
												? t`Enter the total on the invoice, for example 818.80.`
												: null
										}
										inputMode="decimal"
										hint={<Trans>The grand total, VAT included.</Trans>}
										dir="ltr"
										data-testid="delivery-invoice-total"
									/>
								</div>
								{dataRegion === 'ksa' ? (
									<TextField
										label={<Trans>ZATCA invoice reference</Trans>}
										optional
										value={draft.zatcaReference}
										onChange={(event) =>
											patch({ zatcaReference: event.target.value })
										}
										error={
											headerProblem('zatcaReference')
												? t`Keep the reference under 200 characters.`
												: null
										}
										maxLength={200}
										dir="ltr"
										hint={
											<Trans>
												The supplier's e-invoice number or the text of its QR
												code.
											</Trans>
										}
										data-testid="delivery-zatca"
									/>
								) : null}
								<div className="flex items-center gap-2">
									<Checkbox
										id={`${idPrefix}-paid`}
										checked={draft.paid}
										disabled={!canManagePurchasing}
										onCheckedChange={(next) => patch({ paid: next })}
										data-testid="delivery-paid"
									/>
									<Label
										htmlFor={`${idPrefix}-paid`}
										className="cursor-pointer font-normal"
									>
										<Trans>Already paid</Trans>
									</Label>
								</div>
								{!canManagePurchasing ? (
									<p className="text-muted-foreground text-xs">
										<Trans>
											Marking a delivery paid needs the purchasing role, so it
											is saved as unpaid.
										</Trans>
									</p>
								) : null}
							</FramePanel>
						</Frame>
					</div>

					<aside className="lg:col-span-4">
						<div className="flex flex-col gap-4 lg:sticky lg:top-24">
							<Frame>
								<FrameHeader>
									<FrameTitle className="text-base">
										<Trans>Check against the invoice</Trans>
									</FrameTitle>
								</FrameHeader>
								<FramePanel>
									<dl
										className="flex flex-col gap-2 text-sm"
										data-testid="delivery-summary"
									>
										<div className="flex justify-between gap-3">
											<dt className="text-muted-foreground">
												<Trans>Lines</Trans>
											</dt>
											<dd
												className="tabular-nums"
												data-testid="delivery-lines-total"
											>
												<bdi dir="ltr">{money(totals.linesMinor)}</bdi>
											</dd>
										</div>
										{totals.vatMinor !== null ? (
											<div className="flex justify-between gap-3">
												<dt className="text-muted-foreground">
													<Trans>VAT</Trans>
												</dt>
												<dd className="tabular-nums">
													<bdi dir="ltr">{money(totals.vatMinor)}</bdi>
												</dd>
											</div>
										) : null}
										{totals.invoiceMinor !== null ? (
											<div className="flex justify-between gap-3">
												<dt className="text-muted-foreground">
													<Trans>Invoice</Trans>
												</dt>
												<dd className="tabular-nums">
													<bdi dir="ltr">{money(totals.invoiceMinor)}</bdi>
												</dd>
											</div>
										) : null}
									</dl>
									{totals.state === 'apart' &&
									totals.differenceMinor !== null ? (
										<p
											className="text-warning mt-3 text-sm"
											data-testid="delivery-total-check"
											data-state="apart"
										>
											<Trans>
												<bdi dir="ltr">{gapText}</bdi> apart from the invoice.
												Check the lines.
											</Trans>
										</p>
									) : totals.state === 'match' ? (
										<p
											className="text-success mt-3 flex items-center gap-1 text-sm"
											data-testid="delivery-total-check"
											data-state="match"
										>
											<Icon name="check" className="size-4" />
											<Trans>Matches the invoice.</Trans>
										</p>
									) : null}
								</FramePanel>
							</Frame>

							{moved.length > 0 ? (
								<Frame>
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Prices that moved</Trans>
										</FrameTitle>
									</FrameHeader>
									<FramePanel>
										<ul
											className="flex flex-col gap-1 text-sm"
											data-testid="delivery-price-moves"
										>
											{moved.map(({ line, bp }) => (
												<li
													key={line.key}
													className="flex justify-between gap-3"
												>
													<span className="min-w-0 wrap-anywhere">
														{line.itemName}
													</span>
													<bdi
														dir="ltr"
														className={
															(bp ?? 0) > 0 ? 'text-warning' : 'text-success'
														}
													>
														{percent(bp ?? 0)}
													</bdi>
												</li>
											))}
										</ul>
									</FramePanel>
								</Frame>
							) : null}
						</div>
					</aside>
				</div>
			</div>

			<NewItemDialog
				open={newItemOpen}
				onOpenChange={setNewItemOpen}
				locationId={locationId}
				onCreated={(item) => {
					setNewItemOpen(false)
					addItem(item)
				}}
			/>
		</form>
	)
}

function DeliveryLine({
	line,
	computedLine,
	choices,
	currency,
	problems,
	onChange,
	onRemove,
	moneyText,
	percentText,
}: {
	line: DeliveryLineDraft
	computedLine: ReturnType<typeof computeLine>
	choices: readonly PackChoice[]
	currency: string
	problems: readonly string[]
	onChange: (update: (line: DeliveryLineDraft) => DeliveryLineDraft) => void
	onRemove: () => void
	moneyText: (minor: number) => string
	percentText: (bp: number) => string
}) {
	const { t } = useLingui()
	const quantity = useQuantityFormat()
	const packName = line.pack.name
	const change = visiblePriceChangeBp(computedLine.changeBp)
	const itemName = line.itemName
	const weightUnits = standardUnitsFor(line.baseUnit, quantity.system)
	const computedTotal =
		line.totalText === '' && computedLine.lineTotalMinor !== null
			? minorToMajorText(computedLine.lineTotalMinor, currency)
			: ''

	return (
		<li
			className="bg-card flex flex-col gap-3 rounded-xl border p-3"
			data-testid={`delivery-line-${line.key}`}
		>
			<div className="flex items-start justify-between gap-2">
				<span className="font-medium wrap-anywhere">{line.itemName}</span>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-11 shrink-0 md:size-8"
					aria-label={t`Remove ${itemName}`}
					onClick={onRemove}
					data-testid={`delivery-line-remove-${line.key}`}
				>
					<Icon name="x" />
				</Button>
			</div>

			{choices.length > 1 ? (
				<SelectField
					label={<Trans>Bought as</Trans>}
					testId={`delivery-line-pack-${line.key}`}
					options={choices.map((choice) => ({
						value: choice.id,
						label: choice.name,
					}))}
					value={line.pack.id}
					onValueChange={(next) => {
						const choice = choices.find((entry) => entry.id === next)
						if (choice)
							onChange((current) => withPack(current, choice, currency))
					}}
				/>
			) : null}

			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<TextField
					label={<Trans>How many {packName}</Trans>}
					optional={line.pack.pricedByWeight}
					value={line.packsText}
					onChange={(event) =>
						onChange((current) => ({
							...current,
							packsText: event.target.value,
						}))
					}
					error={
						problems.includes('packs') ? t`Enter a number above zero.` : null
					}
					inputMode="decimal"
					dir="ltr"
					data-testid={`delivery-line-packs-${line.key}`}
				/>
				<TextField
					label={
						<Trans>
							Price of one {packName} ({currency})
						</Trans>
					}
					value={line.priceText}
					onChange={(event) =>
						onChange((current) => ({
							...current,
							priceText: event.target.value,
						}))
					}
					error={
						problems.includes('price')
							? t`Enter the price on the invoice, for example 28.50.`
							: null
					}
					inputMode="decimal"
					dir="ltr"
					data-testid={`delivery-line-price-${line.key}`}
				/>
			</div>

			{line.pack.pricedByWeight ? (
				<div className="flex flex-col gap-2">
					<TextField
						label={<Trans>Real weight on the invoice</Trans>}
						value={line.weightText}
						onChange={(event) =>
							onChange((current) => ({
								...current,
								weightText: event.target.value,
							}))
						}
						error={
							problems.includes('weight')
								? t`Enter the weight on the invoice.`
								: null
						}
						inputMode="decimal"
						dir="ltr"
						data-testid={`delivery-line-weight-${line.key}`}
					/>
					<ToggleGroup
						aria-label={t`Unit of the weight`}
						variant="segmented"
						value={[line.weightUnit]}
						onValueChange={(next) => {
							if (next[0]) {
								onChange((current) => ({
									...current,
									weightUnit: next[0] as UnitRef,
								}))
							}
						}}
						className="flex-wrap"
					>
						{weightUnits.map((unit) => (
							<ToggleGroupItem
								key={unit}
								value={unit}
								className="h-11 min-w-11 md:h-7"
							>
								<bdi dir="ltr">{quantity.unitName(unit, [])}</bdi>
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</div>
			) : null}

			<TextField
				label={<Trans>Line total on the invoice ({currency})</Trans>}
				optional
				value={line.totalText}
				placeholder={computedTotal}
				onChange={(event) =>
					onChange((current) => ({ ...current, totalText: event.target.value }))
				}
				error={
					problems.includes('total')
						? t`Enter the line total above zero.`
						: null
				}
				hint={<Trans>Only if it differs from packs times price.</Trans>}
				inputMode="decimal"
				dir="ltr"
				data-testid={`delivery-line-total-${line.key}`}
			/>

			{computedLine.quantity !== null &&
			computedLine.lineTotalMinor !== null ? (
				<p className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
					<bdi dir="ltr">
						{quantity.format(computedLine.quantity, {
							baseUnit: line.baseUnit,
						})}
					</bdi>
					<span aria-hidden>·</span>
					<bdi dir="ltr">{moneyText(computedLine.lineTotalMinor)}</bdi>
					{change !== null ? (
						<Badge
							variant={change > 0 ? 'warning' : 'success'}
							data-testid={`delivery-line-change-${line.key}`}
						>
							<bdi dir="ltr">{percentText(change)}</bdi>{' '}
							<Trans>vs last price</Trans>
						</Badge>
					) : null}
				</p>
			) : null}
		</li>
	)
}

/** A minimal inline item for something that is not in Stock yet: a name, what it is measured in, a category. */
function NewItemDialog({
	open,
	onOpenChange,
	locationId,
	onCreated,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	locationId: string
	onCreated: (item: StockItem) => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const [name, setName] = useState('')
	const [measuredIn, setMeasuredIn] = useState<MeasuredIn>('weight')
	const [category, setCategory] = useState<string>('other')
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [nameProblem, setNameProblem] = useState(false)
	const clientIdRef = useRef(newClientId('i'))

	async function create() {
		if (pending) return
		const trimmed = name.trim()
		if (trimmed === '' || trimmed.length > 80) {
			setNameProblem(true)
			return
		}
		setPending(true)
		setError(null)
		try {
			const payload = buildInlineItemPayload({
				clientId: clientIdRef.current,
				name: trimmed,
				measuredIn,
				category,
				locationId,
				system: quantity.system,
			})
			const created = stockItemSchema.parse(
				await request('/items', {
					method: 'POST',
					body: JSON.stringify(payload),
				}),
			)
			clientIdRef.current = newClientId('i')
			notifyChanged()
			setName('')
			onCreated(created)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(false)
		}
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
			<DialogContent
				className="sm:max-w-md"
				data-testid="delivery-new-item-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>New item</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Add an item that is not in Stock yet. You can fill in the rest
							later.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<div className="flex flex-col gap-4">
					<TextField
						label={<Trans>Name</Trans>}
						value={name}
						onChange={(event) => {
							setName(event.target.value)
							setNameProblem(false)
						}}
						error={nameProblem ? t`Enter a name.` : null}
						maxLength={80}
						dir="auto"
						autoComplete="off"
						data-testid="delivery-new-item-name"
					/>
					<SelectField
						label={<Trans>Category</Trans>}
						options={INVENTORY_CATEGORIES.map((value) => ({
							value,
							label: categoryLabel(value, i18n),
						}))}
						value={category}
						onValueChange={setCategory}
					/>
					<div className="flex flex-col gap-2">
						<span className="text-sm font-medium">
							<Trans>Measured in</Trans>
						</span>
						<ToggleGroup
							aria-label={t`Measured in`}
							variant="segmented"
							value={[measuredIn]}
							onValueChange={(next) => {
								if (next[0]) setMeasuredIn(next[0] as MeasuredIn)
							}}
						>
							{MEASURED_IN.map((value) => (
								<ToggleGroupItem
									key={value}
									value={value}
									className="h-11 min-w-11 md:h-7"
									data-testid={`delivery-new-item-${value}`}
								>
									<bdi dir="ltr">
										{quantity.unitName(
											defaultMeasureUnit(value, quantity.system),
											[],
										)}
									</bdi>
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</div>
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
						onClick={() => void create()}
						disabled={pending}
						data-testid="delivery-new-item-submit"
					>
						{pending ? <Trans>Adding…</Trans> : <Trans>Add item</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
