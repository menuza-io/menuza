import {
	type DayOfWeek,
	type DeliveryConfig,
	type SpecialHour,
	type WeeklySchedule,
	DEFAULT_WEEKLY_SCHEDULE,
} from './location-types.ts'

/**
 * Overnight hours are modelled by splitting at midnight: Friday 18:00-23:59 and
 * Saturday 00:00-02:00. A slot whose end is not after its start (for example
 * 22:00-02:00) is not an overnight slot; it is never open, the same rule the
 * phone agent settings enforce. Slot times are minute-granular and the end is
 * inclusive, so 23:59 covers the whole last minute of the day.
 */
export const END_OF_DAY = '23:59'
export const START_OF_DAY = '00:00'

/** Adds calendar days to a `YYYY-MM-DD` date. Calendar math, so DST-safe. */
export function addLocalDays(dateStr: string, days: number) {
	const [y = 1970, m = 1, d = 1] = dateStr.split('-').map(Number)
	const date = new Date(Date.UTC(y, m - 1, d + days))
	const weekday = DAYS_ORDER[date.getUTCDay()] ?? 'monday'
	const pad = (n: number) => String(n).padStart(2, '0')
	return {
		date: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
		day: weekday,
	}
}

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
	/**
	 * Set while an operator has paused online ordering. `until` is the ISO end
	 * of the pause (null: until someone resumes it); `resumesAt` is when orders
	 * can actually be placed again: the end of the pause, or the next opening
	 * after it when the pause runs past closing (null when unknown or never).
	 */
	paused?: { until: string | null; resumesAt: string | null }
	/** Extra minutes busy mode adds to `estimatedPrepTime` right now. */
	busyExtraPrepMinutes?: number
}

/**
 * An operator's "pause online orders" switch as published to Sites and the
 * region. Only an active pause is published; `until` null means it lasts until
 * someone resumes it. Evaluated against the clock, so a cached copy stops
 * pausing on its own when the time passes.
 */
export type OrderingPause = { until: string | null }

/**
 * Busy mode: extra minutes added to every prep estimate (and to the earliest
 * scheduled time) while it lasts. `until` null means until someone turns it
 * off.
 */
export type BusyMode = { extraPrepMinutes: number; until: string | null }

/**
 * How long a pause lasts, as offered in the App's Orders page and on Station.
 * The end time is worked out on the App from the location's time zone and
 * hours (`resolveControlUntil`).
 */
export const ORDERING_PAUSE_DURATIONS = [
	'15m',
	'30m',
	'60m',
	'rest_of_day',
	'until_resumed',
] as const
export type OrderingPauseDuration = (typeof ORDERING_PAUSE_DURATIONS)[number]

/** Longest pause or busy period an operator can set with an end time. */
export const MAX_ORDERING_PAUSE_MS = 7 * 24 * 60 * 60 * 1000
/** Busy mode choices offered to operators, in minutes. */
export const BUSY_EXTRA_PREP_CHOICES = [10, 20, 30] as const
export const MAX_BUSY_EXTRA_PREP_MINUTES = 120

type PauseSource = {
	orderingPause?: OrderingPause | null
	busyMode?: BusyMode | null
}

function untilMs(until: string | null | undefined): number | null {
	if (until == null) return null
	const ms = new Date(until).getTime()
	return Number.isNaN(ms) ? Number.NaN : ms
}

/**
 * True while the location's online ordering pause is in force at `now`. A
 * malformed end time counts as no pause, so a bad value never blocks orders.
 */
export function isOrderingPaused(
	location: PauseSource,
	now: Date = new Date(),
): boolean {
	const pause = location.orderingPause
	if (!pause) return false
	const end = untilMs(pause.until)
	if (end === null) return true
	return !Number.isNaN(end) && end > now.getTime()
}

/** Busy mode minutes in force at `now` (0 when off or expired). */
export function activeBusyExtraPrepMinutes(
	location: PauseSource,
	now: Date = new Date(),
): number {
	const busy = location.busyMode
	if (!busy) return 0
	const minutes = Math.min(
		MAX_BUSY_EXTRA_PREP_MINUTES,
		Math.max(0, Math.round(busy.extraPrepMinutes || 0)),
	)
	if (minutes === 0) return 0
	const end = untilMs(busy.until)
	if (end === null) return minutes
	return !Number.isNaN(end) && end > now.getTime() ? minutes : 0
}

type ScheduleSource = {
	timezone?: string | null
	onlineHours?: WeeklySchedule | null
	storeHours?: WeeklySchedule | null
	specialHours?: SpecialHour[] | null
	isActive?: boolean | null
}

/**
 * The first moment at or after `from` that the location's online hours are
 * open, looking up to eight local days ahead. Ignores any pause. Returns
 * `from` when the location publishes no schedule (always open) and null when
 * it is inactive or never opens in that window.
 */
