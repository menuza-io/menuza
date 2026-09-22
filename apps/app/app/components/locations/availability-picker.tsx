'use client'

import { Trans } from '@lingui/macro'
import {
	type DayOfWeek,
	type WeeklySchedule,
	DAYS_OF_WEEK,
	DAY_LABELS,
} from '@repo/common/location-types'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import React, { useState } from 'react'

// Generate 30-minute time intervals for 24 hours
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
	const hour = Math.floor(i / 2)
	const minute = i % 2 === 0 ? '00' : '30'
	const time24 = `${String(hour).padStart(2, '0')}:${minute}`

	const period = hour >= 12 ? 'PM' : 'AM'
	const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
	const label = `${hour12}:${minute} ${period}`

	return { value: time24, label }
})

interface CopyTimesPopoverProps {
	sourceDay: DayOfWeek
	onApply: (targetDays: DayOfWeek[]) => void
}

function CopyTimesPopover({ sourceDay, onApply }: CopyTimesPopoverProps) {
	const [isOpen, setIsOpen] = useState(false)
	const otherDays = DAYS_OF_WEEK.filter((d) => d !== sourceDay)
	const [selectedDays, setSelectedDays] = useState<DayOfWeek[]>(otherDays)

	const toggleDay = (day: DayOfWeek) => {
		setSelectedDays((prev) =>
			prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
		)
	}

	const selectWeekdays = () => {
		setSelectedDays(
			DAYS_OF_WEEK.filter(
				(d) => d !== 'saturday' && d !== 'sunday' && d !== sourceDay,
			),
		)
	}

	const selectAll = () => {
		setSelectedDays(otherDays)
	}

	const handleApply = () => {
		onApply(selectedDays)
		setIsOpen(false)
	}

	return (
		<Popover open={isOpen} onOpenChange={setIsOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="text-muted-foreground hover:text-foreground size-7"
						title="Copy times to other days"
					>
						<Icon name="copy" className="size-3.5" />
					</Button>
				}
			/>
			<PopoverContent className="w-64 p-3" align="end">
				<div className="space-y-2.5">
					<div className="border-border border-b pb-2">
						{(() => {
							const sourceDayLabel = DAY_LABELS[sourceDay]
							return (
								<h4 className="text-sm">
									<Trans>Copy {sourceDayLabel} hours to...</Trans>
								</h4>
							)
						})()}
						<div className="mt-1 flex gap-2">
							<button
								type="button"
								onClick={selectAll}
								className="text-primary text-xs hover:underline"
							>
								<Trans>All days</Trans>
							</button>
							<span className="text-muted-foreground text-xs">·</span>
							<button
								type="button"
								onClick={selectWeekdays}
								className="text-primary text-xs hover:underline"
							>
								<Trans>Weekdays</Trans>
							</button>
						</div>
					</div>

					<div className="space-y-1.5">
						{otherDays.map((day) => (
							<label
								key={day}
								className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs"
							>
								<Checkbox
									checked={selectedDays.includes(day)}
									onCheckedChange={() => toggleDay(day)}
								/>
								<span className="font-medium">{DAY_LABELS[day]}</span>
							</label>
						))}
					</div>

					{(() => {
						const selectedCount = selectedDays.length
						return (
							<Button
								type="button"
								size="sm"
								className="w-full"
								onClick={handleApply}
								disabled={selectedDays.length === 0}
							>
								<Trans>Apply to {selectedCount} days</Trans>
							</Button>
						)
					})()}
				</div>
			</PopoverContent>
		</Popover>
	)
}

interface AvailabilityPickerProps {
	schedule: WeeklySchedule
	onChange: (schedule: WeeklySchedule) => void
	className?: string
}

