import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import { INVENTORY_CATEGORIES, STANDARD_UNITS } from '@repo/inventory'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Item, ItemGroup } from '@repo/ui/item'
import { useQuantityFormat } from '#app/components/inventory/inventory-prefs.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	type BulkDraft,
	type BulkProblem,
	type ReviewedBulkRow,
} from '#app/utils/inventory/bulk-import.ts'
import { categoryLabel } from '#app/utils/inventory/labels.ts'

const PROBLEM_MESSAGES: Record<BulkProblem, MessageDescriptor> = {
	name_required: msg`Add a name.`,
	name_too_long: msg`Use 80 characters or fewer.`,
	name_invalid: msg`Remove the special characters.`,
	duplicate: msg`Same name as an earlier row.`,
	unit_required: msg`Choose a unit.`,
	bad_price: msg`Enter the price of one unit, for example 28.50.`,
	category_too_long: msg`Use 40 characters or fewer for the category.`,
}

/**
 * The review step of "Paste from a spreadsheet": one block per row with its
 * fields editable and its problems written out underneath. Nothing here is
 * saved until Add.
 */
export function BulkReviewRows({
	rows,
	onChange,
	onRemove,
}: {
	rows: readonly ReviewedBulkRow[]
	onChange: (id: number, patch: Partial<Omit<BulkDraft, 'id'>>) => void
	onRemove: (id: number) => void
}) {
	const { t, i18n } = useLingui()
	const quantity = useQuantityFormat()
	const unitOptions = [
		{ value: '', label: t`Choose a unit` },
		...STANDARD_UNITS.map((unit) => ({
			value: unit,
			label: quantity.unitName(unit, []),
		})),
	]
	return (
		<ItemGroup>
			{rows.map((row) => {
				const invalid = row.problems.length > 0
				const rowNumber = row.row
				const rowLabel = t`Row ${rowNumber}`
				const categoryOptions = [
					...INVENTORY_CATEGORIES.map((value) => ({
						value: value as string,
						label: categoryLabel(value, i18n),
					})),
					...(INVENTORY_CATEGORIES.includes(
						row.category as (typeof INVENTORY_CATEGORIES)[number],
					)
						? []
						: [
								{
									value: row.category,
									label: categoryLabel(row.category, i18n),
								},
							]),
				]
				return (
					<Item
						key={row.id}
						variant="outline"
						render={<li />}
						data-testid={`bulk-row-${row.id}`}
					>
						<div className="flex w-full flex-col gap-2">
							<div className="flex items-start gap-2">
								<span className="text-muted-foreground w-7 shrink-0 pt-3 text-xs tabular-nums md:pt-2">
									{row.row}
								</span>
								<div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
									<Input
										className="col-span-2 h-11 md:h-8"
										aria-label={`${rowLabel}: ${t`Name`}`}
										aria-invalid={invalid ? true : undefined}
										aria-describedby={
											invalid ? `bulk-${row.id}-problems` : undefined
										}
										dir="auto"
										placeholder={t`Name`}
										value={row.name}
										onChange={(event) =>
											onChange(row.id, { name: event.target.value })
										}
									/>
									<FilterSelect
										label={`${rowLabel}: ${t`Category`}`}
										options={categoryOptions}
										value={row.category}
										onValueChange={(category) => onChange(row.id, { category })}
										className="md:w-full"
									/>
									<FilterSelect
										label={`${rowLabel}: ${t`Unit`}`}
										options={unitOptions}
										value={row.unit}
										onValueChange={(unit) =>
											onChange(row.id, { unit: unit as BulkDraft['unit'] })
										}
										className="md:w-full"
									/>
									<Input
										className="col-span-2 h-11 md:h-8"
										aria-label={`${rowLabel}: ${t`Price per unit`}`}
										aria-invalid={
											row.problems.includes('bad_price') ? true : undefined
										}
										dir="ltr"
										inputMode="decimal"
										placeholder={t`Price per unit (optional)`}
										value={row.price}
										onChange={(event) =>
											onChange(row.id, { price: event.target.value })
										}
									/>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-11 shrink-0 md:size-9"
									aria-label={t`Remove ${rowLabel}`}
									onClick={() => onRemove(row.id)}
								>
									<Icon name="x" />
								</Button>
							</div>
							{invalid ? (
								<p
									id={`bulk-${row.id}-problems`}
									className="text-destructive ps-9 text-xs"
									role="status"
								>
									{row.problems
										.map((problem) => i18n._(PROBLEM_MESSAGES[problem]))
										.join(' ')}
								</p>
							) : null}
						</div>
					</Item>
				)
			})}
		</ItemGroup>
	)
}
