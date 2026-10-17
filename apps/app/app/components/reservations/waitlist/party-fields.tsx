import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'

export type PartyFieldValues = {
	displayName: string
	partySize: number
	phone: string
	smsOptIn: boolean
	notes: string
	areaPrefId: string
}

const QUICK_SIZES = [1, 2, 3, 4, 5, 6, 8] as const

export function PartyFields({
	idPrefix,
	values,
	onChange,
	areas = [],
	disabled = false,
}: {
	idPrefix: string
	values: PartyFieldValues
	onChange: (patch: Partial<PartyFieldValues>) => void
	areas?: ReadonlyArray<{ id: string; name: string }>
	disabled?: boolean
}) {
	const { t } = useLingui()
	return (
		<>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-name`}>
					<Trans>Name</Trans>
				</Label>
				<Input
					id={`${idPrefix}-name`}
					value={values.displayName}
					maxLength={120}
					required
					disabled={disabled}
					onChange={(event) => onChange({ displayName: event.target.value })}
					data-testid={`${idPrefix}-name`}
				/>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-size`}>
					<Trans>Party size</Trans>
				</Label>
				<div className="flex flex-wrap items-center gap-1.5">
					{QUICK_SIZES.map((size) => (
						<Button
							key={size}
							type="button"
							size="sm"
							variant={values.partySize === size ? 'default' : 'outline'}
							disabled={disabled}
							aria-pressed={values.partySize === size}
							onClick={() => onChange({ partySize: size })}
							data-testid={`${idPrefix}-size-${size}`}
						>
							{size}
						</Button>
					))}
					<Input
						id={`${idPrefix}-size`}
						type="number"
						min={1}
						max={99}
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
						className="h-8 w-20"
						data-testid={`${idPrefix}-size`}
					/>
				</div>
			</div>

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-phone`}>
					<Trans>Phone (optional)</Trans>
				</Label>
				<Input
					id={`${idPrefix}-phone`}
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
				<label className="flex items-start gap-2 text-xs">
					<input
						type="checkbox"
						className="mt-0.5"
						checked={values.smsOptIn}
						disabled={disabled || !values.phone.trim()}
						onChange={(event) => onChange({ smsOptIn: event.target.checked })}
						data-testid={`${idPrefix}-sms-opt-in`}
					/>
					<span>
						<Trans>Text this guest when their table is ready.</Trans>
						<span className="text-muted-foreground block">
							<Trans>
								Texts are only sent to US phone numbers. For other numbers, tell
								the guest in person.
							</Trans>
						</span>
					</span>
				</label>
			</div>

			{areas.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={`${idPrefix}-area`}>
						<Trans>Seating preference (optional)</Trans>
					</Label>
					<select
						id={`${idPrefix}-area`}
						value={values.areaPrefId}
						disabled={disabled}
						onChange={(event) => onChange({ areaPrefId: event.target.value })}
						className="border-input bg-background h-9 rounded-md border px-2.5 text-sm"
						data-testid={`${idPrefix}-area`}
					>
						<option value="">{t`Any area`}</option>
						{areas.map((area) => (
							<option key={area.id} value={area.id}>
								{area.name}
							</option>
						))}
					</select>
				</div>
			) : null}

			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-notes`}>
					<Trans>Notes (optional)</Trans>
				</Label>
				<Input
					id={`${idPrefix}-notes`}
					value={values.notes}
					maxLength={1000}
					disabled={disabled}
					onChange={(event) => onChange({ notes: event.target.value })}
					data-testid={`${idPrefix}-notes`}
				/>
			</div>
		</>
	)
}
