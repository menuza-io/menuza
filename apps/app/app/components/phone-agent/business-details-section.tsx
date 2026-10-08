import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type BusinessProfileSettings } from '@repo/phone-agent'
import { AnnotatedSection } from '@repo/ui/annotated-layout'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { FieldErrorText } from './settings-page.tsx'

const WEEKDAYS = [
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
	'sunday',
] as const

const WEEKDAY_LABELS: Record<(typeof WEEKDAYS)[number], MessageDescriptor> = {
	monday: msg`Monday`,
	tuesday: msg`Tuesday`,
	wednesday: msg`Wednesday`,
	thursday: msg`Thursday`,
	friday: msg`Friday`,
	saturday: msg`Saturday`,
	sunday: msg`Sunday`,
}

const DEFAULT_SLOT = { start: '09:00', end: '17:00' }

type ScheduleDay = BusinessProfileSettings['hours'][number]

function weekFrom(hours: readonly ScheduleDay[]): ScheduleDay[] {
	return WEEKDAYS.map(
		(day) =>
			hours.find((entry) => entry.day === day) ?? {
				day,
				isOpen: false,
				slots: [],
			},
	)
}

/**
 * Hours, phone, and address for verticals without their own records. The
 * agent uses them for the open/closed check, transfer hours, and answers.
 * Special hours are kept as saved.
 */
export function BusinessDetailsSection({
	value,
	onChange,
	disabled,
	fieldErrors,
}: {
	value: BusinessProfileSettings
	onChange(next: BusinessProfileSettings): void
	disabled: boolean
	fieldErrors: Record<string, string>
}) {
	const { _ } = useLingui()
	const alwaysOpen = value.hours.length === 0
	const week = weekFrom(value.hours)

	function setDay(day: ScheduleDay['day'], next: Partial<ScheduleDay>) {
		onChange({
			...value,
			hours: week.map((entry) =>
				entry.day === day ? { ...entry, ...next } : entry,
			),
		})
	}

	function setSlot(day: ScheduleDay, key: 'start' | 'end', time: string) {
		const [first = DEFAULT_SLOT, ...rest] = day.slots
		setDay(day.day, { slots: [{ ...first, [key]: time }, ...rest] })
	}

	return (
		<AnnotatedSection
			title={<Trans>Business details</Trans>}
			description={
				<Trans>
					Your hours, phone, and address. The agent quotes them and uses the
					hours to tell when you're open.
				</Trans>
			}
		>
			<Card>
				<CardContent className="flex flex-col gap-5">
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="business-phone">
								<Trans>Business phone</Trans>
							</Label>
							<Input
								id="business-phone"
								type="tel"
								inputMode="tel"
								placeholder="+15551234567"
								value={value.phone ?? ''}
								disabled={disabled}
								aria-invalid={fieldErrors['business.phone'] ? true : undefined}
								onChange={(event) =>
									onChange({
										...value,
										phone: event.target.value.trim() || null,
									})
								}
							/>
							<FieldErrorText error={fieldErrors['business.phone']} />
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="business-timezone">
								<Trans>Time zone</Trans>
							</Label>
							<Input
								id="business-timezone"
								placeholder="America/New_York"
								value={value.timezone}
								disabled={disabled}
								aria-invalid={
									fieldErrors['business.timezone'] ? true : undefined
								}
								onChange={(event) =>
									onChange({ ...value, timezone: event.target.value })
								}
							/>
							<FieldErrorText error={fieldErrors['business.timezone']} />
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="business-address">
							<Trans>Address</Trans>
						</Label>
						<Input
							id="business-address"
							value={value.address ?? ''}
							maxLength={300}
							disabled={disabled}
							onChange={(event) =>
								onChange({ ...value, address: event.target.value || null })
							}
						/>
						<FieldErrorText error={fieldErrors['business.address']} />
					</div>

					<fieldset className="flex flex-col gap-3">
						<legend className="mb-1 text-sm font-medium">
							<Trans>Opening hours</Trans>
						</legend>
						{alwaysOpen ? (
							<div className="flex flex-wrap items-center justify-between gap-3">
								<p className="text-muted-foreground text-sm">
									<Trans>No hours set, so the agent treats you as open.</Trans>
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={disabled}
									onClick={() =>
										onChange({
											...value,
											hours: WEEKDAYS.map((day) => ({
												day,
												isOpen: day !== 'saturday' && day !== 'sunday',
												slots: [DEFAULT_SLOT],
											})),
										})
									}
								>
									<Trans>Set hours</Trans>
								</Button>
							</div>
						) : (
							<>
								{week.map((day) => {
									const dayLabel = _(WEEKDAY_LABELS[day.day])
									const slot = day.slots[0] ?? DEFAULT_SLOT
									return (
										<div
											key={day.day}
											className="flex flex-wrap items-center gap-3"
										>
											<label className="flex w-36 items-center gap-2 text-sm">
												<Checkbox
													checked={day.isOpen}
													disabled={disabled}
													onCheckedChange={(checked) =>
														setDay(day.day, {
															isOpen: checked === true,
															slots: day.slots.length
																? day.slots
																: [DEFAULT_SLOT],
														})
													}
												/>
												{dayLabel}
											</label>
											{day.isOpen ? (
												<div className="flex items-center gap-2">
													<Input
														type="time"
														className="w-32"
														aria-label={_(msg`${dayLabel} opens`)}
														value={slot.start}
														disabled={disabled}
														onChange={(event) =>
															setSlot(day, 'start', event.target.value)
														}
													/>
													<span className="text-muted-foreground text-sm">
														<Trans>to</Trans>
													</span>
													<Input
														type="time"
														className="w-32"
														aria-label={_(msg`${dayLabel} closes`)}
														value={slot.end}
														disabled={disabled}
														onChange={(event) =>
															setSlot(day, 'end', event.target.value)
														}
													/>
												</div>
											) : (
												<span className="text-muted-foreground text-sm">
													<Trans>Closed</Trans>
												</span>
											)}
										</div>
									)
								})}
								<div>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={disabled}
										onClick={() => onChange({ ...value, hours: [] })}
									>
										<Trans>Clear hours</Trans>
									</Button>
								</div>
							</>
						)}
						<FieldErrorText error={fieldErrors['business.hours']} />
					</fieldset>
				</CardContent>
			</Card>
		</AnnotatedSection>
	)
}
