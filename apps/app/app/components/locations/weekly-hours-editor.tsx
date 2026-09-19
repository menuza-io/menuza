'use client'

import { Trans } from '@lingui/macro'
import {
	type DayOfWeek,
	type Shift,
	type WeeklyHours,
} from '@repo/common/location-hours'
import { cn } from '@repo/ui'
import {
	formatTimeOfDay12h,
	TIME_OF_DAY_OPTIONS,
} from '@repo/common/time-of-day'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { useCallback, useMemo, useState } from 'react'

const DAY_LABELS: { day: DayOfWeek; label: string }[] = [
	{ day: 1, label: 'Monday' },
	{ day: 2, label: 'Tuesday' },
	{ day: 3, label: 'Wednesday' },
	{ day: 4, label: 'Thursday' },
	{ day: 5, label: 'Friday' },
	{ day: 6, label: 'Saturday' },
	{ day: 0, label: 'Sunday' },
]

const DEFAULT_SHIFT: Shift = { open: '09:00', close: '17:00' }

type WeeklyHoursEditorProps = {
	value: WeeklyHours
	onChange: (next: WeeklyHours) => void
	/** Used for accessibility / tests; hours submit via JSON payload on parent form. */
	namePrefix: string
	title?: React.ReactNode
}

function cloneWeeklyHours(weekly: WeeklyHours): WeeklyHours {
	return {
		0: [...weekly[0]],
		1: [...weekly[1]],
		2: [...weekly[2]],
		3: [...weekly[3]],
		4: [...weekly[4]],
		5: [...weekly[5]],
		6: [...weekly[6]],
	}
}

function TimeSelect({
	value,
	onValueChange,
	'aria-label': ariaLabel,
}: {
	value: string
	onValueChange: (next: string) => void
	'aria-label': string
}) {
	return (
		<Select value={value} onValueChange={(next) => next && onValueChange(next)}>
			<SelectTrigger className="w-[7.25rem]" aria-label={ariaLabel} size="sm">
				<SelectValue>{formatTimeOfDay12h(value)}</SelectValue>
			</SelectTrigger>
			<SelectContent className="max-h-60">
				{TIME_OF_DAY_OPTIONS.map((option) => (
					<SelectItem key={option} value={option}>
						{formatTimeOfDay12h(option)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

function CopyTimesPopover({
	sourceDay,
	sourceShifts,
	onApply,
}: {
	sourceDay: DayOfWeek
	sourceShifts: Shift[]
	onApply: (targetDays: DayOfWeek[]) => void
}) {
	const [open, setOpen] = useState(false)
	const [selected, setSelected] = useState<Set<DayOfWeek>>(new Set())

	const targets = useMemo(
		() => DAY_LABELS.filter((entry) => entry.day !== sourceDay),
		[sourceDay],
	)

	const toggleDay = (day: DayOfWeek) => {
		setSelected((prev) => {
			const next = new Set(prev)
			if (next.has(day)) next.delete(day)
			else next.add(day)
			return next
		})
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Copy times to other days"
					/>
				}
			>
				<Icon name="copy" className="size-4" />
			</PopoverTrigger>
			<PopoverContent align="end" className="w-56">
				<p className="mb-3 text-sm font-medium">
					<Trans>Copy times to</Trans>
				</p>
				<div className="flex flex-col gap-2">
					{targets.map(({ day, label }) => (
						<label
							key={day}
							className="flex cursor-pointer items-center gap-2 text-sm"
						>
							<Checkbox
								checked={selected.has(day)}
								onCheckedChange={() => toggleDay(day)}
							/>
							{label}
						</label>
					))}
				</div>
				<Button
					type="button"
					className="mt-4 w-full"
					size="sm"
					disabled={selected.size === 0 || sourceShifts.length === 0}
					onClick={() => {
						onApply([...selected])
						setSelected(new Set())
						setOpen(false)
					}}
				>
					<Trans>Apply</Trans>
				</Button>
			</PopoverContent>
		</Popover>
	)
}

export function WeeklyHoursEditor({
	value,
	onChange,
	namePrefix,
	title,
}: WeeklyHoursEditorProps) {
	const updateDay = useCallback(
		(day: DayOfWeek, shifts: Shift[]) => {
			const next = cloneWeeklyHours(value)
			next[day] = shifts
			onChange(next)
		},
		[value, onChange],
	)

	return (
		<div className="flex flex-col gap-1" data-hours-prefix={namePrefix}>
			{title ? <h3 className="mb-3 text-base font-medium">{title}</h3> : null}
			{DAY_LABELS.map(({ day, label }) => {
				const shifts = value[day]
				const isAvailable = shifts.length > 0

				return (
					<div
						key={day}
						className="border-border flex flex-col gap-2 border-b py-4 last:border-b-0"
					>
						<div className="flex flex-wrap items-start gap-3 md:gap-4">
							<div className="flex min-w-[8.5rem] items-center gap-3">
								<Switch
									checked={isAvailable}
									onCheckedChange={(checked) => {
										if (checked) {
											updateDay(day, [{ ...DEFAULT_SHIFT }])
										} else {
											updateDay(day, [])
										}
									}}
									aria-label={`${label} availability`}
								/>
								<span
									className={cn(
										'text-sm font-medium',
										!isAvailable && 'text-muted-foreground',
									)}
								>
									{label}
								</span>
							</div>

							<div className="flex min-w-0 flex-1 flex-col gap-2">
								{!isAvailable ? (
									<p className="text-muted-foreground text-sm">
										<Trans>Unavailable</Trans>
									</p>
								) : (
									shifts.map((shift, shiftIndex) => (
										<div
											key={`${day}-${shiftIndex}`}
											className="flex flex-wrap items-center gap-2"
										>
											<TimeSelect
												value={shift.open}
												onValueChange={(open) => {
													const nextShifts = [...shifts]
													nextShifts[shiftIndex] = { ...shift, open }
													updateDay(day, nextShifts)
												}}
												aria-label={`${label} shift ${shiftIndex + 1} start`}
											/>
											<span className="text-muted-foreground text-sm">—</span>
											<TimeSelect
												value={shift.close}
												onValueChange={(close) => {
													const nextShifts = [...shifts]
													nextShifts[shiftIndex] = { ...shift, close }
													updateDay(day, nextShifts)
												}}
												aria-label={`${label} shift ${shiftIndex + 1} end`}
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												aria-label="Remove time slot"
												onClick={() => {
													const nextShifts = shifts.filter(
														(_, i) => i !== shiftIndex,
													)
													updateDay(
														day,
														nextShifts.length > 0 ? nextShifts : [],
													)
												}}
											>
												<Icon name="x" className="size-4" />
											</Button>
											{shiftIndex === 0 ? (
												<div className="ms-auto flex items-center gap-1">
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label="Add time slot"
														onClick={() => {
															updateDay(day, [
																...shifts,
																{ open: '09:00', close: '17:00' },
															])
														}}
													>
														<Icon name="plus" className="size-4" />
													</Button>
													<CopyTimesPopover
														sourceDay={day}
														sourceShifts={shifts}
														onApply={(targetDays) => {
															const next = cloneWeeklyHours(value)
															const copied = shifts.map((s) => ({ ...s }))
															for (const targetDay of targetDays) {
																next[targetDay] = copied
															}
															onChange(next)
														}}
													/>
												</div>
											) : null}
										</div>
									))
								)}
							</div>
						</div>
					</div>
				)
			})}
		</div>
	)
}
