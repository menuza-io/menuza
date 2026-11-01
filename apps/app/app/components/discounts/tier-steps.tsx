import { type MessageDescriptor } from '@lingui/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { type DiscountTierBasis } from '@repo/discounts'
import { Button } from '@repo/ui/button'
import { Field, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useEffect, useState } from 'react'
import {
	DISCOUNT_MAX_TIER_STEPS,
	type EditorErrors,
	newTier,
	type TierRow,
} from '#app/utils/discounts/editor-model.ts'
import { ANNOUNCE } from '#app/utils/discounts/labels.ts'
import {
	FieldErrorText,
	RowLabel,
	TextField,
	fieldDomId,
	useEditorErrorText,
} from './fields.tsx'

/**
 * A ladder of tiers: "spend $30 get 5%, spend $50 get 15%". The first row
 * carries the column names; later rows keep theirs for screen readers only, so
 * a long ladder stays short on the page.
 */
export function TierSteps({
	basis,
	rows,
	percent,
	currency,
	errors,
	onBasisChange,
	onChange,
}: {
	basis: DiscountTierBasis
	rows: readonly TierRow[]
	/** True when each tier is a percentage, false when it is an amount. */
	percent: boolean
	currency: string
	errors: EditorErrors
	onBasisChange: (basis: DiscountTierBasis) => void
	onChange: (rows: TierRow[]) => void
}) {
	const { t, i18n } = useLingui()
	const tx = (descriptor: MessageDescriptor) => i18n._(descriptor)
	const errorText = useEditorErrorText()
	const [announcement, setAnnouncement] = useState('')
	const [focusKey, setFocusKey] = useState<string | null>(null)
	const full = rows.length >= DISCOUNT_MAX_TIER_STEPS
	const spend = basis === 'spend'

	// Put the cursor in a new tier so the operator can keep typing.
	useEffect(() => {
		if (!focusKey) return
		const index = rows.findIndex((row) => row.key === focusKey)
		if (index >= 0) {
			document.getElementById(fieldDomId(`tiers.${index}.at`))?.focus()
		}
		setFocusKey(null)
	}, [focusKey, rows])

	const update = (index: number, next: Partial<TierRow>) =>
		onChange(rows.map((row, at) => (at === index ? { ...row, ...next } : row)))
	const add = () => {
		const row = newTier()
		onChange([...rows, row])
		setFocusKey(row.key)
		setAnnouncement(ANNOUNCE.tierAdded(rows.length + 1, tx))
	}
	const remove = (index: number) => {
		onChange(rows.filter((_, at) => at !== index))
		setAnnouncement(ANNOUNCE.tierRemoved(rows.length - 1, tx))
		document.getElementById('discount-tiers-add')?.focus()
	}

	return (
		<div
			id={fieldDomId('tiers')}
			tabIndex={-1}
			className="flex flex-col gap-4 outline-none"
		>
			<Field>
				<FieldLabel id="discount-tier-basis-label">
					<Trans>Tiers go up by</Trans>
				</FieldLabel>
				<ToggleGroup
					variant="segmented"
					aria-labelledby="discount-tier-basis-label"
					value={[basis]}
					onValueChange={(next) => {
						// Pressing the chosen one again would clear it; keep it.
						const [chosen] = next
						if (chosen) onBasisChange(chosen as DiscountTierBasis)
					}}
				>
					<ToggleGroupItem value="spend">
						<Trans>Amount spent</Trans>
					</ToggleGroupItem>
					<ToggleGroupItem value="quantity">
						<Trans>Items bought</Trans>
					</ToggleGroupItem>
				</ToggleGroup>
			</Field>
			<ul className="flex flex-col gap-3">
				{rows.map((row, index) => {
					const first = index === 0
					const number = index + 1
					return (
						<li
							key={row.key}
							className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"
						>
							<TextField
								field={`tiers.${index}.at`}
								label={
									<RowLabel
										visible={first}
										short={
											spend ? (
												<Trans>Spend at least</Trans>
											) : (
												<Trans>Buy at least</Trans>
											)
										}
										full={
											spend ? (
												<Trans>Tier {number}: spend at least</Trans>
											) : (
												<Trans>Tier {number}: buy at least</Trans>
											)
										}
									/>
								}
								suffix={spend ? currency : undefined}
								value={row.at}
								error={errors[`tiers.${index}.at`]}
								inputMode={spend ? 'decimal' : 'numeric'}
								onChange={(at) => update(index, { at })}
							/>
							<TextField
								field={`tiers.${index}.value`}
								label={
									<RowLabel
										visible={first}
										short={
											percent ? (
												<Trans>Percent off</Trans>
											) : (
												<Trans>Amount off</Trans>
											)
										}
										full={
											percent ? (
												<Trans>Tier {number}: percent off</Trans>
											) : (
												<Trans>Tier {number}: amount off</Trans>
											)
										}
									/>
								}
								suffix={percent ? '%' : currency}
								value={row.value}
								error={errors[`tiers.${index}.value`]}
								inputMode="decimal"
								onChange={(value) => update(index, { value })}
							/>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								disabled={rows.length === 1}
								aria-label={t`Remove tier ${number}`}
								onClick={() => remove(index)}
							>
								<Icon name="trash-2" />
							</Button>
						</li>
					)
				})}
			</ul>
			{errors.tiers ? (
				<FieldErrorText id={`${fieldDomId('tiers')}-error`}>
					{errorText(errors.tiers)}
				</FieldErrorText>
			) : null}
			<p role="status" className="sr-only">
				{announcement}
			</p>
			<div>
				<Button
					id="discount-tiers-add"
					type="button"
					variant="outline"
					size="sm"
					disabled={full}
					onClick={add}
				>
					<Icon name="plus" data-icon="inline-start" />
					<Trans>Add a tier</Trans>
				</Button>
			</div>
		</div>
	)
}
