import {
	type DayOfWeek,
	type DeliveryConfig,
	type SpecialHour,
	type WeeklySchedule,
	DEFAULT_WEEKLY_SCHEDULE,
} from './location-types.ts'

export interface LocationOrderingAvailability {
	isOpen: boolean
	status: 'open' | 'closed' | 'closing_soon'
	reason?: string
	nextOpen?: string
	currentLocalTime: string // "HH:MM"
	currentLocalDate: string // "YYYY-MM-DD"
	dayOfWeek: DayOfWeek
	estimatedPrepTime: number
	estimatedDeliveryTime?: { min: number; max: number }
}

export function isLocationOpenForOrdering(
	location: {
		timezone?: string | null
		onlineHours?: WeeklySchedule | null
		storeHours?: WeeklySchedule | null
		specialHours?: SpecialHour[] | null
		prepTime?: number | null
		deliveryConfig?: DeliveryConfig | null
		isActive?: boolean | null
	},
	currentTime: Date = new Date(),
): LocationOrderingAvailability {
	const timezone = location.timezone || 'UTC'
	const prepTime = location.prepTime || 15
	const deliveryTime = location.deliveryConfig
		? {
				min: location.deliveryConfig.estimatedDeliveryTimeMin || 25,
				max: location.deliveryConfig.estimatedDeliveryTimeMax || 45,
			}
		: { min: 25, max: 45 }

	// Format current time into location's timezone
	const parts: Record<string, string> = {}
	try {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			weekday: 'long',
		})
		for (const p of formatter.formatToParts(currentTime)) {
			parts[p.type] = p.value
		}
	} catch {
		// Fallback to UTC if timezone is invalid
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			weekday: 'long',
		})
		for (const p of formatter.formatToParts(currentTime)) {
			parts[p.type] = p.value
		}
	}

	const dayOfWeek = (parts.weekday?.toLowerCase() ?? 'monday') as DayOfWeek
	const currentLocalDate = `${parts.year}-${parts.month}-${parts.day}`
	const currentLocalTime = `${parts.hour}:${parts.minute}`

	const baseResult = {
		currentLocalTime,
		currentLocalDate,
		dayOfWeek,
		estimatedPrepTime: prepTime,
		estimatedDeliveryTime: deliveryTime,
	}

	if (location.isActive === false) {
		return {
			...baseResult,
			isOpen: false,
			status: 'closed',
			reason: 'Location is currently inactive',
		}
	}

	// 1. Check special hours date override
	if (location.specialHours && Array.isArray(location.specialHours)) {
		const special = location.specialHours.find(
			(s) => s.date === currentLocalDate,
		)
		if (special) {
			if (!special.isOpen) {
				return {
					...baseResult,
					isOpen: false,
					status: 'closed',
					reason: special.note || 'Closed for holiday / special hours',
				}
			}
			// Check slots in special hour
			const activeSlot = special.slots?.find(
				(slot) =>
					slot.start <= currentLocalTime && currentLocalTime <= slot.end,
			)
			if (activeSlot) {
				const isClosingSoon = checkClosingSoon(currentLocalTime, activeSlot.end)
				return {
					...baseResult,
					isOpen: true,
					status: isClosingSoon ? 'closing_soon' : 'open',
				}
			} else {
				return {
					...baseResult,
					isOpen: false,
					status: 'closed',
					reason: 'Outside special hours',
				}
			}
		}
	}

	// 2. Check weekly schedule (onlineHours preferred, fallback to storeHours)
	const schedule = location.onlineHours || location.storeHours
	if (!schedule || !Array.isArray(schedule) || schedule.length === 0) {
		// Default to open if no schedule specified
		return {
			...baseResult,
			isOpen: true,
			status: 'open',
		}
	}

	const daySchedule = schedule.find((d) => d.day === dayOfWeek)
	if (!daySchedule || !daySchedule.isOpen || !daySchedule.slots?.length) {
		return {
			...baseResult,
			isOpen: false,
			status: 'closed',
			reason: 'Closed today',
		}
	}

	// Check if within any active slot today
	const matchingSlot = daySchedule.slots.find(
		(slot) => slot.start <= currentLocalTime && currentLocalTime <= slot.end,
	)

	if (matchingSlot) {
		const isClosingSoon = checkClosingSoon(currentLocalTime, matchingSlot.end)
		return {
			...baseResult,
			isOpen: true,
			status: isClosingSoon ? 'closing_soon' : 'open',
		}
	}

	// Outside today's slots - check if earlier than first slot or between slots
	const sortedSlots = [...daySchedule.slots].sort((a, b) =>
		a.start.localeCompare(b.start),
	)
	const upcomingSlotToday = sortedSlots.find(
		(slot) => slot.start > currentLocalTime,
	)

	if (upcomingSlotToday) {
		return {
			...baseResult,
			isOpen: false,
			status: 'closed',
			nextOpen: `Opens today at ${formatTimeDisplay(upcomingSlotToday.start)}`,
			reason: `Opens at ${formatTimeDisplay(upcomingSlotToday.start)}`,
		}
	}

	return {
		...baseResult,
		isOpen: false,
		status: 'closed',
		reason: 'Closed for the day',
	}
}

