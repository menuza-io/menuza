import { type MessageDescriptor } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { FieldSet } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { type ReactNode, useEffect, useState } from 'react'
import { CatalogPicker } from '#app/components/loyalty/catalog-picker.tsx'
import {
	DISCOUNT_MAX_BUNDLE_SLOTS,
	type DiscountVariantGroupChoice,
	type EditorErrors,
	type ItemGroupState,
	newSlot,
	type SlotState,
} from '#app/utils/discounts/editor-model.ts'
import { ANNOUNCE } from '#app/utils/discounts/labels.ts'
import { type LoyaltyCatalog } from '#app/utils/loyalty/catalog.ts'
import {
	FieldErrorText,
	Indented,
	TextField,
	fieldDomId,
	useEditorErrorText,
} from './fields.tsx'
import { VariantFilter } from './variant-filter.tsx'

/**
 * One group of a deal: how many, and which items or categories count. The same
 * block serves "customer buys", "customer gets" and each part of a meal deal,
 * so an operator learns it once.
 */
export function ItemGroup({
	path,
	legend,
	hint,
	action,
	group,
	catalog,
	variantGroups,
	currency,
	canSpend = false,
	errors,
	onChange,
}: {
	/** Error and DOM id prefix, such as `buyGroup` or `slots.1`. */
	path: string
	legend: ReactNode
	hint?: ReactNode
	/** Sits at the end of the legend row, such as a remove button. */
	action?: ReactNode
	group: ItemGroupState
	catalog: LoyaltyCatalog
	/** The option types (Size, Crust) the group can be limited to. */
	variantGroups: readonly DiscountVariantGroupChoice[]
	currency: string
	/** The buy group can count items or add up what is spent on them. */
	canSpend?: boolean
	errors: EditorErrors
	onChange: (next: ItemGroupState) => void
}) {
	const { t } = useLingui()
	const errorText = useEditorErrorText()
	const itemsError = errors[`${path}.items`]
	const bySpend = canSpend && group.by === 'spend'
	const titleId = `${fieldDomId(path)}-title`
	return (
		<FieldSet id={fieldDomId(path)} tabIndex={-1} aria-labelledby={titleId}>
			<div className="flex items-center justify-between gap-2">
				<span id={titleId} className="text-base font-medium">
					{legend}
				</span>
				{action}
			</div>
			{hint ? <p className="text-muted-foreground text-sm">{hint}</p> : null}
			<div className="flex flex-col gap-4">
				{canSpend ? (
					<ToggleGroup
						variant="segmented"
						aria-labelledby={titleId}
						value={[group.by]}
						onValueChange={(next) => {
							// Pressing the chosen one again would clear it; keep it.
							const [chosen] = next
							if (chosen)
								onChange({ ...group, by: chosen as 'quantity' | 'spend' })
						}}
					>
						<ToggleGroupItem value="quantity">
							<Trans>By quantity</Trans>
						</ToggleGroupItem>
						<ToggleGroupItem value="spend">
							<Trans>By amount spent</Trans>
						</ToggleGroupItem>
					</ToggleGroup>
				) : null}
				{bySpend ? (
					<TextField
						field={`${path}.spend`}
						label={<Trans>Amount spent</Trans>}
						hint={
							<Trans>
								Amount in <bdi>{currency}</bdi>. Every time this much is spent,
								the customer gets the discount again.
							</Trans>
						}
						value={group.spend}
						error={errors[`${path}.spend`]}
						inputMode="decimal"
						className="sm:max-w-64"
						onChange={(spend) => onChange({ ...group, spend })}
					/>
				) : (
					<TextField
						field={`${path}.quantity`}
						label={<Trans>Quantity</Trans>}
						value={group.quantity}
						error={errors[`${path}.quantity`]}
						inputMode="numeric"
						className="sm:max-w-32"
						onChange={(quantity) => onChange({ ...group, quantity })}
					/>
				)}
				<CatalogPicker
					id={fieldDomId(`${path}.items`)}
					label={<Trans>Items</Trans>}
					options={catalog.items}
					value={group.itemIds}
					multiple
					placeholder={t`Search items`}
					emptyMessage={<Trans>No items yet.</Trans>}
					error={itemsError ? errorText(itemsError) : null}
					onChange={(itemIds) => onChange({ ...group, itemIds })}
				/>
				<CatalogPicker
					id={fieldDomId(`${path}.categories`)}
					label={<Trans>Categories</Trans>}
					options={catalog.categories}
					value={group.categoryIds}
					multiple
					placeholder={t`Search categories`}
					emptyMessage={<Trans>No categories yet.</Trans>}
					error={
						errors[`${path}.categories`]
							? errorText(errors[`${path}.categories`]!)
							: null
					}
					onChange={(categoryIds) => onChange({ ...group, categoryIds })}
				/>
				<VariantFilter
					field={`${path}.variants`}
					rows={group.variants}
					groups={variantGroups}
					error={
						errors[`${path}.variants`]
							? errorText(errors[`${path}.variants`]!)
							: null
					}
					onChange={(variants) => onChange({ ...group, variants })}
				/>
			</div>
		</FieldSet>
	)
}