export function AvailabilityScheduleEditor({
	schedule,
	onChange,
	className,
}: AvailabilityPickerProps) {
	const handleToggleDay = (day: DayOfWeek, isOpen: boolean) => {
		onChange(
			schedule.map((d) => {
				if (d.day === day) {
					return {
						...d,
						isOpen,
						slots:
							isOpen && d.slots.length === 0
								? [{ start: '09:00', end: '17:00' }]
								: d.slots,
					}
				}
				return d
			}),
		)
	}

	const handleSlotChange = (
		day: DayOfWeek,
		slotIndex: number,
		field: 'start' | 'end',
		value: string,
	) => {
		onChange(
			schedule.map((d) => {
				if (d.day === day) {
					const updatedSlots = [...d.slots]
					const slot = updatedSlots[slotIndex]
					if (slot) {
						updatedSlots[slotIndex] = {
							...slot,
							[field]: value,
						}
					}
					return { ...d, slots: updatedSlots }
				}
				return d
			}),
		)
	}

	const handleAddSlot = (day: DayOfWeek) => {
		onChange(
			schedule.map((d) => {
				if (d.day === day) {
					const lastSlot = d.slots[d.slots.length - 1]
					const newStart = lastSlot ? lastSlot.end : '17:00'
					const newEnd = '21:00'
					return {
						...d,
						slots: [...d.slots, { start: newStart, end: newEnd }],
					}
				}
				return d
			}),
		)
	}

	const handleRemoveSlot = (day: DayOfWeek, slotIndex: number) => {
		onChange(
			schedule.map((d) => {
				if (d.day === day) {
					return {
						...d,
						slots: d.slots.filter((_, idx) => idx !== slotIndex),
					}
				}
				return d
			}),
		)
	}

	const handleCopySchedule = (
		sourceDay: DayOfWeek,
		targetDays: DayOfWeek[],
	) => {
		const source = schedule.find((d) => d.day === sourceDay)
		if (!source) return

		onChange(
			schedule.map((d) => {
				if (targetDays.includes(d.day)) {
					return {
						...d,
						isOpen: source.isOpen,
						slots: source.slots.map((s) => ({ ...s })),
					}
				}
				return d
			}),
		)
	}

	return (
		<div className={cn('divide-border divide-y rounded-md border', className)}>
			{DAYS_OF_WEEK.map((day) => {
				const dayConfig = schedule.find((d) => d.day === day) || {
					day,
					isOpen: false,
					slots: [],
				}

				return (
					<div
						key={day}
						className={cn(
							'flex flex-col gap-2 p-3 transition-colors sm:flex-row sm:items-center sm:gap-4',
							!dayConfig.isOpen && 'bg-muted/20 text-muted-foreground',
						)}
					>
						{/* Day Toggle + Label */}
						<div className="flex w-36 items-center gap-3">
							<Switch
								checked={dayConfig.isOpen}
								onCheckedChange={(checked) => handleToggleDay(day, checked)}
								aria-label={`Toggle ${DAY_LABELS[day]}`}
							/>
							<span className="text-sm font-medium">{DAY_LABELS[day]}</span>
						</div>

						{/* Slots or Closed Indicator */}
						<div className="min-w-0 flex-1">
							{dayConfig.isOpen ? (
								<div className="space-y-2">
									{dayConfig.slots.map((slot, slotIndex) => (
										<div
											key={slotIndex}
											className="flex flex-wrap items-center gap-2"
										>
											<Select
												value={slot.start}
												onValueChange={(val) =>
													val && handleSlotChange(day, slotIndex, 'start', val)
												}
											>
												<SelectTrigger className="h-8 w-28 text-xs">
													<SelectValue />
												</SelectTrigger>
												<SelectContent className="max-h-56">
													{TIME_OPTIONS.map((opt) => (
														<SelectItem key={opt.value} value={opt.value}>
															{opt.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>

											<span className="text-muted-foreground text-xs">-</span>

											<Select
												value={slot.end}
												onValueChange={(val) =>
													val && handleSlotChange(day, slotIndex, 'end', val)
												}
											>
												<SelectTrigger className="h-8 w-28 text-xs">
													<SelectValue />
												</SelectTrigger>
												<SelectContent className="max-h-56">
													{TIME_OPTIONS.map((opt) => (
														<SelectItem key={opt.value} value={opt.value}>
															{opt.label}
														</SelectItem>
													))}
												</SelectContent>
											</Select>

											{dayConfig.slots.length > 1 && (
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground hover:text-destructive size-7"
													onClick={() => handleRemoveSlot(day, slotIndex)}
													title="Remove time slot"
												>
													<Icon name="trash-2" className="size-3.5" />
												</Button>
											)}

											{slotIndex === dayConfig.slots.length - 1 && (
												<div className="flex items-center gap-1">
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														className="text-muted-foreground hover:text-foreground size-7"
														onClick={() => handleAddSlot(day)}
														title="Add time slot"
													>
														<Icon name="plus" className="size-3.5" />
													</Button>

													<CopyTimesPopover
														sourceDay={day}
														onApply={(targetDays) =>
															handleCopySchedule(day, targetDays)
														}
													/>
												</div>
											)}
										</div>
									))}
								</div>
							) : (
								<Badge variant="secondary" className="text-xs font-normal">
									<Trans>Closed</Trans>
								</Badge>
							)}
						</div>
					</div>
				)
			})}
		</div>
	)
}

interface LocationHoursSectionProps {
	storeHours: WeeklySchedule
	onlineHours: WeeklySchedule
	onStoreHoursChange: (hours: WeeklySchedule) => void
	onOnlineHoursChange: (hours: WeeklySchedule) => void
	className?: string
}

export function LocationHoursSection({
	storeHours,
	onlineHours,
	onStoreHoursChange,
	onOnlineHoursChange,
	className,
}: LocationHoursSectionProps) {
	const [syncOnlineWithStore, setSyncOnlineWithStore] = useState(false)

	const handleSyncToggle = (checked: boolean) => {
		setSyncOnlineWithStore(checked)
		if (checked) {
			onOnlineHoursChange(
				JSON.parse(JSON.stringify(storeHours)) as WeeklySchedule,
			)
		}
	}

	return (
		<div className={cn('space-y-4', className)}>
			<Tabs defaultValue="store" className="w-full">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<TabsList className="grid w-full grid-cols-2 sm:w-80">
						<TabsTrigger value="store">
							<Trans>Store Hours</Trans>
						</TabsTrigger>
						<TabsTrigger value="online">
							<Trans>Online Hours</Trans>
						</TabsTrigger>
					</TabsList>

					<div className="flex items-center gap-2">
						<Switch
							id="sync-hours"
							checked={syncOnlineWithStore}
							onCheckedChange={handleSyncToggle}
						/>
						<Label
							htmlFor="sync-hours"
							className="text-muted-foreground text-xs"
						>
							<Trans>Online hours match store hours</Trans>
						</Label>
					</div>
				</div>

				<TabsContent value="store" className="mt-4">
					<div className="mb-2">
						<p className="text-muted-foreground text-xs">
							<Trans>
								Set the physical operating hours when customers can visit this
								restaurant location.
							</Trans>
						</p>
					</div>
					<AvailabilityScheduleEditor
						schedule={storeHours}
						onChange={(newSchedule) => {
							onStoreHoursChange(newSchedule)
							if (syncOnlineWithStore) {
								onOnlineHoursChange(
									JSON.parse(JSON.stringify(newSchedule)) as WeeklySchedule,
								)
							}
						}}
					/>
				</TabsContent>

				<TabsContent value="online" className="mt-4">
					<div className="mb-2">
						<p className="text-muted-foreground text-xs">
							<Trans>
								Set when online ordering, pickup, and delivery are accepted for
								this location.
							</Trans>
						</p>
					</div>
					{syncOnlineWithStore ? (
						<div className="bg-muted/30 flex flex-col items-center justify-center rounded-md border border-dashed p-8 text-center">
							<Icon name="check" className="text-primary mb-2 size-5" />
							<p className="text-sm font-medium">
								<Trans>Online hours are synced with store hours</Trans>
							</p>
							<p className="text-muted-foreground mt-1 text-xs">
								<Trans>
									Toggle off "Online hours match store hours" above to set
									custom online ordering times.
								</Trans>
							</p>
						</div>
					) : (
						<AvailabilityScheduleEditor
							schedule={onlineHours}
							onChange={onOnlineHoursChange}
						/>
					)}
				</TabsContent>
			</Tabs>
		</div>
	)
}