function checkClosingSoon(currentTime: string, endTime: string): boolean {
	const [currH = 0, currM = 0] = currentTime.split(':').map(Number)
	const [endH = 0, endM = 0] = endTime.split(':').map(Number)
	const diffMinutes = endH * 60 + endM - (currH * 60 + currM)
	return diffMinutes > 0 && diffMinutes <= 30
}

export function formatTimeDisplay(timeStr: string): string {
	const [h = 0, m = 0] = timeStr.split(':').map(Number)
	const period = h >= 12 ? 'PM' : 'AM'
	const displayH = h % 12 === 0 ? 12 : h % 12
	return `${displayH}:${m.toString().padStart(2, '0')} ${period}`
}

export function localDateAndTimeToUtc(
	dateStr: string,
	timeStr: string,
	timezone: string = 'America/New_York',
): Date {
	const approx = new Date(`${dateStr}T${timeStr}:00Z`)
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false,
		}).formatToParts(approx)

		const p: Record<string, string> = {}
		for (const part of parts) p[part.type] = part.value
		const localIso = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`
		const diff = approx.getTime() - new Date(localIso).getTime()
		return new Date(approx.getTime() + diff)
	} catch {
		return approx
	}
}

function parseSchedule(val: unknown): WeeklySchedule | null {
	if (!val) return null
	if (Array.isArray(val)) return val as WeeklySchedule
	if (typeof val === 'string') {
		try {
			const parsed = JSON.parse(val)
			if (Array.isArray(parsed)) return parsed as WeeklySchedule
		} catch {}
	}
	return null
}

const DAYS_ORDER: DayOfWeek[] = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
]

export interface AvailabilityPresetOption {
	id: '30_min' | '1_hour' | 'today_closing' | 'tomorrow_opening' | 'custom'
	label: string
	timeDisplay: string
	date: Date | null
}

export function getAvailabilityPresets(
	location?: {
		timezone?: string | null
		storeHours?: unknown
		onlineHours?: unknown
	} | null,
	currentTime: Date = new Date(),
): AvailabilityPresetOption[] {
	const timezone = location?.timezone || 'America/New_York'
	const now = currentTime instanceof Date ? currentTime : new Date(currentTime)

	// Get local date/time parts in location timezone
	let parts: Record<string, string> = {}
	try {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			weekday: 'long',
		})
		for (const p of formatter.formatToParts(now)) {
			parts[p.type] = p.value
		}
	} catch {
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			weekday: 'long',
		})
		for (const p of formatter.formatToParts(now)) {
			parts[p.type] = p.value
		}
	}

	const todayDayOfWeek = (parts.weekday?.toLowerCase() ?? 'monday') as DayOfWeek
	const todayDateStr = `${parts.year}-${parts.month}-${parts.day}`
	const currentLocalTime = `${parts.hour}:${parts.minute}`

	const schedule =
		parseSchedule(location?.onlineHours) ||
		parseSchedule(location?.storeHours) ||
		DEFAULT_WEEKLY_SCHEDULE

	const presets: AvailabilityPresetOption[] = []

	// 1. In 30 minutes
	const date30 = new Date(now.getTime() + 30 * 60 * 1000)
	const timeDisplay30 = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	}).format(date30)
	presets.push({
		id: '30_min',
		label: `In 30 minutes (${timeDisplay30})`,
		timeDisplay: timeDisplay30,
		date: date30,
	})

	// 2. In 1 hour
	const date60 = new Date(now.getTime() + 60 * 60 * 1000)
	const timeDisplay60 = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	}).format(date60)
	presets.push({
		id: '1_hour',
		label: `In 1 hour (${timeDisplay60})`,
		timeDisplay: timeDisplay60,
		date: date60,
	})

	// 3. Today at closing time
	const todayDaySchedule = schedule.find((d) => d.day === todayDayOfWeek)
	if (todayDaySchedule?.isOpen && todayDaySchedule.slots?.length) {
		const sortedSlots = [...todayDaySchedule.slots].sort((a, b) =>
			a.end.localeCompare(b.end),
		)
		const closingTimeStr = sortedSlots[sortedSlots.length - 1]?.end
		if (closingTimeStr) {
			const closingDate = localDateAndTimeToUtc(
				todayDateStr,
				closingTimeStr,
				timezone,
			)
			// Only offer if closing is still in the future
			if (closingDate.getTime() > now.getTime()) {
				const closingDisplay = formatTimeDisplay(closingTimeStr)
				presets.push({
					id: 'today_closing',
					label: `Today at ${closingDisplay}`,
					timeDisplay: closingDisplay,
					date: closingDate,
				})
			}
		}
	}

	// 4. Tomorrow at opening time
	const tomorrowApprox = new Date(now.getTime() + 24 * 60 * 60 * 1000)
	let tomorrowParts: Record<string, string> = {}
	try {
		const tomorrowFormatter = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			weekday: 'long',
		})
		for (const p of tomorrowFormatter.formatToParts(tomorrowApprox)) {
			tomorrowParts[p.type] = p.value
		}
	} catch {
		tomorrowParts = parts
	}

	const tomorrowDayOfWeek = (tomorrowParts.weekday?.toLowerCase() ??
		'tuesday') as DayOfWeek
	const tomorrowDateStr = `${tomorrowParts.year}-${tomorrowParts.month}-${tomorrowParts.day}`

	const tomorrowDaySchedule = schedule.find((d) => d.day === tomorrowDayOfWeek)
	if (tomorrowDaySchedule?.isOpen && tomorrowDaySchedule.slots?.length) {
		const sortedSlots = [...tomorrowDaySchedule.slots].sort((a, b) =>
			a.start.localeCompare(b.start),
		)
		const openingTimeStr = sortedSlots[0]?.start
		if (openingTimeStr) {
			const openingDate = localDateAndTimeToUtc(
				tomorrowDateStr,
				openingTimeStr,
				timezone,
			)
			const openingDisplay = formatTimeDisplay(openingTimeStr)
			presets.push({
				id: 'tomorrow_opening',
				label: `Tomorrow at ${openingDisplay}`,
				timeDisplay: openingDisplay,
				date: openingDate,
			})
		}
	} else {
		// If tomorrow is closed, check next days in schedule
		let foundNextDay = false
		for (let offset = 2; offset <= 7; offset++) {
			const nextApprox = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000)
			const nextParts: Record<string, string> = {}
			try {
				const nextFormatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezone,
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
					weekday: 'long',
				})
				for (const p of nextFormatter.formatToParts(nextApprox)) {
					nextParts[p.type] = p.value
				}
				const nextDayOfWeek = nextParts.weekday?.toLowerCase() as DayOfWeek
				const nextSchedule = schedule.find((d) => d.day === nextDayOfWeek)
				if (nextSchedule?.isOpen && nextSchedule.slots?.length) {
					const openingStr = [...nextSchedule.slots].sort((a, b) =>
						a.start.localeCompare(b.start),
					)[0]?.start
					if (openingStr) {
						const nextDateStr = `${nextParts.year}-${nextParts.month}-${nextParts.day}`
						const nextDate = localDateAndTimeToUtc(
							nextDateStr,
							openingStr,
							timezone,
						)
						const openDisplay = formatTimeDisplay(openingStr)
						const dayCapitalized =
							(nextParts.weekday?.charAt(0).toUpperCase() ?? '') +
							(nextParts.weekday?.slice(1) ?? '')
						presets.push({
							id: 'tomorrow_opening',
							label: `${dayCapitalized} at ${openDisplay}`,
							timeDisplay: openDisplay,
							date: nextDate,
						})
						foundNextDay = true
						break
					}
				}
			} catch {}
		}
		if (!foundNextDay) {
			// Fallback: tomorrow at 9:00 AM
			const fallbackDate = localDateAndTimeToUtc(
				tomorrowDateStr,
				'09:00',
				timezone,
			)
			presets.push({
				id: 'tomorrow_opening',
				label: `Tomorrow at 9:00 AM`,
				timeDisplay: '9:00 AM',
				date: fallbackDate,
			})
		}
	}

	// 5. Custom
	presets.push({
		id: 'custom',
		label: 'Custom',
		timeDisplay: '',
		date: null,
	})

	return presets
}

export function formatUnavailableUntil(
	unavailableUntil: Date | string | number,
	timezone: string = 'America/New_York',
): string {
	const date =
		unavailableUntil instanceof Date
			? unavailableUntil
			: new Date(unavailableUntil)
	if (isNaN(date.getTime())) return ''

	const now = new Date()

	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
	})

	const nowParts: Record<string, string> = {}
	const dateParts: Record<string, string> = {}
	try {
		for (const p of formatter.formatToParts(now)) nowParts[p.type] = p.value
		for (const p of formatter.formatToParts(date)) dateParts[p.type] = p.value
	} catch {
		return date.toLocaleDateString()
	}

	const timeStr =
		`${dateParts.hour}:${dateParts.minute} ${dateParts.dayPeriod ?? ''}`.trim()
	const isSameDay =
		nowParts.year === dateParts.year &&
		nowParts.month === dateParts.month &&
		nowParts.day === dateParts.day

	if (isSameDay) {
		return `Today at ${timeStr}`
	}

	// Check tomorrow
	const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
	const tomorrowParts: Record<string, string> = {}
	for (const p of formatter.formatToParts(tomorrow)) {
		tomorrowParts[p.type] = p.value
	}
	const isTomorrow =
		tomorrowParts.year === dateParts.year &&
		tomorrowParts.month === dateParts.month &&
		tomorrowParts.day === dateParts.day

	if (isTomorrow) {
		return `Tomorrow at ${timeStr}`
	}

	const monthName = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		month: 'short',
	}).format(date)

	return `${monthName} ${dateParts.day} at ${timeStr}`
}

export function isUnavailableUntilExpired(
	status?: string | null,
	unavailableUntil?: Date | string | number | null,
	currentTime: Date = new Date(),
): boolean {
	if (!status || status === 'available') return true
	if (status === 'unavailable') return false
	if (
		status === 'unavailable_until' ||
		status === 'unavailable_until_tomorrow'
	) {
		if (!unavailableUntil) return false
		const target =
			unavailableUntil instanceof Date
				? unavailableUntil
				: new Date(unavailableUntil)
		if (isNaN(target.getTime())) return false
		return target.getTime() <= currentTime.getTime()
	}
	return false
}
