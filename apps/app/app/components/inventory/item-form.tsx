import { getFormProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod/v4'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	INVENTORY_CATEGORIES,
	type ItemDetail,
	listSuppliersResultSchema,
	standardUnitsFor,
	type StorageArea,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { type FormEvent, useId, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { type z } from 'zod'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { SheetForm } from '#app/components/staff/sheet-frame.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	baseUnitFor,
	buildCreateItemPayload,
	buildUpdatePayloads,
	countUnitChoices,
	CUSTOM_CATEGORY_KEY,
	defaultMeasureUnit,
	emptyItemFormValues,
	itemFormSchema,
	type ItemFormValues,
	itemFormValuesFromDetail,
	MEASURED_IN,
	type MeasuredIn,
	PACK_COUNT_UNIT,
	splitAreaIds,
} from '#app/utils/inventory/item-form.ts'
import { categoryLabel } from '#app/utils/inventory/labels.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'
import { currencyExponent } from '#app/utils/money-input.ts'

/**
 * Add or edit one item, as the plan's progressive questions: name and
 * category are required, everything else is optional and adds one more
 * answer (a pack and its price, how you count it, where it is kept, when to
 * order). Edit leaves out the pack and price: those live in Purchasing.
 */
export function ItemForm({
	mode,
	item,
	locationId,
	areas,
	currency,
	canManagePurchasing,
	basePath,
	search,
	onSaved,
	onCancel,
}: {
	mode: 'create' | 'edit'
	/** Required when editing. */
	item?: ItemDetail
	locationId: string
	areas: readonly StorageArea[]
	currency: string
	canManagePurchasing: boolean
	basePath: string
	search: string
	onSaved: () => void
	onCancel: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const system = quantity.system
	const notifyChanged = useNotifyInventoryChanged()
	const idPrefix = useId()

	const initial = useMemo<ItemFormValues>(
		() =>
			mode === 'edit' && item
				? itemFormValuesFromDetail(item, locationId, system)
				: emptyItemFormValues(system),
		[mode, item, locationId, system],
	)

	const [measuredIn, setMeasuredIn] = useState<MeasuredIn>(initial.measuredIn)
	const [categoryKey, setCategoryKey] = useState(initial.categoryKey)
	const [packSizeUnit, setPackSizeUnit] = useState(initial.packSizeUnit)
	const [supplierId, setSupplierId] = useState(initial.supplierId)
	const [pricedByWeight, setPricedByWeight] = useState(initial.pricedByWeight)
	const [countUnit, setCountUnit] = useState(initial.countUnit)
	const [areaIds, setAreaIds] = useState<string[]>(initial.areaIds)
	const [packNameText, setPackNameText] = useState(initial.packName)
	const [packSizeText, setPackSizeText] = useState(initial.packSize)
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState(false)
	// A retry after a lost answer replays the same create, never a second one.
	const clientIdRef = useRef(newClientId('i'))
	// An edit that saved the item but failed on the place does not send the
	// item again (its version has moved on).
	const itemSavedRef = useRef(false)

	const suppliersEnabled = mode === 'create' && canManagePurchasing
	const suppliers = useInventoryQuery(
		suppliersEnabled ? '/suppliers' : null,
		listSuppliersResultSchema,
	)
	const supplierRows =
		suppliers.data?.suppliers.filter((row) => !row.archived) ?? []

	const hasMovements = mode === 'edit' && item?.hasMovements === true
	const baseUnit =
		hasMovements && item ? item.baseUnit : baseUnitFor(measuredIn)
	const itemUnits = useMemo(
		() => (mode === 'edit' && item ? item.units : []),
		[mode, item],
	)

	const hasPack = packNameText.trim() !== '' && packSizeText.trim() !== ''
	const countChoices = useMemo(() => {
		if (mode === 'edit') return countUnitChoices(baseUnit, itemUnits, system)
		const standard: string[] = standardUnitsFor(baseUnit, system)
		return hasPack ? [...standard, PACK_COUNT_UNIT] : standard
	}, [mode, baseUnit, itemUnits, system, hasPack])
	const activeCountUnit = countChoices.includes(countUnit)
		? countUnit
		: (defaultMeasureUnit(measuredIn, system) as string)

	function unitLabel(unit: string): string {
		if (unit === PACK_COUNT_UNIT) return packNameText.trim() || t`Pack`
		return quantity.unitName(unit, itemUnits)
	}

	const messages = useMemo(
		() => ({
			nameRequired: t`Enter a name.`,
			nameTooLong: t`Keep the name under 80 characters.`,
			nameInvalid: t`Remove the special characters from the name.`,
			categoryRequired: t`Choose a category.`,
			customCategoryRequired: t`Type the category name.`,
			customCategoryTooLong: t`Keep the category under 40 characters.`,
			packNameRequired: t`Name the pack, for example Box or Case.`,
			packNameTooLong: t`Keep the pack name under 40 characters.`,
			packSizeInvalid: t`Enter how much one pack holds, above zero.`,
			supplierRequired: t`Choose who you buy it from, or clear the price.`,
			priceInvalid: t`Enter the price of one pack, for example 28.50.`,
			levelInvalid: t`Enter a number, for example 8 or 2.5.`,
			fillBelowOrder: t`Fill up to must be at least the amount to order at.`,
		}),
		[t],
	)
	const schema = useMemo(
		() => itemFormSchema(messages, { currency, mode }),
		[messages, currency, mode],
	)

	const [form, fields] = useForm({
		id: `inventory-item-form-${mode}`,
		defaultValue: {
			name: initial.name,
			customCategory: initial.customCategory,
			packName: initial.packName,
			packSize: initial.packSize,
			price: initial.price,
			orderBelow: initial.orderBelow,
			fillUpTo: initial.fillUpTo,
		},
		onValidate({ formData }) {
			return parseWithZod(formData, { schema })
		},
		shouldValidate: 'onBlur',
		shouldRevalidate: 'onInput',
		onSubmit(event, { submission }) {
			event.preventDefault()
			if (submission?.status !== 'success' || pending) return
			void save(submission.value)
		},
	})

	async function save(parsed: z.infer<typeof schema>) {
		setPending(true)
		setError(null)
		try {
			if (mode === 'create') {
				const payload = buildCreateItemPayload(parsed, {
					clientId: clientIdRef.current,
					locationId,
					currency,
					system,
					canManagePurchasing,
				})
				await request('/items', {
					method: 'POST',
					body: JSON.stringify(payload),
				})
				clientIdRef.current = newClientId('i')
				const addedName = payload.name
				toast.success(t`${addedName} added.`)
			} else if (item) {
				const place = item.places.find(
					(entry) => entry.locationId === locationId,
				)
				const payloads = buildUpdatePayloads(
					parsed,
					item,
					place ?? { version: 0 },
					system,
				)
				const itemChanged =
					parsed.name !== initial.name ||
					categoryChanged(parsed, initial) ||
					payloads.item.baseUnit !== undefined
				if (itemChanged && !itemSavedRef.current) {
					await request(`/items/${encodeURIComponent(item.id)}`, {
						method: 'PATCH',
						body: JSON.stringify(payloads.item),
					})
					itemSavedRef.current = true
				}
				if (payloads.place && placeChanged(parsed, initial)) {
					await request(
						`/items/${encodeURIComponent(item.id)}/places/${encodeURIComponent(locationId)}`,
						{ method: 'PUT', body: JSON.stringify(payloads.place) },
					)
				}
				const savedName = parsed.name
				toast.success(t`${savedName} saved.`)
			}
			notifyChanged()
			onSaved()
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(false)
		}
	}

	const categoryOptions = [
		...INVENTORY_CATEGORIES.map((value) => ({
			value,
			label: categoryLabel(value, i18n),
		})),
		{ value: CUSTOM_CATEGORY_KEY, label: t`Type your own…` },
	]
	const measuredInOptions = MEASURED_IN.map((value) => ({
		value,
		label: quantity.unitName(defaultMeasureUnit(value, system), []),
	}))
	const exponent = currencyExponent(currency)
	const noAreasYet = areas.length === 0

	return (
		<SheetForm
			id={form.id}
			title={mode === 'create' ? t`Add item` : t`Edit item`}
			description={
				mode === 'create'
					? t`Only the name and category are needed. Everything else can wait.`
					: undefined
			}
			onSubmit={(event: FormEvent<HTMLFormElement>) => {
				getFormProps(form).onSubmit?.(event)
			}}
			footer={
				<>
					<Button
						type="button"
						variant="outline"
						onClick={onCancel}
						disabled={pending}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="submit"
						disabled={pending}
						data-testid="item-form-submit"
					>
						{pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
					</Button>
				</>
			}
		>
			{/* The sheet's form carries the submit; Conform's props sit on it too. */}
			<input type="hidden" name="measuredIn" value={measuredIn} />
			<input type="hidden" name="categoryKey" value={categoryKey} />
			<input type="hidden" name="packSizeUnit" value={packSizeUnit} />
			<input type="hidden" name="supplierId" value={supplierId} />
			<input type="hidden" name="countUnit" value={activeCountUnit} />
			<input type="hidden" name="areaIds" value={areaIds.join(',')} />
			{pricedByWeight ? (
				<input type="hidden" name="pricedByWeight" value="on" />
			) : null}

			{error ? (
				<Alert variant="destructive" data-testid="item-form-error">
					<Icon name="alert-triangle" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			<TextField
				label={<Trans>Name</Trans>}
				name={fields.name.name}
				id={`${idPrefix}-name`}
				defaultValue={initial.name}
				error={fields.name.errors?.[0] ?? null}
				maxLength={80}
				dir="auto"
				autoComplete="off"
				data-testid="item-form-name"
			/>

			<div className="flex flex-col gap-3">
				<SelectField
					label={<Trans>Category</Trans>}
					id={`${idPrefix}-category`}
					testId="item-form-category"
					options={categoryOptions}
					value={categoryKey}
					onValueChange={setCategoryKey}
					placeholder={t`Choose a category`}
					error={
						categoryKey === '' ? (fields.categoryKey.errors?.[0] ?? null) : null
					}
				/>
				{categoryKey === CUSTOM_CATEGORY_KEY ? (
					<TextField
						label={<Trans>Category name</Trans>}
						name={fields.customCategory.name}
						defaultValue={initial.customCategory}
						error={fields.customCategory.errors?.[0] ?? null}
						maxLength={40}
						dir="auto"
						data-testid="item-form-custom-category"
					/>
				) : null}
			</div>

			<Field>
				<FieldLabel id={`${idPrefix}-measured`}>
					<Trans>Measured in</Trans>
				</FieldLabel>
				<ToggleGroup
					aria-labelledby={`${idPrefix}-measured`}
					variant="segmented"
					value={[measuredIn]}
					disabled={hasMovements}
					onValueChange={(next) => {
						const picked = next[0] as MeasuredIn | undefined
						if (!picked) return
						setMeasuredIn(picked)
						const unit = defaultMeasureUnit(picked, system)
						setPackSizeUnit(unit)
						setCountUnit(unit)
					}}
				>
					{measuredInOptions.map((option) => (
						<ToggleGroupItem
							key={option.value}
							value={option.value}
							className="h-11 min-w-11 md:h-7"
							data-testid={`item-form-measured-${option.value}`}
						>
							<bdi dir="ltr">{option.label}</bdi>
						</ToggleGroupItem>
					))}
				</ToggleGroup>
				{hasMovements ? (
					<FieldDescription>
						<Trans>This cannot change once stock has moved.</Trans>
					</FieldDescription>
				) : null}
			</Field>

			{mode === 'create' ? (
				<fieldset className="flex flex-col gap-3">
					<legend className="mb-1 text-sm font-medium">
						<Trans>How you buy it</Trans>{' '}
						<span className="text-muted-foreground font-normal">
							<Trans>(optional)</Trans>
						</span>
					</legend>
					<div className="grid grid-cols-2 gap-3">
						<TextField
							label={<Trans>Pack</Trans>}
							name={fields.packName.name}
							defaultValue={initial.packName}
							onChange={(event) => setPackNameText(event.target.value)}
							error={fields.packName.errors?.[0] ?? null}
							placeholder={t`Box`}
							maxLength={40}
							dir="auto"
							data-testid="item-form-pack-name"
						/>
						<TextField
							label={<Trans>Holds</Trans>}
							name={fields.packSize.name}
							defaultValue={initial.packSize}
							onChange={(event) => setPackSizeText(event.target.value)}
							error={fields.packSize.errors?.[0] ?? null}
							inputMode="decimal"
							placeholder="10"
							dir="ltr"
							data-testid="item-form-pack-size"
						/>
					</div>
					<ToggleGroup
						aria-label={t`Unit of the pack size`}
						variant="segmented"
						value={[packSizeUnit]}
						onValueChange={(next) => {
							if (next[0]) setPackSizeUnit(next[0])
						}}
						className="flex-wrap"
					>
						{standardUnitsFor(baseUnit, system).map((unit) => (
							<ToggleGroupItem
								key={unit}
								value={unit}
								className="h-11 min-w-11 md:h-7"
							>
								<bdi dir="ltr">{unitLabel(unit)}</bdi>
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					{suppliersEnabled && supplierRows.length > 0 ? (
						<>
							<SelectField
								label={<Trans>Bought from</Trans>}
								optional
								id={`${idPrefix}-supplier`}
								testId="item-form-supplier"
								options={[
									{ value: '', label: t`Nobody yet` },
									...supplierRows.map((row) => ({
										value: row.id,
										label: row.name,
									})),
								]}
								value={supplierId}
								onValueChange={setSupplierId}
								error={fields.supplierId.errors?.[0] ?? null}
							/>
							{supplierId !== '' ? (
								<>
									<TextField
										label={<Trans>Price of one pack ({currency})</Trans>}
										name={fields.price.name}
										defaultValue={initial.price}
										error={fields.price.errors?.[0] ?? null}
										inputMode="decimal"
										placeholder={exponent === 0 ? '280' : '280.00'}
										dir="ltr"
										data-testid="item-form-price"
									/>
									{measuredIn === 'weight' ? (
										<div className="flex items-center gap-2">
											<Checkbox
												id={`${idPrefix}-weight`}
												checked={pricedByWeight}
												onCheckedChange={(next) => setPricedByWeight(next)}
											/>
											<Label
												htmlFor={`${idPrefix}-weight`}
												className="cursor-pointer font-normal"
											>
												<Trans>
													Priced by weight (the invoice shows the real weight)
												</Trans>
											</Label>
										</div>
									) : null}
								</>
							) : null}
						</>
					) : null}
				</fieldset>
			) : null}

			<Field>
				<FieldLabel id={`${idPrefix}-count`}>
					<Trans>How you count it</Trans>
				</FieldLabel>
				<ToggleGroup
					aria-labelledby={`${idPrefix}-count`}
					variant="segmented"
					value={[activeCountUnit]}
					onValueChange={(next) => {
						if (next[0]) setCountUnit(next[0])
					}}
					className="flex-wrap"
				>
					{countChoices.map((unit) => (
						<ToggleGroupItem
							key={unit}
							value={unit}
							className="h-11 min-w-11 md:h-7"
							data-testid={`item-form-count-${unit}`}
						>
							<bdi dir="ltr">{unitLabel(unit)}</bdi>
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</Field>

			<Field>
				<FieldLabel id={`${idPrefix}-areas`}>
					<Trans>Kept in</Trans>{' '}
					<span className="text-muted-foreground font-normal">
						<Trans>(optional)</Trans>
					</span>
				</FieldLabel>
				{noAreasYet ? (
					<FieldDescription>
						<Trans>
							No storage areas yet.{' '}
							<Link
								to={`${basePath}/areas${search}`}
								className="underline underline-offset-4"
							>
								Add your fridges, freezers and shelves
							</Link>{' '}
							so counts follow your walk.
						</Trans>
					</FieldDescription>
				) : (
					<ToggleGroup
						aria-labelledby={`${idPrefix}-areas`}
						variant="outline"
						spacing={1}
						multiple
						value={areaIds}
						onValueChange={(next) => setAreaIds(next.slice(0, 10))}
						className="flex-wrap"
					>
						{areas.map((area) => (
							<ToggleGroupItem
								key={area.id}
								value={area.id}
								className="h-11 md:h-8"
								data-testid={`item-form-area-${area.id}`}
							>
								{area.name}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				)}
			</Field>

			<fieldset className="flex flex-col gap-3">
				<legend className="mb-1 text-sm font-medium">
					<Trans>Levels</Trans>{' '}
					<span className="text-muted-foreground font-normal">
						<Trans>(optional)</Trans>
					</span>
				</legend>
				<div className="grid grid-cols-2 gap-3">
					<TextField
						label={<Trans>Order more when below</Trans>}
						name={fields.orderBelow.name}
						defaultValue={initial.orderBelow}
						error={fields.orderBelow.errors?.[0] ?? null}
						inputMode="decimal"
						hint={<bdi dir="ltr">{unitLabel(activeCountUnit)}</bdi>}
						dir="ltr"
						data-testid="item-form-order-below"
					/>
					<TextField
						label={<Trans>Fill up to</Trans>}
						name={fields.fillUpTo.name}
						defaultValue={initial.fillUpTo}
						error={fields.fillUpTo.errors?.[0] ?? null}
						inputMode="decimal"
						hint={<bdi dir="ltr">{unitLabel(activeCountUnit)}</bdi>}
						dir="ltr"
						data-testid="item-form-fill-up-to"
					/>
				</div>
			</fieldset>
		</SheetForm>
	)
}

function categoryChanged(
	values: { categoryKey: string; customCategory: string },
	initial: ItemFormValues,
) {
	return (
		values.categoryKey !== initial.categoryKey ||
		(values.categoryKey === CUSTOM_CATEGORY_KEY &&
			values.customCategory !== initial.customCategory)
	)
}

function placeChanged(
	values: {
		countUnit: string
		areaIds: string
		orderBelow: string
		fillUpTo: string
	},
	initial: ItemFormValues,
) {
	return (
		values.countUnit !== initial.countUnit ||
		values.orderBelow !== initial.orderBelow ||
		values.fillUpTo !== initial.fillUpTo ||
		splitAreaIds(values.areaIds).join(',') !== initial.areaIds.join(',')
	)
}
