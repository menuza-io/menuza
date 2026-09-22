'use client'

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SpecialHour, type TimeSlot } from '@repo/common/location-types'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import React, { useState } from 'react'

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
	const hour = Math.floor(i / 2)
	const minute = i % 2 === 0 ? '00' : '30'
	const time24 = `${String(hour).padStart(2, '0')}:${minute}`
	const period = hour >= 12 ? 'PM' : 'AM'
	const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
	return { value: time24, label: `${hour12}:${minute} ${period}` }
})

interface SpecialHoursPickerProps {
	specialHours: SpecialHour[]
	onChange: (specialHours: SpecialHour[]) => void
	className?: string
}

export function SpecialHoursPicker({
	specialHours,
	onChange,
	className,
}: SpecialHoursPickerProps) {
	const { _ } = useLingui()
	const [isOpen, setIsOpen] = useState(false)
	const [newDate, setNewDate] = useState('')
	const [newIsOpen, setNewIsOpen] = useState(false)
	const [newNote, setNewNote] = useState('')
	const [newSlots, setNewSlots] = useState<TimeSlot[]>([
		{ start: '10:00', end: '16:00' },
	])

	const handleAddOverride = () => {
		if (!newDate) return

		const newEntry: SpecialHour = {
			id: `special_${Date.now()}`,
			date: newDate,
			isOpen: newIsOpen,
			slots: newIsOpen ? newSlots : [],
			note: newNote.trim() || undefined,
		}

		onChange([...specialHours.filter((s) => s.date !== newDate), newEntry])
		setIsOpen(false)
		setNewDate('')
		setNewNote('')
		setNewIsOpen(false)
		setNewSlots([{ start: '10:00', end: '16:00' }])
	}

	const handleRemove = (id: string) => {
		onChange(specialHours.filter((s) => s.id !== id))
	}

	return (
		<div className={cn('space-y-4', className)}>
			<div className="flex items-center justify-between">
				<div>
					<h4 className="text-sm">
						<Trans>Special Hours & Holiday Overrides</Trans>
					</h4>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Override regular operating hours on holidays, events, or closures.
						</Trans>
					</p>
				</div>

				<Dialog open={isOpen} onOpenChange={setIsOpen}>
					<DialogTrigger
						render={
							<Button size="sm" variant="outline">
								<Icon name="plus" className="mr-1.5 size-3.5" />
								<Trans>Add date override</Trans>
							</Button>
						}
					/>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle>
								<Trans>Add Special Hours Override</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									Set custom hours or mark the restaurant closed for a specific
									date.
								</Trans>
							</DialogDescription>
						</DialogHeader>

						<div className="space-y-4 py-2">
							<div className="space-y-1.5">
								<Label htmlFor="special-date">
									<Trans>Date</Trans>
								</Label>
								<Input
									id="special-date"
									type="date"
									value={newDate}
									onChange={(e) => setNewDate(e.target.value)}
									required
								/>
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="special-note">
									<Trans>Label / Reason (Optional)</Trans>
								</Label>
								<Input
									id="special-note"
									placeholder={_(msg`e.g. Christmas Day, Summer Festival`)}
									value={newNote}
									onChange={(e) => setNewNote(e.target.value)}
								/>
							</div>

							<div className="flex items-center justify-between rounded-md border p-3">
								<div className="space-y-0.5">
									<Label htmlFor="special-open">
										<Trans>Location Status</Trans>
									</Label>
									<p className="text-muted-foreground text-xs">
										{newIsOpen
											? _(msg`Open with custom hours`)
											: _(msg`Closed all day`)}
									</p>
								</div>
								<Switch
									id="special-open"
									checked={newIsOpen}
									onCheckedChange={setNewIsOpen}
								/>
							</div>

							{newIsOpen && (
								<div className="space-y-2">
									<Label>
										<Trans>Custom Hours</Trans>
									</Label>
									<div className="flex items-center gap-2">
										<Select
											value={newSlots[0]?.start || '10:00'}
											onValueChange={(val) =>
												val &&
												setNewSlots([
													{
														start: val,
														end: newSlots[0]?.end || '16:00',
													},
												])
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
											value={newSlots[0]?.end || '16:00'}
											onValueChange={(val) =>
												val &&
												setNewSlots([
													{
														start: newSlots[0]?.start || '10:00',
														end: val,
													},
												])
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
									</div>
								</div>
							)}
						</div>

						<DialogFooter>
							<Button variant="outline" onClick={() => setIsOpen(false)}>
								<Trans>Cancel</Trans>
							</Button>
							<Button onClick={handleAddOverride} disabled={!newDate}>
								<Trans>Save override</Trans>
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			{specialHours.length === 0 ? (
				<div className="bg-muted/20 rounded-md border border-dashed p-4 text-center">
					<p className="text-muted-foreground text-xs">
						<Trans>No special hours or holiday closures scheduled.</Trans>
					</p>
				</div>
			) : (
				<div className="divide-border divide-y rounded-md border">
					{specialHours
						.sort((a, b) => a.date.localeCompare(b.date))
						.map((item) => (
							<div
								key={item.id}
								className="flex items-center justify-between p-3"
							>
								<div className="flex items-center gap-3">
									<Icon
										name="calendar"
										className="text-muted-foreground size-4"
									/>
									<div>
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium">{item.date}</span>
											{item.note && (
												<span className="text-muted-foreground text-xs">
													({item.note})
												</span>
											)}
										</div>
										<div className="mt-0.5">
											{item.isOpen ? (
												<span className="text-muted-foreground text-xs">
													{item.slots
														.map((s) => `${s.start} - ${s.end}`)
														.join(', ')}
												</span>
											) : (
												<Badge
													variant="outline"
													className="text-destructive border-destructive/20 text-[10px]"
												>
													<Trans>Closed</Trans>
												</Badge>
											)}
										</div>
									</div>
								</div>

								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="text-muted-foreground hover:text-destructive size-7"
									onClick={() => handleRemove(item.id)}
									title="Remove override"
								>
									<Icon name="trash-2" className="size-3.5" />
								</Button>
							</div>
						))}
				</div>
			)}
		</div>
	)
}
