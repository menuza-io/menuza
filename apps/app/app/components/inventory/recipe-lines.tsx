import { Trans, useLingui } from '@lingui/react/macro'
import { MAX_RECIPE_LINES, type StockItem } from '@repo/inventory'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { QuantityStepper } from '@repo/ui/quantity-stepper'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import { ItemPicker } from '#app/components/inventory/item-picker.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	entryStep,
	formatMoney,
	unitChoices,
} from '#app/utils/inventory/format.ts'
import {
	addLine,
	chooseLineItem,
	convertLineUnit,
	emptyLine,
	type KnownItem,
	lineProblems,
	type RecipeDraft,
	type RecipeProblemList,
	recipeEntryUnit,
	removeLine,
	updateLine,
} from '#app/utils/inventory/recipe-form.ts'

export type RecipeLineCost = { costMinor?: number; priced: boolean }

function knownFromStock(item: StockItem): KnownItem {
	return {
		id: item.id,
		name: item.name,
		baseUnit: item.baseUnit,
		units: item.units,
	}
}

/**
 * The ingredient rows of a recipe: an item, an amount in a unit, "Usable %"
 * and a remove button; option recipes may also hold "Replaces X with Y" rows.
 * Controlled by the owner's draft; it never fetches except through the item
 * picker.
 */
