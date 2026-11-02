import { Trans, useLingui } from '@lingui/react/macro'
import { DISCOUNT_MAX_VARIANT_GROUPS } from '@repo/discounts'
import { Button } from '@repo/ui/button'
import { Field, FieldDescription, FieldLabel, FieldSet } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useState } from 'react'
import { CatalogPicker } from '#app/components/loyalty/catalog-picker.tsx'
import {
	type DiscountVariantGroupChoice,
	type VariantFilterRow,
} from '#app/utils/discounts/editor-model.ts'
import { FieldErrorText, RowLabel, fieldDomId } from './fields.tsx'

/**
 * "Only these options": rows of an option type the menu uses (Size, Crust)
 * and the values of it that qualify. Different option types must all match;
 * values in one row are alternatives. Hidden while the menu has no option
 * types and the discount names none.
 */
export function VariantFilter({
	field,
	rows,
	groups,
	error,
	onChange,
}: {
	/** Error key and DOM id, such as `variants` or `slots.1.variants`. */
	field: string
	rows: readonly VariantFilterRow[]
	groups: readonly DiscountVariantGroupChoice[]
	error?: string | null
	onChange: (next: VariantFilterRow[]) => void
}) {
	const { t } = useLingui()
	const [announcement, setAnnouncement] = useState('')
	if (groups.length === 0 && rows.length === 0) return null
	const id = fieldDomId(field)
	const titleId = `${id}-title`
	const hintId = `${id}-hint`
	const errorId = `${id}-error`
	const used = new Set(rows.map((row) => row.group).filter(Boolean))
	const unused = groups.filter((group) => !used.has(group.key))
	const full = rows.length >= DISCOUNT_MAX_VARIANT_GROUPS || unused.length === 0

	const update = (index: number, next: VariantFilterRow) =>
		onChange(rows.map((row, at) => (at === index ? next : row)))
	const groupName = (key: string) =>
		groups.find((group) => group.key === key)?.name ?? key
	const remove = (index: number) => {
		const name = groupName(rows[index]?.group ?? '')
		onChange(rows.filter((_, at) => at !== index))
		setAnnouncement(name ? t`${name} removed` : t`Option type removed`)
		document.getElementById(`${id}-add`)?.focus()
	}
	const add = () => {
		const key = unused[0]?.key ?? ''
		onChange([...rows, { group: key, values: [] }])
		const name = groupName(key)
		setAnnouncement(name ? t`${name} added` : t`Option type added`)
	}

	return (
		<FieldSet
			id={id}
			tabIndex={-1}
			aria-labelledby={titleId}
			aria-describedby={[hintId, error ? errorId : null]
				.filter(Boolean)
				.join(' ')}
		>
			<span id={titleId} className="text-sm font-medium">
				<Trans>Only these options</Trans>
			</span>
			<FieldDescription id={hintId}>
				<Trans>
					Optional. Only items with these options get the discount, such as
					Size: Large.
				</Trans>
			</FieldDescription>
			{rows.map((row, index) => {
				const number = index + 1
				const choice = groups.find((group) => group.key === row.group)
				// Another row's option type can't be chosen twice; a stored one the
				// menu no longer has stays listed under its key.
				const choosable = [
					...groups.filter(
						(group) => group.key === row.group || !used.has(group.key),
					),
					...(row.group && !choice
						? [{ key: row.group, name: row.group, items: 0, values: [] }]
						: []),
				]
				const items = choosable.map((group) => ({
					value: group.key,
					label: group.name,
				}))
				const selectId = `${id}-${index}-group`
				return (
					<div
						key={index}
						className="grid items-end gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]"
					>
						<Field>
							<FieldLabel htmlFor={selectId}>
								<RowLabel
									short={<Trans>Option type</Trans>}
									full={<Trans>Option type {number}</Trans>}
								/>
							</FieldLabel>
							<Select
								value={row.group || null}
								items={items}
								onValueChange={(next) => {
									if (typeof next !== 'string' || next === row.group) return
									// Values belong to one option type, so they start over.
									update(index, { group: next, values: [] })
								}}
							>
								<SelectTrigger id={selectId} className="w-full">
									<SelectValue placeholder={t`Choose`} />
								</SelectTrigger>
								<SelectContent>
									{items.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</Field>
						<CatalogPicker
							id={`${id}-${index}-values`}
							label={
								<RowLabel
									short={<Trans>Options</Trans>}
									full={<Trans>Options for option type {number}</Trans>}
								/>
							}
							options={choice?.values ?? []}
							value={row.values}
							multiple
							disabled={!row.group}
							placeholder={t`Choose options`}
							emptyMessage={<Trans>No options yet.</Trans>}
							onChange={(values) => update(index, { ...row, values })}
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="mb-1"
							aria-label={t`Remove option type ${number}`}
							onClick={() => remove(index)}
						>
							<Icon name="trash-2" />
						</Button>
					</div>
				)
			})}
			{error ? <FieldErrorText id={errorId}>{error}</FieldErrorText> : null}
			<p role="status" aria-live="polite" className="sr-only">
				{announcement}
			</p>
			<div>
				<Button
					id={`${id}-add`}
					type="button"
					variant="outline"
					size="sm"
					disabled={full}
					onClick={add}
				>
					<Icon name="plus" data-icon="inline-start" />
					<Trans>Add option type</Trans>
				</Button>
			</div>
		</FieldSet>
	)
}
