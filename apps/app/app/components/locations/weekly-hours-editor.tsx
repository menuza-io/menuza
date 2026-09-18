'use client'

import { Trans } from '@lingui/macro'
import { type WeeklyHours } from '@repo/common/location-hours'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'

const DAY_LABELS = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
] as const

type WeeklyHoursEditorProps = {
	value: WeeklyHours
	onChange: (next: WeeklyHours) => void
	namePrefix: string
}

export function WeeklyHoursEditor({
	value,
	onChange,
	namePrefix,
}: WeeklyHoursEditorProps) {
	return (
		<div className="flex flex-col gap-4">
			{DAY_LABELS.map((label, dayIndex) => {
				const day = dayIndex as keyof WeeklyHours
				const shifts = value[day]
				return (
					<div
						key={label}
						className="grid gap-2 border-b pb-4 last:border-b-0 md:grid-cols-[120px_1fr]"
					>
						<p className="text-sm font-medium">{label}</p>
						<div className="flex flex-col gap-2">
							{shifts.map((shift, shiftIndex) => (
								<div
									key={`${day}-${shiftIndex}`}
									className="flex flex-wrap items-end gap-2"
								>
									<div className="space-y-1">
										<Label className="text-xs">
											<Trans>Open</Trans>
										</Label>
										<Input
											name={`${namePrefix}.${day}.${shiftIndex}.open`}
											value={shift.open}
											onChange={(event) => {
												const next = { ...value }
												next[day] = [...shifts]
												next[day][shiftIndex] = {
													...shift,
													open: event.target.value,
												}
												onChange(next)
											}}
											placeholder="09:00"
											className="w-24"
										/>
									</div>
									<div className="space-y-1">
										<Label className="text-xs">
											<Trans>Close</Trans>
										</Label>
										<Input
											name={`${namePrefix}.${day}.${shiftIndex}.close`}
											value={shift.close}
											onChange={(event) => {
												const next = { ...value }
												next[day] = [...shifts]
												next[day][shiftIndex] = {
													...shift,
													close: event.target.value,
												}
												onChange(next)
											}}
											placeholder="17:00"
											className="w-24"
										/>
									</div>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => {
											const next = { ...value }
											next[day] = shifts.filter((_, i) => i !== shiftIndex)
											onChange(next)
										}}
									>
										<Trans>Remove</Trans>
									</Button>
								</div>
							))}
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="w-fit"
								onClick={() => {
									const next = { ...value }
									next[day] = [...shifts, { open: '09:00', close: '17:00' }]
									onChange(next)
								}}
							>
								<Trans>Add shift</Trans>
							</Button>
						</div>
					</div>
				)
			})}
		</div>
	)
}
