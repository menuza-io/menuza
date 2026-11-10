import { Trans, useLingui } from '@lingui/react/macro'
import {
	type InventoryBaseUnit,
	standardUnitsFor,
	type StockItem,
	type SupplierProduct,
	supplierProductSchema,
	type UnitRef,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { type KeyboardEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import { ItemPicker } from '#app/components/inventory/item-picker.tsx'
import { useItemBaseUnits } from '#app/components/inventory/use-item-base-units.ts'
import { TextField } from '#app/components/staff/controls.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { defaultEntryUnit, formatMoney } from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	buildSupplierProductPayload,
	buildUpdateSupplierProductPayload,
	type SupplierProductFormValues,
	type SupplierProductProblem,
	validateSupplierProduct,
} from '#app/utils/inventory/supplier-form.ts'
import { minorToMajorText } from '#app/utils/money-input.ts'

type Editing =
	{ mode: 'add' } | { mode: 'edit'; product: SupplierProduct } | null

/**
 * What a supplier sells: one row per item and pack, with its price. A pack's
 * size is fixed once saved (a different size is a new pack); name, price and
 * the two flags can change.
 */
export function SupplierProducts({
	supplierId,
	products,
	canManage,
	canSeeCost,
	currency,
	locationId,
	onChanged,
}: {
	supplierId: string
	products: readonly SupplierProduct[]
	canManage: boolean
	canSeeCost: boolean
	currency: string
	locationId: string
	onChanged: () => void
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const [editing, setEditing] = useState<Editing>(null)
	const [busyId, setBusyId] = useState<string | null>(null)
	const baseUnits = useItemBaseUnits(
		products.map((product) => product.itemId),
		locationId,
	)

	async function archive(product: SupplierProduct) {
		setBusyId(product.id)
		try {
			await request(
				`/supplier-products/${encodeURIComponent(product.id)}/archive`,
				{
					method: 'POST',
					body: JSON.stringify({ expectedVersion: product.version }),
				},
			)
			const name = product.itemName
			toast.success(t`${name} removed from this supplier.`)
			onChanged()
		} catch (caught) {
			toast.error(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setBusyId(null)
		}
	}

	return (
		<section
			className="flex flex-col gap-3"
			aria-labelledby="supplier-products-title"
			data-testid="supplier-products"
		>
			<div className="flex items-center justify-between gap-3">
				<h3 id="supplier-products-title" className="text-sm font-semibold">
					<Trans>What they sell</Trans>
				</h3>
				{canManage && canSeeCost && editing === null ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setEditing({ mode: 'add' })}
						data-testid="supplier-product-add"
					>
						<Icon name="plus" />
						<Trans>Add an item</Trans>
					</Button>
				) : null}
			</div>

			{products.length === 0 && editing === null ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid="supplier-products-empty"
				>
					<Trans>
						Nothing yet. Add the items you buy from them, with the pack and its
						price, so a delivery fills in the price for you.
					</Trans>
				</p>
			) : (
				<ul className="flex flex-col divide-y rounded-xl border">
					{products.map((product) => {
						const itemName = product.itemName
						const baseUnit = baseUnits[product.itemId]
						const size = baseUnit
							? quantity.format(product.packBaseQuantity, { baseUnit })
							: null
						return (
							<li
								key={product.id}
								className="flex flex-col gap-2 p-3"
								data-testid={`supplier-product-${product.id}`}
							>
								<div className="flex items-start justify-between gap-3">
									<div className="flex min-w-0 flex-col">
										<span className="font-medium wrap-anywhere">
											{product.itemName}
										</span>
										<span className="text-muted-foreground text-xs">
											<span className="wrap-anywhere">{product.packName}</span>
											{size ? (
												<>
													{' · '}
													<bdi dir="ltr">{size}</bdi>
												</>
											) : null}
											{product.priceMinor !== undefined ? (
												<>
													{' · '}
													<bdi dir="ltr">
														{formatMoney(
															product.priceMinor,
															product.currency ?? currency,
															i18n.locale,
														)}
													</bdi>
												</>
											) : null}
										</span>
										<span className="mt-1 flex flex-wrap gap-1">
											{product.preferred ? (
												<Badge variant="secondary">
													<Trans>Preferred</Trans>
												</Badge>
											) : null}
											{product.pricedByWeight ? (
												<Badge variant="outline">
													<Trans>Priced by weight</Trans>
												</Badge>
											) : null}
										</span>
									</div>
									{canManage && editing === null ? (
										<div className="flex shrink-0 items-center">
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="size-11 md:size-8"
												aria-label={t`Edit ${itemName}`}
												disabled={busyId !== null}
												onClick={() => setEditing({ mode: 'edit', product })}
											>
												<Icon name="pencil" />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="size-11 md:size-8"
												aria-label={t`Remove ${itemName}`}
												disabled={busyId !== null}
												onClick={() => void archive(product)}
												data-testid={`supplier-product-remove-${product.id}`}
											>
												<Icon name="trash-2" />
											</Button>
										</div>
									) : null}
								</div>
							</li>
						)
					})}
				</ul>
			)}

			{canManage && !canSeeCost ? (
				<p className="text-muted-foreground text-xs">
					<Trans>
						Prices need access to costs, so you cannot add items here.
					</Trans>
				</p>
			) : null}

			{editing !== null ? (
				<ProductEditor
					key={editing.mode === 'edit' ? editing.product.id : 'add'}
					supplierId={supplierId}
					editing={editing}
					currency={currency}
					locationId={locationId}
					client={{ request } as Pick<InventoryClient, 'request'>}
					baseUnit={
						editing.mode === 'edit'
							? (baseUnits[editing.product.itemId] ?? null)
							: null
					}
					onDone={(changed) => {
						setEditing(null)
						if (changed) onChanged()
					}}
				/>
			) : null}
		</section>
	)
}

