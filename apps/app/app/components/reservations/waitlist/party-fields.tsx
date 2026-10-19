import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Field, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useState } from 'react'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'

export type PartyFieldValues = {
	displayName: string
	partySize: number
	phone: string
	smsOptIn: boolean
	notes: string
	areaPrefId: string
}

const QUICK_SIZES = [1, 2, 3, 4, 5, 6, 8] as const
/** `SelectField` cannot hold an empty value, so "any area" travels as this key. */
const ANY_AREA = 'any'

/**
 * The fields for one party. The minimal path is name, party size and phone;
 * seating preference and notes sit behind "More" (open from the start when the
 * party already has them).
 */
export function PartyFields({
	idPrefix,
	values,
	onChange,
	areas = [],
	disabled = false,
	autoFocusName = false,
}: {
	idPrefix: string
	values: PartyFieldValues
	onChange: (patch: Partial<PartyFieldValues>) => void
	areas?: ReadonlyArray<{ id: string; name: string }>
	disabled?: boolean
	/** Put the cursor in the name field when the form appears. */
	autoFocusName?: boolean
}) {
	const { t } = useLingui()
	const [moreOpen, setMoreOpen] = useState(
		Boolean(values.areaPrefId || values.notes),
	)
	const areaOptions = [
		{ value: ANY_AREA, label: t`Any area` },
		...areas.map((area) => ({ value: area.id, label: area.name })),
	]
	return (
		<>
			<TextField
				id={`${idPrefix}-name`}
				label={<Trans>Name</Trans>}
				value={values.displayName}
				maxLength={120}
				required
				autoFocus={autoFocusName}
				autoComplete="off"
				disabled={disabled}
				onChange={(event) => onChange({ displayName: event.target.value })}
				data-testid={`${idPrefix}-name`}
			/>

			<Field>
				<FieldLabel id={`${idPrefix}-size-label`}>
					<Trans>Party size</Trans>
				</FieldLabel>
				<div className="flex flex-wrap items-center gap-2">
					<ToggleGroup
						aria-labelledby={`${idPrefix}-size-label`}
						variant="segmented"
						value={[String(values.partySize)]}
						disabled={disabled}
						onValueChange={(next) => {
							const picked = Number(next[0])
							if (Number.isFinite(picked) && picked > 0) {
								onChange({ partySize: picked })
							}
						}}
						className="flex-wrap"
					>
						{QUICK_SIZES.map((size) => (
							<ToggleGroupItem
								key={size}
								value={String(size)}
								className="h-11 min-w-9 md:h-7"
								data-testid={`${idPrefix}-size-${size}`}
							>
								{size}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					<Input
						id={`${idPrefix}-size`}
						type="number"
						min={1}
						max={99}
						aria-label={t`Party size`}
						value={values.partySize}
						disabled={disabled}
						onChange={(event) =>
							onChange({
								partySize: Math.min(
									99,
									Math.max(1, Number(event.target.value) || 1),
								),
							})
						}
						className="h-11 w-20 md:h-8"
						data-testid={`${idPrefix}-size`}
					/>
				</div>
			</Field>

			<TextField
				id={`${idPrefix}-phone`}
				label={<Trans>Phone</Trans>}
				optional
				type="tel"
				dir="ltr"
				inputMode="tel"
				maxLength={32}
				placeholder="+1..."
				value={values.phone}
				disabled={disabled}
				onChange={(event) => {
					const phone = event.target.value
					onChange({
						phone,
						...(phone.trim() ? {} : { smsOptIn: false }),
					})
				}}
				data-testid={`${idPrefix}-phone`}
			/>
			{values.phone.trim() ? (
				<label className="flex min-h-11 items-start gap-2.5 text-sm">
					<Checkbox
						checked={values.smsOptIn}
						disabled={disabled}
						onCheckedChange={(checked) => onChange({ smsOptIn: checked })}
						className="mt-0.5"
						data-testid={`${idPrefix}-sms-opt-in`}
					/>
					<span>
						<Trans>Text this guest when their table is ready.</Trans>
						<span className="text-muted-foreground block text-xs">
							<Trans>
								Texts are only sent to US phone numbers. For other numbers, tell
								the guest in person.
							</Trans>
						</span>
					</span>
				</label>
			) : null}

			<Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
				<CollapsibleTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="-ms-2.5 h-11 md:h-7"
							data-testid={`${idPrefix}-more`}
						/>
					}
				>
					<Icon
						name={moreOpen ? 'chevron-down' : 'chevron-right'}
						className="rtl:rotate-180"
					/>
					<Trans>More</Trans>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="flex flex-col gap-5 pt-3">
						{areas.length > 0 ? (
							<SelectField
								id={`${idPrefix}-area`}
								label={<Trans>Seating preference</Trans>}
								optional
								options={areaOptions}
								value={values.areaPrefId || ANY_AREA}
								disabled={disabled}
								onValueChange={(next) =>
									onChange({ areaPrefId: next === ANY_AREA ? '' : next })
								}
							/>
						) : null}
						<TextField
							id={`${idPrefix}-notes`}
							label={<Trans>Notes</Trans>}
							optional
							value={values.notes}
							maxLength={1000}
							disabled={disabled}
							onChange={(event) => onChange({ notes: event.target.value })}
							data-testid={`${idPrefix}-notes`}
						/>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</>
	)
}
