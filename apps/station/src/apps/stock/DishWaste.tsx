import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type WasteReason } from '@repo/inventory'
import { useMemo } from 'react'
import { BigStepper } from './BigStepper.tsx'
import { WASTE_REASON_LABELS } from './messages.ts'
import { filterItems } from './model.ts'
import { type MenuItem } from '~/lib/types.ts'
import { Chip, fieldClass, Input } from '~/ui/primitives.tsx'

/** A dish as the picker needs it: names for what the person taps, ids for what the office takes. */
export type PickableDish = {
	id: string
	name: string
	variants: Array<{ id: string; label: string }>
	groups: Array<{
		id: string
		name: string
		options: Array<{ id: string; name: string }>
	}>
}

/** The menu's dishes with their sizes and options, in the till's language. */
export function pickableDishes(items: Iterable<MenuItem>): PickableDish[] {
	return [...items].map((item) => ({
		id: item.id,
		name: item.displayName,
		variants: item.variations.variants.map((variant) => ({
			id: variant.id,
			label: variant.valueIds
				.map(
					(valueId, index) =>
						item.variations.groups[index]?.values.find(
							(value) => value.id === valueId,
						)?.name ?? '',
				)
				.filter(Boolean)
				.join(' · '),
		})),
		groups: item.modifierGroups
			.filter((group) => group.options.length > 0)
			.map((group) => ({
				id: group.id,
				name: group.name,
				options: group.options.map((option) => ({
					id: option.id,
					name: option.displayName,
				})),
			})),
	}))
}

/**
 * The Dishes side of the waste sheet (#517): find a dish, say how many, pick
 * its size and extras (they change the ingredients like a sale does) and why.
 * The office takes the ingredients out by the recipe and groups them under the
 * dish, so a slip is one tap to undo.
 */
export function DishWasteBody({
	dishes,
	dish,
	onDish,
	query,
	onQuery,
	variantId,
	onVariant,
	optionIds,
	onOptions,
	quantity,
	onQuantity,
	reasons,
	reason,
	onReason,
	note,
	onNote,
	problem,
}: {
	dishes: readonly PickableDish[]
	dish: PickableDish | null
	onDish: (dish: PickableDish | null) => void
	query: string
	onQuery: (query: string) => void
	variantId: string | null
	onVariant: (id: string | null) => void
	optionIds: readonly string[]
	onOptions: (ids: string[]) => void
	quantity: number | null
	onQuantity: (quantity: number | null) => void
	reasons: readonly WasteReason[]
	reason: WasteReason | null
	onReason: (reason: WasteReason) => void
	note: string
	onNote: (note: string) => void
	problem: string | null
}) {
	const { _ } = useLingui()
	const matches = useMemo(
		() => filterItems(dishes, query).slice(0, 40),
		[dishes, query],
	)
	if (!dish) {
		return (
			<div className="flex flex-col gap-4" data-testid="waste-dishes">
				<label className="flex flex-col gap-2">
					<span className="text-base font-semibold">
						<Trans>Which dish?</Trans>
					</span>
					<input
						type="search"
						className={fieldClass}
						value={query}
						placeholder={_(t`Search dishes`)}
						autoComplete="off"
						onChange={(event) => onQuery(event.target.value)}
					/>
				</label>
				{matches.length === 0 ? (
					<p className="text-muted-foreground">
						<Trans>No dish matches that.</Trans>
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{matches.map((entry) => (
							<li key={entry.id}>
								<button
									type="button"
									onClick={() => {
										onDish(entry)
										onVariant(null)
										onOptions([])
										onQuantity(1)
									}}
									className="border-border bg-card hover:bg-accent flex min-h-14 w-full items-center justify-between gap-3 rounded-(--station-control-radius) border px-4 py-2 text-start"
								>
									<span className="min-w-0 font-medium break-words">
										{entry.name}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		)
	}
	return (
		<div className="flex flex-col gap-5" data-testid="waste-dish-form">
			<div className="border-border bg-card flex items-start justify-between gap-3 rounded-(--station-panel-radius) border p-4">
				<p className="min-w-0 text-xl font-semibold break-words">{dish.name}</p>
				<button
					type="button"
					className="text-primary text-base font-medium underline"
					onClick={() => onDish(null)}
				>
					<Trans>Change dish</Trans>
				</button>
			</div>
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 text-base font-semibold">
					<Trans>How many</Trans>
				</legend>
				<BigStepper
					value={quantity}
					label={dish.name}
					step={1}
					fractions={false}
					max={50}
					onChange={onQuantity}
				/>
			</fieldset>
			{dish.variants.length > 0 ? (
				<fieldset className="flex flex-col gap-2">
					<legend className="mb-1 text-base font-semibold">
						<Trans>Size</Trans>
					</legend>
					<div className="flex flex-wrap gap-2">
						{dish.variants.map((variant) => (
							<Chip
								key={variant.id}
								size="lg"
								look="outlined"
								selected={variantId === variant.id}
								aria-pressed={variantId === variant.id}
								onClick={() => onVariant(variant.id)}
							>
								{variant.label}
							</Chip>
						))}
					</div>
				</fieldset>
			) : null}
			{dish.groups.map((group) => (
				<fieldset key={group.id} className="flex flex-col gap-2">
					<legend className="mb-1 text-base font-semibold">{group.name}</legend>
					<div className="flex flex-wrap gap-2">
						{group.options.map((option) => {
							const on = optionIds.includes(option.id)
							return (
								<Chip
									key={option.id}
									size="lg"
									look="outlined"
									selected={on}
									aria-pressed={on}
									onClick={() =>
										onOptions(
											on
												? optionIds.filter((id) => id !== option.id)
												: [...optionIds, option.id],
										)
									}
								>
									{option.name}
								</Chip>
							)
						})}
					</div>
				</fieldset>
			))}
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-1 text-base font-semibold">
					<Trans>Why</Trans>
				</legend>
				<div className="flex flex-wrap gap-2">
					{reasons.map((entry) => (
						<Chip
							key={entry}
							size="lg"
							look="outlined"
							selected={reason === entry}
							aria-pressed={reason === entry}
							onClick={() => onReason(entry)}
						>
							{_(WASTE_REASON_LABELS[entry])}
						</Chip>
					))}
				</div>
			</fieldset>
			<label className="flex flex-col gap-2">
				<span className="text-base font-semibold">
					<Trans>Note (optional)</Trans>
				</span>
				<Input
					value={note}
					maxLength={500}
					onChange={(event) => onNote(event.target.value)}
				/>
			</label>
			{problem ? (
				<p role="alert" className="text-destructive text-sm">
					{problem}
				</p>
			) : null}
		</div>
	)
}