/** Buy from one group, get from another. */
export function BuyGetGroups({
	buy,
	get,
	catalog,
	variantGroups,
	currency,
	errors,
	onBuyChange,
	onGetChange,
}: {
	buy: ItemGroupState
	get: ItemGroupState
	catalog: LoyaltyCatalog
	variantGroups: readonly DiscountVariantGroupChoice[]
	currency: string
	errors: EditorErrors
	onBuyChange: (next: ItemGroupState) => void
	onGetChange: (next: ItemGroupState) => void
}) {
	return (
		<div className="flex flex-col gap-6">
			<Indented>
				<ItemGroup
					path="buyGroup"
					legend={<Trans>Customer buys</Trans>}
					hint={
						buy.by === 'spend' ? (
							<Trans>
								What is spent on these counts towards the amount. Items that get
								the discount don't count.
							</Trans>
						) : (
							<Trans>
								These items are used up by the deal. Two burgers earn two
								discounted sides, not one.
							</Trans>
						)
					}
					group={buy}
					catalog={catalog}
					variantGroups={variantGroups}
					currency={currency}
					canSpend
					errors={errors}
					onChange={onBuyChange}
				/>
			</Indented>
			<Indented>
				<ItemGroup
					path="getGroup"
					legend={<Trans>Customer gets</Trans>}
					hint={
						<Trans>
							The discount applies to these. If a deal covers fewer items than
							the order holds, the cheapest are discounted.
						</Trans>
					}
					group={get}
					catalog={catalog}
					variantGroups={variantGroups}
					currency={currency}
					errors={errors}
					onChange={onGetChange}
				/>
			</Indented>
		</div>
	)
}

/** The parts of a meal deal: add, remove and fill each group. */
export function DealSlots({
	slots,
	catalog,
	variantGroups,
	currency,
	errors,
	onChange,
}: {
	slots: readonly SlotState[]
	catalog: LoyaltyCatalog
	variantGroups: readonly DiscountVariantGroupChoice[]
	currency: string
	errors: EditorErrors
	onChange: (next: SlotState[]) => void
}) {
	const { t, i18n } = useLingui()
	const tx = (descriptor: MessageDescriptor) => i18n._(descriptor)
	const errorText = useEditorErrorText()
	const [announcement, setAnnouncement] = useState('')
	const [focusKey, setFocusKey] = useState<string | null>(null)
	const full = slots.length >= DISCOUNT_MAX_BUNDLE_SLOTS

	// Put the cursor in a new group's quantity so the operator can keep typing.
	useEffect(() => {
		if (!focusKey) return
		const index = slots.findIndex((slot) => slot.key === focusKey)
		if (index >= 0) {
			document.getElementById(fieldDomId(`slots.${index}.quantity`))?.focus()
		}
		setFocusKey(null)
	}, [focusKey, slots])

	const update = (index: number, next: ItemGroupState) =>
		onChange(
			slots.map((slot, at) => (at === index ? { ...slot, ...next } : slot)),
		)
	const add = () => {
		const slot = newSlot()
		onChange([...slots, slot])
		setFocusKey(slot.key)
		setAnnouncement(ANNOUNCE.groupAdded(slots.length + 1, tx))
	}
	const remove = (index: number) => {
		onChange(slots.filter((_, at) => at !== index))
		setAnnouncement(ANNOUNCE.groupRemoved(slots.length - 1, tx))
		document.getElementById('discount-slots-add')?.focus()
	}

	return (
		<div
			id={fieldDomId('slots')}
			tabIndex={-1}
			className="flex flex-col gap-6 outline-none"
		>
			<p className="text-muted-foreground text-sm">
				<Trans>
					Each group is one part of the deal, such as a pizza, a side or a
					drink. The customer gets the deal once the order has every group.
				</Trans>
			</p>
			{slots.map((slot, index) => {
				const number = index + 1
				return (
					<Indented key={slot.key}>
						<ItemGroup
							path={`slots.${index}`}
							legend={<Trans>Group {number}</Trans>}
							action={
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={slots.length === 1}
									aria-label={t`Remove group ${number}`}
									onClick={() => remove(index)}
								>
									<Icon name="trash-2" />
								</Button>
							}
							group={slot}
							catalog={catalog}
							variantGroups={variantGroups}
							currency={currency}
							errors={errors}
							onChange={(next) => update(index, next)}
						/>
					</Indented>
				)
			})}
			{errors.slots ? (
				<FieldErrorText id={`${fieldDomId('slots')}-error`}>
					{errorText(errors.slots)}
				</FieldErrorText>
			) : null}
			<p role="status" className="sr-only">
				{announcement}
			</p>
			<div>
				<Button
					id="discount-slots-add"
					type="button"
					variant="outline"
					size="sm"
					disabled={full}
					onClick={add}
				>
					<Icon name="plus" data-icon="inline-start" />
					<Trans>Add a group</Trans>
				</Button>
			</div>
		</div>
	)
}