export function nextOrderingOpenAt(
	location: ScheduleSource,
	from: Date,
): Date | null {
	if (location.isActive === false) return null
	const timezone = location.timezone || 'UTC'
	const schedule = location.onlineHours || location.storeHours
	if (!Array.isArray(schedule) || schedule.length === 0) return from
	const startDate = localDateOf(from, timezone)
	const fromMs = from.getTime()
	for (let offset = 0; offset <= 8; offset += 1) {
		const day = addLocalDays(startDate, offset)
		const special = Array.isArray(location.specialHours)
			? location.specialHours.find((entry) => entry.date === day.date)
			: undefined
		let slots: SpecialHour['slots'] = []
		if (special) {
			slots = special.isOpen ? (special.slots ?? []) : []
		} else {
			const daySchedule = schedule.find((entry) => entry.day === day.day)
			slots = daySchedule?.isOpen ? (daySchedule.slots ?? []) : []
		}
		const sorted = [...slots]
			.filter((slot) => slot.start <= slot.end)
			.sort((a, b) => a.start.localeCompare(b.start))
		for (const slot of sorted) {
			const start = localDateAndTimeToUtc(day.date, slot.start, timezone)
			// Slot ends are inclusive to the minute (23:59 covers the last minute).
			const end =
				localDateAndTimeToUtc(day.date, slot.end, timezone).getTime() + 60_000
			if (end <= fromMs) continue
			return start.getTime() > fromMs ? start : from
		}
	}
	return null
}

function localDateOf(instant: Date, timezone: string): string {
	try {
		const parts: Record<string, string> = {}
		for (const p of new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(instant)) {
			parts[p.type] = p.value
		}
		return `${parts.year}-${parts.month}-${parts.day}`
	} catch {
		return instant.toISOString().slice(0, 10)
	}
}

/**
 * End of "the rest of today" for a pause chosen now: the start of the next
 * local day, or, when the location stays open past midnight (a slot that
 * starts at 00:00), the end of that overnight stretch. DST-safe: built from
 * calendar dates in the location time zone, never `now + 24h`.
 */
export function endOfOrderingDay(
	location: ScheduleSource,
	now: Date = new Date(),
): Date {
	const timezone = location.timezone || 'UTC'
	const tomorrow = addLocalDays(localDateOf(now, timezone), 1)
	const midnight = localDateAndTimeToUtc(tomorrow.date, START_OF_DAY, timezone)
	const special = Array.isArray(location.specialHours)
		? location.specialHours.find((entry) => entry.date === tomorrow.date)
		: undefined
	const schedule = location.onlineHours || location.storeHours
	let slots: SpecialHour['slots'] = []
	if (special) {
		slots = special.isOpen ? (special.slots ?? []) : []
	} else if (Array.isArray(schedule)) {
		const daySchedule = schedule.find((entry) => entry.day === tomorrow.day)
		slots = daySchedule?.isOpen ? (daySchedule.slots ?? []) : []
	}
	const overnight = slots.find(
		(slot) => slot.start === START_OF_DAY && slot.end > START_OF_DAY,
	)
	if (!overnight) return midnight
	return new Date(
		localDateAndTimeToUtc(tomorrow.date, overnight.end, timezone).getTime() +
			60_000,
	)
}

/** "7:30 PM" (same day) or "Thu 7:30 PM" in the location time zone, English. */
function formatResumeDisplay(instant: Date, now: Date, timezone: string) {
	try {
		const sameDay =
			localDateOf(instant, timezone) === localDateOf(now, timezone)
		return new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			hour: 'numeric',
			minute: '2-digit',
			...(sameDay ? {} : { weekday: 'short' }),
		}).format(instant)
	} catch {
		return instant.toISOString()
	}
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
		orderingPause?: OrderingPause | null
		busyMode?: BusyMode | null
	},
	currentTime: Date = new Date(),
): LocationOrderingAvailability {
	const result = scheduleAvailability(location, currentTime)
	const busy = activeBusyExtraPrepMinutes(location, currentTime)
	if (busy > 0) {
		result.estimatedPrepTime += busy
		result.busyExtraPrepMinutes = busy
		if (result.estimatedDeliveryTime) {
			result.estimatedDeliveryTime = {
				min: result.estimatedDeliveryTime.min + busy,
				max: result.estimatedDeliveryTime.max + busy,
			}
		}
	}
	if (location.isActive === false || !isOrderingPaused(location, currentTime)) {
		return result
	}
	const timezone = location.timezone || 'UTC'
	const until = location.orderingPause?.until ?? null
	const resumes = until ? nextOrderingOpenAt(location, new Date(until)) : null
	return {
		...result,
		isOpen: false,
		status: 'closed',
		reason: 'Online ordering is paused',
		nextOpen: resumes
			? `Online ordering resumes at ${formatResumeDisplay(resumes, currentTime, timezone)}`
			: undefined,
		paused: {
			until: until ? new Date(until).toISOString() : null,
			resumesAt: resumes ? resumes.toISOString() : null,
		},
	}
}

