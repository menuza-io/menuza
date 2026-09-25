import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	formatUnavailableUntil,
	getAvailabilityPresets,
	localDateAndTimeToUtc,
} from '@repo/common/menu-types'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
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
import { useEffect, useMemo, useState } from 'react'
import { type LocationItem } from './location-overrides-card.tsx'

export interface MenuAvailabilityCardProps {
	value: string
	onChange: (value: string) => void
	unavailableUntil?: Date | string | null
	onUnavailableUntilChange?: (value: Date | null) => void
	locations?: LocationItem[]
	name?: string
	unavailableUntilName?: string
	className?: string
}

export function MenuAvailabilityCard({
	value,
	onChange,
	unavailableUntil,
	onUnavailableUntilChange,
	locations = [],
	name = 'availabilityStatus',
	unavailableUntilName = 'unavailableUntil',
	className,
}: MenuAvailabilityCardProps) {
	const { _ } = useLingui()

	const primaryLocation = useMemo(
		() => locations.find((l) => l.isDefault) || locations[0] || null,
		[locations],
	)

	const timezone = primaryLocation?.timezone || 'America/New_York'

	// Normalize legacy unavailable_until_tomorrow to unavailable_until
	const normalizedStatus =
		value === 'unavailable_until_tomorrow' ? 'unavailable_until' : value

	const isUnavailableUntil = normalizedStatus === 'unavailable_until'

	const [internalDate, setInternalDate] = useState<Date | null>(() => {
		if (unavailableUntil) {
			const d =
				unavailableUntil instanceof Date
					? unavailableUntil
					: new Date(unavailableUntil)
			return isNaN(d.getTime()) ? null : d
		}
		return null
	})

	// Synchronize with external prop if it changes
	useEffect(() => {
		if (unavailableUntil !== undefined) {
			const d = unavailableUntil
				? unavailableUntil instanceof Date
					? unavailableUntil
					: new Date(unavailableUntil)
				: null
			setInternalDate(d && !isNaN(d.getTime()) ? d : null)
		}
	}, [unavailableUntil])

	const presets = useMemo(() => {
		return getAvailabilityPresets(primaryLocation)
	}, [primaryLocation])

	// Determine preset ID
	const [presetId, setPresetId] = useState<string>(() => {
		if (!internalDate) {
			return presets[0]?.id || '30_min'
		}
		// Match against existing preset dates within 2 minutes tolerance
		const matchingPreset = presets.find((p: any) => {
			if (!p.date) return false
			return Math.abs(p.date.getTime() - internalDate.getTime()) < 2 * 60 * 1000
		})
		return matchingPreset ? matchingPreset.id : 'custom'
	})

	// Custom date/time fields
	const nowParts = useMemo(() => {
		try {
			const formatter = new Intl.DateTimeFormat('en-US', {
				timeZone: timezone,
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false,
			})
			const p: Record<string, string> = {}
			for (const part of formatter.formatToParts(new Date())) {
				p[part.type] = part.value
			}
			return {
				date: `${p.year}-${p.month}-${p.day}`,
				time: `${p.hour}:${p.minute}`,
			}
		} catch {
			const now = new Date()
			return {
				date: now.toISOString().slice(0, 10),
				time: '12:00',
			}
		}
	}, [timezone])

	const [customDate, setCustomDate] = useState<string>(() => {
		if (internalDate) {
			try {
				const formatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezone,
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
				})
				const p: Record<string, string> = {}
				for (const part of formatter.formatToParts(internalDate)) {
					p[part.type] = part.value
				}
				return `${p.year}-${p.month}-${p.day}`
			} catch {
				return nowParts.date
			}
		}
		return nowParts.date
	})

	const [customTime, setCustomTime] = useState<string>(() => {
		if (internalDate) {
			try {
				const formatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezone,
					hour: '2-digit',
					minute: '2-digit',
					hour12: false,
				})
				const p: Record<string, string> = {}
				for (const part of formatter.formatToParts(internalDate)) {
					p[part.type] = part.value
				}
				return `${p.hour}:${p.minute}`
			} catch {
				return nowParts.time
			}
		}
		return nowParts.time
	})

	const updateDate = (date: Date | null) => {
		setInternalDate(date)
		onUnavailableUntilChange?.(date)
	}

	const handleStatusChange = (newStatus: string) => {
		onChange(newStatus)
		if (newStatus === 'unavailable_until') {
			if (!internalDate) {
				const defaultPreset = presets[0]
				if (defaultPreset?.date) {
					setPresetId(defaultPreset.id)
					updateDate(defaultPreset.date)
				}
			}
		} else {
			updateDate(null)
		}
	}

	const handlePresetChange = (newPresetId: string | null) => {
		if (!newPresetId) return
		setPresetId(newPresetId)
		if (newPresetId === 'custom') {
			const d = localDateAndTimeToUtc(customDate, customTime, timezone)
			updateDate(d)
		} else {
			// Refresh presets to get current timestamps
			const currentPresets = getAvailabilityPresets(primaryLocation)
			const match = currentPresets.find((p: any) => p.id === newPresetId)
			if (match?.date) {
				updateDate(match.date)
			}
		}
	}

	const handleCustomDateChange = (val: string) => {
		setCustomDate(val)
		if (val && customTime) {
			const d = localDateAndTimeToUtc(val, customTime, timezone)
			updateDate(d)
		}
	}

	const handleCustomTimeChange = (val: string) => {
		setCustomTime(val)
		if (customDate && val) {
			const d = localDateAndTimeToUtc(customDate, val, timezone)
			updateDate(d)
		}
	}

	const availabilityLabels: Record<string, React.ReactNode> = {
		available: <Trans>Available</Trans>,
		unavailable_until: <Trans>Unavailable Until</Trans>,
		unavailable_until_tomorrow: <Trans>Unavailable Until</Trans>,
		unavailable: <Trans>Unavailable</Trans>,
	}

	return (
		<Frame className={className ?? 'w-full'}>
			<FrameHeader>
				<FrameTitle className="text-base">
					<Trans>Availability Status</Trans>
				</FrameTitle>
				<FrameDescription className="text-xs">
					<Trans>Control overall ordering availability for guests.</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="space-y-4">
				<Select
					value={normalizedStatus}
					onValueChange={(val) => {
						if (val) handleStatusChange(val)
					}}
					name={name}
				>
					<SelectTrigger className="w-full">
						<SelectValue>
							{availabilityLabels[normalizedStatus] ||
								availabilityLabels.available}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="available">
							<div className="flex items-center gap-2">
								<span className="size-2 rounded-full bg-emerald-500" />
								<span>
									<Trans>Available</Trans>
								</span>
							</div>
						</SelectItem>
						<SelectItem value="unavailable_until">
							<div className="flex items-center gap-2">
								<span className="size-2 rounded-full bg-amber-500" />
								<span>
									<Trans>Unavailable Until</Trans>
								</span>
							</div>
						</SelectItem>
						<SelectItem value="unavailable">
							<div className="flex items-center gap-2">
								<span className="bg-destructive size-2 rounded-full" />
								<span>
									<Trans>Unavailable</Trans>
								</span>
							</div>
						</SelectItem>
					</SelectContent>
				</Select>

				{isUnavailableUntil && (
					<div className="border-border/50 space-y-3 border-t pt-2">
						<div className="space-y-1.5">
							<Label className="text-muted-foreground text-xs font-medium">
								<Trans>Becomes available</Trans>
							</Label>
							<Select value={presetId} onValueChange={handlePresetChange}>
								<SelectTrigger className="w-full">
									<SelectValue
										placeholder={_(msg`Select when it becomes available`)}
									/>
								</SelectTrigger>
								<SelectContent>
									{presets.map((preset: any) => (
										<SelectItem key={preset.id} value={preset.id}>
											{preset.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{presetId === 'custom' && (
							<div className="border-border/60 bg-muted/20 space-y-2 rounded-lg border p-2.5">
								<div className="grid grid-cols-2 gap-2">
									<div className="space-y-1">
										<Label
											htmlFor="custom-available-date"
											className="text-muted-foreground text-[11px]"
										>
											<Trans>Date</Trans>
										</Label>
										<Input
											id="custom-available-date"
											type="date"
											min={nowParts.date}
											value={customDate}
											onChange={(e) => handleCustomDateChange(e.target.value)}
											className="h-8 text-xs"
										/>
									</div>
									<div className="space-y-1">
										<Label
											htmlFor="custom-available-time"
											className="text-muted-foreground text-[11px]"
										>
											<Trans>Time</Trans>
										</Label>
										<Input
											id="custom-available-time"
											type="time"
											value={customTime}
											onChange={(e) => handleCustomTimeChange(e.target.value)}
											className="h-8 text-xs"
										/>
									</div>
								</div>
							</div>
						)}

						{internalDate && (
							<p className="text-muted-foreground flex items-center gap-1.5 text-xs">
								<Icon
									name="clock"
									className="size-3.5 shrink-0 text-amber-500"
								/>
								<span>
									<Trans>
										Unavailable until{' '}
										<strong className="text-foreground font-medium">
											{formatUnavailableUntil(internalDate, timezone)}
										</strong>
									</Trans>
								</span>
							</p>
						)}
					</div>
				)}

				<input
					type="hidden"
					name={unavailableUntilName}
					value={
						isUnavailableUntil && internalDate ? internalDate.toISOString() : ''
					}
				/>
			</FramePanel>
		</Frame>
	)
}
