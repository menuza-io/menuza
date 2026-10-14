import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
	FieldTitle,
} from '@repo/ui/field'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useId } from 'react'
import { type PostingForm } from '#app/utils/hiring/job-posting-form.ts'

export type PickerLocation = { id: string; name: string }

/**
 * Where a job is: every location, or the ones you tick. Applicants choose
 * among them when the job is at more than one. It follows the "Locations"
 * control on a member row: radio cards for the scope, then a checklist.
 */
export function LocationPicker({
	scope,
	locationIds,
	locations,
	canPostEverywhere,
	error,
	onChange,
}: {
	scope: PostingForm['locationScope']
	locationIds: string[]
	locations: PickerLocation[]
	/** A member limited to some locations cannot post for every location. */
	canPostEverywhere: boolean
	error?: string | null
	onChange: (next: {
		locationScope: PostingForm['locationScope']
		locationIds: string[]
	}) => void
}) {
	const { _ } = useLingui()
	const idPrefix = useId()
	const effectiveScope = canPostEverywhere ? scope : 'selected'
	const selected = new Set(locationIds)
	const count = locationIds.filter((id) =>
		locations.some((location) => location.id === id),
	).length

	function toggle(id: string, checked: boolean) {
		const next = new Set(selected)
		if (checked) next.add(id)
		else next.delete(id)
		onChange({
			locationScope: 'selected',
			locationIds: locations
				.filter((location) => next.has(location.id))
				.map((location) => location.id),
		})
	}

	return (
		<FieldSet data-invalid={error ? true : undefined}>
			<FieldLegend variant="label">
				<Trans>Where</Trans>
			</FieldLegend>
			{canPostEverywhere ? (
				<RadioGroup
					value={effectiveScope}
					onValueChange={(value) =>
						onChange({
							locationScope: value as PostingForm['locationScope'],
							locationIds,
						})
					}
					aria-label={_(t`Where the job is`)}
				>
					<FieldLabel htmlFor={`${idPrefix}-all`}>
						<Field orientation="horizontal">
							<FieldContent>
								<FieldTitle>
									<Trans>All locations</Trans>
								</FieldTitle>
								<FieldDescription>
									<Trans>
										Including locations you add later. Applicants choose where.
									</Trans>
								</FieldDescription>
							</FieldContent>
							<RadioGroupItem value="all" id={`${idPrefix}-all`} />
						</Field>
					</FieldLabel>
					<FieldLabel htmlFor={`${idPrefix}-selected`}>
						<Field orientation="horizontal">
							<FieldContent>
								<FieldTitle>
									<Trans>Selected locations</Trans>
								</FieldTitle>
								<FieldDescription>
									{effectiveScope === 'selected' && count > 0
										? plural(count, {
												one: '# location chosen',
												other: '# locations chosen',
											})
										: _(t`Choose one or more.`)}
								</FieldDescription>
							</FieldContent>
							<RadioGroupItem value="selected" id={`${idPrefix}-selected`} />
						</Field>
					</FieldLabel>
				</RadioGroup>
			) : null}

			{effectiveScope === 'selected' ? (
				<FieldGroup>
					{locations.map((location) => {
						const id = `${idPrefix}-${location.id}`
						return (
							<Field key={location.id} orientation="horizontal">
								<Checkbox
									id={id}
									checked={selected.has(location.id)}
									onCheckedChange={(value) =>
										toggle(location.id, value === true)
									}
								/>
								<FieldLabel htmlFor={id}>{location.name}</FieldLabel>
							</Field>
						)
					})}
				</FieldGroup>
			) : null}
			{error ? <FieldError>{error}</FieldError> : null}
		</FieldSet>
	)
}