function scheduleAvailability(
	location: {
		timezone?: string | null
		onlineHours?: WeeklySchedule | null
		storeHours?: WeeklySchedule | null
		specialHours?: SpecialHour[] | null
		prepTime?: number | null
		deliveryConfig?: DeliveryConfig | null
		isActive?: boolean | null
	},
	currentTime: Date,
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
			hourCycle: 'h23',
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
			hourCycle: 'h23',
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
				const isClosingSoon =
					checkClosingSoon(currentLocalTime, activeSlot.end) &&
					!continuesPastMidnight(location, currentLocalDate, activeSlot.end)
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
		const isClosingSoon =
			checkClosingSoon(currentLocalTime, matchingSlot.end) &&
			!continuesPastMidnight(location, currentLocalDate, matchingSlot.end)
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

type HoursSource = {
	onlineHours?: WeeklySchedule | null
	storeHours?: WeeklySchedule | null
	specialHours?: SpecialHour[] | null
}

/**
 * True when a slot ending at the very end of the day is followed by a slot that
 * starts at midnight on the next local date, i.e. an overnight stretch that was
 * split at midnight. Such a location is not about to close.
 */
function continuesPastMidnight(
	location: HoursSource,
	localDate: string,
	slotEnd: string,
): boolean {
	if (slotEnd !== END_OF_DAY) return false
	const next = addLocalDays(localDate, 1)
	const special = Array.isArray(location.specialHours)
		? location.specialHours.find((entry) => entry.date === next.date)
		: undefined
	let slots: SpecialHour['slots'] = []
	if (special) {
		slots = special.isOpen ? (special.slots ?? []) : []
	} else {
		const schedule = location.onlineHours || location.storeHours
		const daySchedule = Array.isArray(schedule)
			? schedule.find((entry) => entry.day === next.day)
			: undefined
		slots = daySchedule?.isOpen ? (daySchedule.slots ?? []) : []
	}
	return slots.some((slot) => slot.start === START_OF_DAY)
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
			hourCycle: 'h23',
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
			hourCycle: 'h23',
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
			hourCycle: 'h23',
			weekday: 'long',
		})
		for (const p of formatter.formatToParts(now)) {
			parts[p.type] = p.value
		}
	}

	const todayDayOfWeek = (parts.weekday?.toLowerCase() ?? 'monday') as DayOfWeek
	const todayDateStr = `${parts.year}-${parts.month}-${parts.day}`

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

	// 4. Tomorrow at opening time. Walk calendar dates from the local date, not
	// `now + 24h`: a day is 23 or 25 hours long across a DST change, so adding
	// 24 hours near midnight can land on the wrong date or weekday.
	const tomorrow = addLocalDays(todayDateStr, 1)
	const tomorrowDaySchedule = schedule.find((d) => d.day === tomorrow.day)
	if (tomorrowDaySchedule?.isOpen && tomorrowDaySchedule.slots?.length) {
		const sortedSlots = [...tomorrowDaySchedule.slots].sort((a, b) =>
			a.start.localeCompare(b.start),
		)
		const openingTimeStr = sortedSlots[0]?.start
		if (openingTimeStr) {
			const openingDate = localDateAndTimeToUtc(
				tomorrow.date,
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
			const next = addLocalDays(todayDateStr, offset)
			const nextSchedule = schedule.find((d) => d.day === next.day)
			if (nextSchedule?.isOpen && nextSchedule.slots?.length) {
				const openingStr = [...nextSchedule.slots].sort((a, b) =>
					a.start.localeCompare(b.start),
				)[0]?.start
				if (openingStr) {
					const nextDate = localDateAndTimeToUtc(
						next.date,
						openingStr,
						timezone,
					)
					const openDisplay = formatTimeDisplay(openingStr)
					const dayCapitalized =
						next.day.charAt(0).toUpperCase() + next.day.slice(1)
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
		}
		if (!foundNextDay) {
			// Fallback: tomorrow at 9:00 AM
			const fallbackDate = localDateAndTimeToUtc(
				tomorrow.date,
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

	// Check tomorrow (calendar math: `now + 24h` is wrong across DST changes)
	const tomorrow = addLocalDays(
		`${nowParts.year}-${nowParts.month}-${nowParts.day}`,
		1,
	)
	const isTomorrow =
		`${dateParts.year}-${dateParts.month}-${dateParts.day}` === tomorrow.date

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