function ProductEditor({
	supplierId,
	editing,
	currency,
	locationId,
	client,
	baseUnit: knownBaseUnit,
	onDone,
}: {
	supplierId: string
	editing: NonNullable<Editing>
	currency: string
	locationId: string
	client: Pick<InventoryClient, 'request'>
	baseUnit: InventoryBaseUnit | null
	onDone: (changed: boolean) => void
}) {
	const { t, i18n } = useLingui()
	const quantity = useQuantityFormat()
	const idPrefix = useId()
	const product = editing.mode === 'edit' ? editing.product : null
	const [item, setItem] = useState<StockItem | null>(null)
	const baseUnit = product ? knownBaseUnit : (item?.baseUnit ?? null)
	const [values, setValues] = useState<SupplierProductFormValues>({
		packName: product?.packName ?? '',
		packSize: '',
		packSizeUnit: defaultEntryUnit('g', null, [], quantity.system),
		price:
			product?.priceMinor !== undefined
				? minorToMajorText(product.priceMinor, currency)
				: '',
		pricedByWeight: product?.pricedByWeight ?? false,
		preferred: product?.preferred ?? false,
	})
	const [attempted, setAttempted] = useState(false)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	function choose(next: StockItem) {
		setItem(next)
		setValues((current) => ({
			...current,
			packSizeUnit: defaultEntryUnit(next.baseUnit, null, [], quantity.system),
			pricedByWeight:
				next.baseUnit === 'piece' ? false : current.pricedByWeight,
		}))
	}

	const problems: SupplierProductProblem[] = attempted
		? validateSupplierProduct(values, {
				itemId: item?.id ?? null,
				baseUnit,
				currency,
				editing: product !== null,
			})
		: []

	async function save() {
		if (pending) return
		setAttempted(true)
		const found = validateSupplierProduct(values, {
			itemId: item?.id ?? null,
			baseUnit,
			currency,
			editing: product !== null,
		})
		if (found.length > 0) return
		setPending(true)
		setError(null)
		try {
			if (product) {
				const payload = buildUpdateSupplierProductPayload(
					values,
					product,
					currency,
				)
				if (!payload) return
				supplierProductSchema.parse(
					await client.request(
						`/supplier-products/${encodeURIComponent(product.id)}`,
						{ method: 'PATCH', body: JSON.stringify(payload) },
					),
				)
			} else if (item && baseUnit) {
				const payload = buildSupplierProductPayload(values, {
					itemId: item.id,
					baseUnit,
					currency,
				})
				if (!payload) return
				supplierProductSchema.parse(
					await client.request(
						`/suppliers/${encodeURIComponent(supplierId)}/products`,
						{ method: 'POST', body: JSON.stringify(payload) },
					),
				)
			}
			toast.success(t`Saved.`)
			onDone(true)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setPending(false)
		}
	}

	// Inside the supplier sheet's form, Enter must save the product, not the supplier.
	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
			event.preventDefault()
			void save()
		}
	}

	return (
		<div
			className="bg-muted/30 flex flex-col gap-3 rounded-xl border p-3"
			onKeyDown={onKeyDown}
			data-testid="supplier-product-editor"
		>
			{error ? (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}
			{product ? (
				<p className="text-sm font-medium wrap-anywhere">{product.itemName}</p>
			) : (
				<ItemPicker
					id={`${idPrefix}-item`}
					label={<Trans>Item</Trans>}
					client={client}
					locationId={locationId}
					value={item}
					onChange={choose}
					placeholder={t`Choose an item`}
					error={problems.includes('item') ? t`Choose an item.` : null}
					testId="supplier-product-item"
				/>
			)}
			<TextField
				label={<Trans>Pack</Trans>}
				value={values.packName}
				onChange={(event) =>
					setValues((current) => ({ ...current, packName: event.target.value }))
				}
				error={
					problems.includes('packName')
						? t`Name the pack, for example Box.`
						: null
				}
				placeholder={t`Box`}
				maxLength={80}
				dir="auto"
				data-testid="supplier-product-pack"
			/>
			{product ? null : (
				<Field data-invalid={problems.includes('packSize') ? true : undefined}>
					<FieldLabel htmlFor={`${idPrefix}-size`}>
						<Trans>One pack holds</Trans>
					</FieldLabel>
					<div className="flex flex-wrap items-center gap-2">
						<Input
							id={`${idPrefix}-size`}
							value={values.packSize}
							onChange={(event) =>
								setValues((current) => ({
									...current,
									packSize: event.target.value,
								}))
							}
							inputMode="decimal"
							dir="ltr"
							placeholder="10"
							aria-invalid={problems.includes('packSize') ? true : undefined}
							className="h-11 w-28 tabular-nums md:h-8"
							data-testid="supplier-product-size"
						/>
						{baseUnit ? (
							<ToggleGroup
								aria-label={t`Unit of the pack size`}
								variant="segmented"
								value={[values.packSizeUnit]}
								onValueChange={(next) => {
									if (next[0]) {
										setValues((current) => ({
											...current,
											packSizeUnit: next[0] as UnitRef,
										}))
									}
								}}
								className="flex-wrap"
							>
								{standardUnitsFor(baseUnit, quantity.system).map((unit) => (
									<ToggleGroupItem
										key={unit}
										value={unit}
										className="h-11 min-w-11 md:h-7"
									>
										<bdi dir="ltr">{quantity.unitName(unit, [])}</bdi>
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						) : null}
					</div>
					{problems.includes('packSize') ? (
						<FieldError>
							<Trans>Enter how much one pack holds, above zero.</Trans>
						</FieldError>
					) : null}
				</Field>
			)}
			<TextField
				label={<Trans>Price of one pack ({currency})</Trans>}
				value={values.price}
				onChange={(event) =>
					setValues((current) => ({ ...current, price: event.target.value }))
				}
				error={
					problems.includes('price')
						? t`Enter the price of one pack, for example 28.50.`
						: null
				}
				inputMode="decimal"
				dir="ltr"
				data-testid="supplier-product-price"
			/>
			<div className="flex flex-col gap-2">
				{baseUnit !== 'piece' ? (
					<div className="flex items-center gap-2">
						<Checkbox
							id={`${idPrefix}-weight`}
							checked={values.pricedByWeight}
							onCheckedChange={(next) =>
								setValues((current) => ({ ...current, pricedByWeight: next }))
							}
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
				<div className="flex items-center gap-2">
					<Checkbox
						id={`${idPrefix}-preferred`}
						checked={values.preferred}
						onCheckedChange={(next) =>
							setValues((current) => ({ ...current, preferred: next }))
						}
					/>
					<Label
						htmlFor={`${idPrefix}-preferred`}
						className="cursor-pointer font-normal"
					>
						<Trans>The pack you usually buy</Trans>
					</Label>
				</div>
			</div>
			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={() => onDone(false)}
					disabled={pending}
				>
					<Trans>Cancel</Trans>
				</Button>
				<Button
					type="button"
					onClick={() => void save()}
					disabled={pending}
					data-testid="supplier-product-save"
				>
					{pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
				</Button>
			</div>
		</div>
	)
}
