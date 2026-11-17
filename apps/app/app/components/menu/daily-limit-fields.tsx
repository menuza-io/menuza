import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { DAILY_DISH_MAX_UNITS } from '@repo/common/daily-dish-limits'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { getLocationDisplayName } from '#app/utils/location/locations.ts'
import {
	dailyLimitFormErrors,
	type DailyLimitFormState,
} from '#app/utils/menu/daily-limit-form.ts'
import { type LocationItem } from './location-overrides-card.tsx'

type DailyLimitFieldsProps = {
	/** Unique per form: ids of the inputs. */
	idPrefix: string
	state: DailyLimitFormState
	onChange: (next: DailyLimitFormState) => void
	locations: LocationItem[]
}

/**
 * The daily limit inputs of a dish or an option (#409): one number, whether
 * guests see "Only N left", and a limit of its own (or none) per location.
 * Plain words, no jargon: the count starts again each business day.
 */
export function DailyLimitFields({
	idPrefix,
	state,
	onChange,
	locations,
}: DailyLimitFieldsProps) {
	const { _ } = useLingui()
	const errors = dailyLimitFormErrors(state)
	const hasLimit =
		state.limit.trim() !== '' ||
		Object.values(state.byLocation).some((row) => row.mode === 'limit')
	const setLocation = (
		locationId: string,
		row: DailyLimitFormState['byLocation'][string],
	) => {
		const byLocation = { ...state.byLocation }
		if (row.mode === 'inherit') delete byLocation[locationId]
		else byLocation[locationId] = row
		onChange({ ...state, byLocation })
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-limit`} className="text-sm">
					<Trans>How many can be sold each day</Trans>
				</Label>
				<Input
					id={`${idPrefix}-limit`}
					type="number"
					inputMode="numeric"
					min={1}
					max={DAILY_DISH_MAX_UNITS}
					step={1}
					placeholder={_(t`No limit`)}
					value={state.limit}
					onChange={(event) =>
						onChange({ ...state, limit: event.target.value })
					}
					aria-invalid={errors.limit}
					className="max-w-40"
				/>
				{errors.limit ? (
					<p role="alert" className="text-destructive text-xs">
						<Trans>
							Enter a whole number from 1 to 10,000, or leave it empty.
						</Trans>
					</p>
				) : null}
			</div>

			{hasLimit ? (
				<div className="flex items-center justify-between gap-4">
					<Label
						htmlFor={`${idPrefix}-show-remaining`}
						className="block min-w-0 cursor-pointer space-y-0.5 font-normal"
					>
						<div className="text-foreground text-sm">
							<Trans>Show "Only N left" to guests</Trans>
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>
								Guests see how many are left once there are only a few. Sold out
								is always shown.
							</Trans>
						</p>
					</Label>
					<Switch
						id={`${idPrefix}-show-remaining`}
						checked={state.showRemaining}
						onCheckedChange={(checked) =>
							onChange({ ...state, showRemaining: checked })
						}
					/>
				</div>
			) : null}

			{locations.length > 1 ? (
				<div className="flex flex-col gap-2">
					<div className="text-foreground text-sm">
						<Trans>Different limit at a location</Trans>
					</div>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Leave a location empty to use the limit above, or choose No limit
							there.
						</Trans>
					</p>
					<div className="divide-border divide-y rounded-md border">
						{locations.map((location) => {
							const row = state.byLocation[location.id] ?? {
								mode: 'inherit' as const,
								limit: '',
							}
							const invalid = errors.locations.includes(location.id)
							return (
								<div
									key={location.id}
									className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
								>
									<Label
										htmlFor={`${idPrefix}-loc-${location.id}`}
										className="text-sm font-medium wrap-anywhere"
									>
										{getLocationDisplayName(location.name)}
									</Label>
									<div className="flex items-center gap-3">
										<Input
											id={`${idPrefix}-loc-${location.id}`}
											type="number"
											inputMode="numeric"
											min={1}
											max={DAILY_DISH_MAX_UNITS}
											step={1}
											disabled={row.mode === 'none'}
											placeholder={_(t`Same as above`)}
											value={row.mode === 'limit' ? row.limit : ''}
											onChange={(event) =>
												setLocation(
													location.id,
													event.target.value === ''
														? { mode: 'inherit', limit: '' }
														: { mode: 'limit', limit: event.target.value },
												)
											}
											aria-invalid={invalid}
											className="h-8 w-32 text-xs"
										/>
										<Label
											htmlFor={`${idPrefix}-none-${location.id}`}
											className="flex cursor-pointer items-center gap-2 text-xs font-normal"
										>
											<Checkbox
												id={`${idPrefix}-none-${location.id}`}
												checked={row.mode === 'none'}
												onCheckedChange={(checked) =>
													setLocation(
														location.id,
														checked
															? { mode: 'none', limit: '' }
															: { mode: 'inherit', limit: '' },
													)
												}
											/>
											<Trans>No limit</Trans>
										</Label>
									</div>
									{invalid ? (
										<p role="alert" className="text-destructive text-xs">
											<Trans>Enter a whole number from 1 to 10,000.</Trans>
										</p>
									) : null}
								</div>
							)
						})}
					</div>
				</div>
			) : null}
		</div>
	)
}

/** The card around the fields: for a dish (the default) or for a modifier option. */
export function DailyLimitCard({
	subject = 'dish',
	...props
}: DailyLimitFieldsProps & { subject?: 'dish' | 'option' }) {
	return (
		<Frame className="w-full">
			<FrameHeader>
				<div>
					<FrameTitle className="text-base">
						<Trans>Daily limit</Trans>
					</FrameTitle>
					<FrameDescription>
						{subject === 'option' ? (
							<Trans>
								Stop taking this option once this many are chosen in a day. The
								count starts again each business day.
							</Trans>
						) : (
							<Trans>
								Stop taking orders for this dish once this many are sold in a
								day. The count starts again each business day.
							</Trans>
						)}
					</FrameDescription>
				</div>
			</FrameHeader>
			<FramePanel>
				<DailyLimitFields {...props} />
			</FramePanel>
		</Frame>
	)
}
