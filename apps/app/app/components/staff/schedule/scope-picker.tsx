import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Checkbox } from '@repo/ui/checkbox'
import { Field, FieldLabel, FieldLegend, FieldSet } from '@repo/ui/field'
import { Label } from '@repo/ui/label'
import { PositionDot } from '@repo/ui/position-color'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useId } from 'react'
import { type ScopeState } from '#app/utils/staffing/schedule-form.ts'
import { type ScheduleWeek } from '#app/utils/staffing/schedule-types.ts'
import { positionName } from '#app/utils/staffing/schedule-view.ts'
import { staffDisplayName } from '#app/utils/staffing/staff-format.ts'

function toggle(list: string[], id: string, on: boolean): string[] {
	return on
		? [...list.filter((item) => item !== id), id]
		: list.filter((item) => item !== id)
}

/** Which shifts a copy, template or recommendation takes: everything, some positions, or some people. */
export function ScopePicker({
	value,
	onChange,
	week,
	locale,
}: {
	value: ScopeState
	onChange: (next: ScopeState) => void
	week: Pick<ScheduleWeek, 'positions' | 'people'>
	locale: string
}) {
	const { _ } = useLingui()
	const id = useId()
	const people = week.people
		.filter((person) => person.status !== 'terminated')
		.map((person) => ({
			id: person.id,
			name: staffDisplayName(person, locale),
		}))
		.sort((a, b) => a.name.localeCompare(b.name, locale))
	return (
		<FieldSet>
			<FieldLegend variant="label">
				<Trans>Which shifts</Trans>
			</FieldLegend>
			<RadioGroup
				value={value.mode}
				onValueChange={(mode) =>
					onChange({ ...value, mode: mode as ScopeState['mode'] })
				}
				aria-label={_(t`Which shifts`)}
			>
				{(
					[
						['all', _(t`Everything`)],
						['positions', _(t`Some positions`)],
						['people', _(t`Some people`)],
					] as const
				).map(([mode, label]) => (
					<Label key={mode} className="min-h-11 w-full">
						<RadioGroupItem value={mode} />
						{label}
					</Label>
				))}
			</RadioGroup>
			{value.mode === 'positions' ? (
				<div className="border-border flex flex-col rounded-lg border">
					{week.positions.map((position) => {
						const checkId = `${id}-p-${position.id}`
						return (
							<div
								key={position.id}
								className="border-border border-b px-3 last:border-b-0"
							>
								<Field orientation="horizontal" className="min-h-11">
									<Checkbox
										id={checkId}
										checked={value.positionIds.includes(position.id)}
										onCheckedChange={(on) =>
											onChange({
												...value,
												positionIds: toggle(
													value.positionIds,
													position.id,
													Boolean(on),
												),
											})
										}
									/>
									<FieldLabel htmlFor={checkId} className="py-2">
										<PositionDot colorKey={position.colorKey} />
										{positionName(position, locale)}
									</FieldLabel>
								</Field>
							</div>
						)
					})}
				</div>
			) : null}
			{value.mode === 'people' ? (
				<div className="border-border flex max-h-56 flex-col overflow-y-auto rounded-lg border">
					{people.map((person) => {
						const checkId = `${id}-s-${person.id}`
						return (
							<div
								key={person.id}
								className="border-border border-b px-3 last:border-b-0"
							>
								<Field orientation="horizontal" className="min-h-11">
									<Checkbox
										id={checkId}
										checked={value.staffIds.includes(person.id)}
										onCheckedChange={(on) =>
											onChange({
												...value,
												staffIds: toggle(
													value.staffIds,
													person.id,
													Boolean(on),
												),
											})
										}
									/>
									<FieldLabel htmlFor={checkId} className="py-2">
										{person.name}
									</FieldLabel>
								</Field>
							</div>
						)
					})}
				</div>
			) : null}
		</FieldSet>
	)
}