export function RecipeLines({
	draft,
	onDraftChange,
	problems,
	readOnly,
	allowReplace,
	client,
	locationId,
	idPrefix,
	lineCosts,
	currency,
	addLabel,
}: {
	draft: RecipeDraft
	onDraftChange: (next: RecipeDraft) => void
	problems: RecipeProblemList
	readOnly: boolean
	/** Option recipes only: lines may replace an ingredient of the dish. */
	allowReplace: boolean
	client: Pick<InventoryClient, 'request'>
	locationId: string
	idPrefix: string
	/** Cost of each ingredient as the saved recipe has it (cost grant only). */
	lineCosts?: ReadonlyMap<string, RecipeLineCost>
	currency: string
	addLabel?: string
}) {
	const { t, i18n } = useLingui()
	const quantity = useQuantityFormat()
	const atLimit = draft.lines.length >= MAX_RECIPE_LINES

	return (
		<div className="flex flex-col gap-3" data-testid={`${idPrefix}-lines`}>
			{draft.lines.length > 0 ? (
				<ul className="flex flex-col gap-3">
					{draft.lines.map((line, index) => {
						const bad = lineProblems(problems, line.key)
						const units = line.baseUnit
							? unitChoices(line.baseUnit, line.units, quantity.system)
							: []
						const showFractions =
							line.baseUnit === 'piece' ||
							(line.unit?.startsWith('unit:') ?? false)
						const cost = line.itemId ? lineCosts?.get(line.itemId) : undefined
						const rowNumber = index + 1
						return (
							<li
								key={line.key}
								className="flex flex-col gap-2 rounded-lg border p-3"
								aria-label={t`Ingredient ${rowNumber}`}
								data-testid={`${idPrefix}-line-${index}`}
							>
								{line.mode === 'replace' ? (
									<div className="grid gap-2 sm:grid-cols-2">
										<ItemPicker
											id={`${idPrefix}-${line.key}-replaces`}
											label={<Trans>Replaces</Trans>}
											client={client}
											locationId={locationId}
											value={
												line.replacesItemId
													? {
															id: line.replacesItemId,
															name: line.replacesItemName,
														}
													: null
											}
											onChange={(item) =>
												onDraftChange(
													updateLine(draft, line.key, {
														replacesItemId: item.id,
														replacesItemName: item.name,
													}),
												)
											}
											placeholder={t`Choose the ingredient it replaces`}
											error={
												bad.has('replaces')
													? t`Choose a different ingredient to replace.`
													: null
											}
											disabled={readOnly}
											testId={`${idPrefix}-line-${index}-replaces`}
										/>
										<ItemPicker
											id={`${idPrefix}-${line.key}-item`}
											label={<Trans>With</Trans>}
											client={client}
											locationId={locationId}
											value={
												line.itemId
													? { id: line.itemId, name: line.itemName }
													: null
											}
											onChange={(item) =>
												onDraftChange(
													chooseLineItem(
														draft,
														line.key,
														knownFromStock(item),
														recipeEntryUnit(item.baseUnit, quantity.system),
													),
												)
											}
											placeholder={t`Choose an ingredient`}
											error={bad.has('item') ? t`Choose an ingredient.` : null}
											disabled={readOnly}
											testId={`${idPrefix}-line-${index}-item`}
										/>
									</div>
								) : (
									<ItemPicker
										id={`${idPrefix}-${line.key}-item`}
										label={<Trans>Ingredient</Trans>}
										client={client}
										locationId={locationId}
										value={
											line.itemId
												? { id: line.itemId, name: line.itemName }
												: null
										}
										onChange={(item) =>
											onDraftChange(
												chooseLineItem(
													draft,
													line.key,
													knownFromStock(item),
													recipeEntryUnit(item.baseUnit, quantity.system),
												),
											)
										}
										placeholder={t`Choose an ingredient`}
										error={bad.has('item') ? t`Choose an ingredient.` : null}
										disabled={readOnly}
										testId={`${idPrefix}-line-${index}-item`}
									/>
								)}

								<div className="flex flex-wrap items-end gap-3">
									<div className="flex flex-col gap-1">
										<span className="text-muted-foreground text-xs">
											{line.mode === 'replace' ? (
												<Trans>Amount of the new ingredient</Trans>
											) : (
												<Trans>Amount</Trans>
											)}
										</span>
										<div className="flex items-center gap-2">
											<QuantityStepper
												value={line.amount}
												onValueChange={(amount) =>
													onDraftChange(updateLine(draft, line.key, { amount }))
												}
												step={entryStep(line.unit)}
												fractions={showFractions}
												decrementLabel={t`Less`}
												incrementLabel={t`More`}
												fractionLabel={(fraction) => t`Add ${fraction}`}
												disabled={readOnly || !line.itemId}
												invalid={bad.has('amount')}
												aria-label={t`Amount`}
												data-testid={`${idPrefix}-line-${index}-amount`}
											/>
											{line.baseUnit ? (
												<FilterSelect
													label={t`Unit`}
													options={units.map((choice) => ({
														value: choice,
														label: quantity.unitName(choice, line.units),
													}))}
													value={line.unit ?? ''}
													onValueChange={(next) => {
														onDraftChange({
															...draft,
															lines: draft.lines.map((candidate) =>
																candidate.key === line.key
																	? convertLineUnit(candidate, next)
																	: candidate,
															),
														})
													}}
													className="w-28"
													testId={`${idPrefix}-line-${index}-unit`}
												/>
											) : null}
										</div>
									</div>
									<label className="flex flex-col gap-1">
										<span className="text-muted-foreground text-xs">
											<Trans>Usable %</Trans>
										</span>
										<Input
											type="number"
											inputMode="numeric"
											min={1}
											max={100}
											step={1}
											value={line.usablePercent ?? ''}
											onChange={(event) => {
												const text = event.target.value
												onDraftChange(
													updateLine(draft, line.key, {
														usablePercent: text === '' ? null : Number(text),
													}),
												)
											}}
											disabled={readOnly}
											aria-invalid={bad.has('usable') ? true : undefined}
											className="h-11 w-20 tabular-nums md:h-8"
											data-testid={`${idPrefix}-line-${index}-usable`}
										/>
									</label>
									{cost ? (
										<span
											className="text-muted-foreground ms-auto text-sm tabular-nums"
											data-testid={`${idPrefix}-line-${index}-cost`}
										>
											{cost.costMinor !== undefined && cost.priced ? (
												<bdi dir="ltr">
													{formatMoney(cost.costMinor, currency, i18n.locale)}
												</bdi>
											) : cost.priced ? null : (
												<Trans>No price yet</Trans>
											)}
										</span>
									) : null}
									{readOnly ? null : (
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={t`Remove ingredient ${rowNumber}`}
											onClick={() => onDraftChange(removeLine(draft, line.key))}
											data-testid={`${idPrefix}-line-${index}-remove`}
										>
											<Icon name="trash-2" />
										</Button>
									)}
								</div>
								{bad.has('amount') ? (
									<p className="text-destructive text-xs" role="alert">
										<Trans>Enter an amount above zero.</Trans>
									</p>
								) : null}
								{bad.has('usable') ? (
									<p className="text-destructive text-xs" role="alert">
										<Trans>Usable % is a number from 1 to 100.</Trans>
									</p>
								) : null}
							</li>
						)
					})}
				</ul>
			) : null}

			{readOnly ? null : (
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={atLimit}
						onClick={() => onDraftChange(addLine(draft, emptyLine('add')))}
						data-testid={`${idPrefix}-add`}
					>
						<Icon name="plus" />
						{addLabel ?? <Trans>Add ingredient</Trans>}
					</Button>
					{allowReplace ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={atLimit}
							onClick={() =>
								onDraftChange(addLine(draft, emptyLine('replace')))
							}
							data-testid={`${idPrefix}-add-replace`}
						>
							<Icon name="plus" />
							<Trans>Replace an ingredient</Trans>
						</Button>
					) : null}
				</div>
			)}
		</div>
	)
}
