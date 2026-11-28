import {
	hhmmToMinutes,
	isCalendarDate,
	locationLocalClock,
	nextSpecialHourDate,
} from '@repo/opening-hours'
import {
	DAYS_OF_WEEK,
	type DayOfWeek,
	type SpecialHour,
	type TimeSlot,
	type WeeklySchedule,
} from './location-types.ts'

/**
 * Opening-hours mistake warnings (#275). One pure function, `lintHours`, reads
 * the weekly store hours, the online ordering hours and the special hours and
 * returns warnings with a code, the facts to word it and, where one is obvious,
 * a one-click fix. It never blocks a save, never warns about hours set on
 * purpose (overnight rows split at midnight, 24-hour days) and never reads a
 * guest field. The editor, the launch checklist and the Needs attention feed
 * all call it, so they cannot disagree.
 *
 * Words are not here: a code and its params are worded by each surface in the
 * viewer's language.
 */

/** A day open under 3 hours or over 20 is worth a second look. */
export const MIN_DAY_MINUTES = 180
export const MAX_DAY_MINUTES = 1200
/** An online window shorter than this leaves no time to order. */
export const MIN_ONLINE_WINDOW_MINUTES = 30

export const HOURS_WARNING_CODES = [
	'day_too_short',
	'day_too_long',
	'closes_before_opens',
	'closing_looks_like_morning',
	'online_overnight_not_split',
	'online_outside_store',
	'online_no_time_to_order',
	'closed_every_day',
	'online_closed_every_day',
	'special_overlap',
	'special_open_without_hours',
	'special_closed_with_hours',
	'special_duplicate_date',
] as const
export type HoursWarningCode = (typeof HOURS_WARNING_CODES)[number]

export type HoursScope = 'store' | 'online' | 'special'

/** What a one-click fix changes. Applied by {@link applyHoursFix}. */
export type HoursFix =
	| {
			kind: 'set_slot_end'
			scope: 'store' | 'online'
			day: DayOfWeek
			slotIndex: number
			end: string
	  }
	| {
			kind: 'set_day_slots'
			scope: 'store' | 'online'
			day: DayOfWeek
			slots: TimeSlot[]
	  }
	| {
			kind: 'split_overnight'
			scope: 'store' | 'online'
			day: DayOfWeek
			slotIndex: number
	  }
	| { kind: 'match_store_day'; day: DayOfWeek }
	| { kind: 'set_special_slot_end'; id: string; slotIndex: number; end: string }
	| { kind: 'merge_special_slots'; id: string }
	| { kind: 'close_special'; id: string }
	| { kind: 'remove_special'; id: string }

export type HoursWarning = {
	/** Stable per place and code, for keys and tests. */
	key: string
	code: HoursWarningCode
	scope: HoursScope
	day?: DayOfWeek
	/** The special entry's date. */
	date?: string
	specialId?: string
	/** Facts for the wording: hours, times (`HH:MM`), the suggested value. */
	params: Record<string, string | number>
	fix: HoursFix | null
}

export type HoursLintInput = {
	storeHours: WeeklySchedule | null | undefined
	onlineHours: WeeklySchedule | null | undefined
	specialHours: readonly SpecialHour[] | null | undefined
}

export type HoursLintOptions = {
	/** The location's IANA time zone: "today" for special hours is read in it. */
	timeZone?: string
	now?: Date
	/** Online ordering follows the store hours: online checks are skipped. */
	syncOnline?: boolean
	prepMinutes?: number | null
}

type Range = [number, number]

function toMinutes(value: string): number | null {
	return hhmmToMinutes(value)
}

function fromMinutes(minutes: number): string {
	const m = ((minutes % 1440) + 1440) % 1440
	return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function validSlots(slots: readonly TimeSlot[] | undefined) {
	const out: Array<{ index: number; start: number; end: number }> = []
	slots?.forEach((slot, index) => {
		const start = toMinutes(slot.start)
		const end = toMinutes(slot.end)
		if (start !== null && end !== null) out.push({ index, start, end })
	})
	return out
}

/** 23:59 is the last minute of the day: it counts as midnight. */
function endForLength(end: number): number {
	return end === 1439 ? 1440 : end
}

function slotLength(start: number, end: number): number {
	return end >= start
		? endForLength(end) - start
		: 1440 - start + endForLength(end)
}

function dayEntry(schedule: WeeklySchedule | null | undefined, day: DayOfWeek) {
	return schedule?.find((entry) => entry.day === day)
}

function nextDay(day: DayOfWeek): DayOfWeek {
	const i = DAYS_OF_WEEK.indexOf(day)
	return DAYS_OF_WEEK[(i + 1) % 7]!
}

function prevDay(day: DayOfWeek): DayOfWeek {
	const i = DAYS_OF_WEEK.indexOf(day)
	return DAYS_OF_WEEK[(i + 6) % 7]!
}

type DayFacts = {
	open: boolean
	/** Some slot covers 00:00 to 23:59. */
	is24h: boolean
	/** Minutes open, counting an overnight tail on the day it starts. */
	minutes: number
	/** Only the tail of the day before (an overnight stretch split at midnight). */
	tailOnly: boolean
	/** Last closing minute of the day's own slots. */
	lastClose: number | null
}

function dayFacts(
	schedule: WeeklySchedule | null | undefined,
	day: DayOfWeek,
): DayFacts {
	const entry = dayEntry(schedule, day)
	const slots = entry?.isOpen ? validSlots(entry.slots) : []
	if (slots.length === 0) {
		return {
			open: false,
			is24h: false,
			minutes: 0,
			tailOnly: false,
			lastClose: null,
		}
	}
	const previous = dayEntry(schedule, prevDay(day))
	const previousEndsAtMidnight =
		previous?.isOpen === true &&
		validSlots(previous.slots).some(
			(slot) => slot.end === 1439 && slot.end >= slot.start,
		)
	const is24h = slots.some((slot) => slot.start === 0 && slot.end === 1439)
	let minutes = 0
	let ownSlots = 0
	let lastClose: number | null = null
	for (const slot of slots) {
		const isTail =
			slot.start === 0 &&
			slot.end < 1439 &&
			previousEndsAtMidnight &&
			slot.end >= slot.start
		if (isTail) continue
		ownSlots++
		minutes += slotLength(slot.start, slot.end)
		lastClose = slot.end
	}
	// The overnight tail on the next day belongs to the day it started.
	const tomorrow = dayEntry(schedule, nextDay(day))
	const lastOwn = slots[slots.length - 1]
	if (
		lastOwn &&
		lastOwn.end === 1439 &&
		lastOwn.end >= lastOwn.start &&
		tomorrow?.isOpen
	) {
		const tail = validSlots(tomorrow.slots).find(
			(slot) => slot.start === 0 && slot.end < 1439,
		)
		if (tail) minutes += tail.end + 1
	}
	return { open: true, is24h, minutes, tailOnly: ownSlots === 0, lastClose }
}

/** Most common non-empty slot set among the other open days (needs two alike). */
function typicalSlots(
	schedule: WeeklySchedule | null | undefined,
	except: DayOfWeek,
): TimeSlot[] | null {
	const counts = new Map<string, { slots: TimeSlot[]; count: number }>()
	for (const entry of schedule ?? []) {
		if (entry.day === except || !entry.isOpen || entry.slots.length === 0) {
			continue
		}
		const key = JSON.stringify(entry.slots)
		const found = counts.get(key)
		if (found) found.count++
		else counts.set(key, { slots: entry.slots, count: 1 })
	}
	let best: { slots: TimeSlot[]; count: number } | null = null
	for (const value of counts.values()) {
		if (!best || value.count > best.count) best = value
	}
	return best && best.count >= 2 ? best.slots : null
}

/** The latest closing minute most other days share (evening closings only). */
function typicalCloseMinute(
	schedule: WeeklySchedule | null | undefined,
	except: DayOfWeek,
): number | null {
	const closes: number[] = []
	for (const day of DAYS_OF_WEEK) {
		if (day === except) continue
		const facts = dayFacts(schedule, day)
		if (facts.open && facts.lastClose !== null && facts.lastClose >= 1020) {
			closes.push(facts.lastClose)
		}
	}
	if (closes.length === 0) return null
	closes.sort((a, b) => a - b)
	return closes[Math.floor(closes.length / 2)]!
}

function mergeRanges(ranges: Range[]): Range[] {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0])
	const out: Range[] = []
	for (const range of sorted) {
		const last = out[out.length - 1]
		if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
		else out.push([range[0], range[1]])
	}
	return out
}

/** Open ranges per weekday, minutes since midnight, end inclusive; tails move to the next day. */
function weekRanges(
	schedule: WeeklySchedule | null | undefined,
	kind: 'store' | 'online',
): Map<DayOfWeek, Range[]> {
	const out = new Map<DayOfWeek, Range[]>(DAYS_OF_WEEK.map((d) => [d, []]))
	for (const entry of schedule ?? []) {
		if (!entry.isOpen) continue
		for (const slot of validSlots(entry.slots)) {
			if (slot.end >= slot.start) {
				out.get(entry.day)!.push([slot.start, slot.end])
			} else if (kind === 'store') {
				out.get(entry.day)!.push([slot.start, 1439])
				out.get(nextDay(entry.day))!.push([0, slot.end])
			}
		}
	}
	for (const [day, ranges] of out) out.set(day, mergeRanges(ranges))
	return out
}

function uncovered(range: Range, covering: Range[]): Range | null {
	let [from, to] = range
	for (const cover of covering) {
		if (cover[1] < from || cover[0] > to) continue
		if (cover[0] <= from) from = Math.max(from, cover[1] + 1)
		else return [from, cover[0] - 1]
		if (from > to) return null
	}
	return from <= to ? [from, to] : null
}

function lintWeekly(
	schedule: WeeklySchedule | null | undefined,
	scope: 'store' | 'online',
	out: HoursWarning[],
) {
	if (!schedule || schedule.length === 0) return
	const anyOpen = DAYS_OF_WEEK.some((day) => dayFacts(schedule, day).open)
	if (!anyOpen) {
		out.push({
			key: `${scope === 'store' ? 'closed_every_day' : 'online_closed_every_day'}:${scope}`,
			code: scope === 'store' ? 'closed_every_day' : 'online_closed_every_day',
			scope,
			params: {},
			fix: null,
		})
		return
	}
	for (const day of DAYS_OF_WEEK) {
		const entry = dayEntry(schedule, day)
		if (!entry?.isOpen) continue
		const facts = dayFacts(schedule, day)
		const slots = validSlots(entry.slots)
		let slipFound = false
		const typicalClose = typicalCloseMinute(schedule, day)
		const previous = dayEntry(schedule, prevDay(day))
		const previousEndsAtMidnight =
			previous?.isOpen === true &&
			validSlots(previous.slots).some(
				(slot) => slot.end === 1439 && slot.end >= slot.start,
			)
		for (const slot of slots) {
			const isTail =
				slot.start === 0 && slot.end < 1439 && previousEndsAtMidnight
			if (isTail) continue
			if (slot.end < slot.start) {
				if (scope === 'online') {
					slipFound = true
					out.push({
						key: `online_overnight_not_split:${day}:${slot.index}`,
						code: 'online_overnight_not_split',
						scope,
						day,
						params: {
							start: fromMinutes(slot.start),
							end: fromMinutes(slot.end),
						},
						fix: {
							kind: 'split_overnight',
							scope,
							day,
							slotIndex: slot.index,
						},
					})
					continue
				}
				// A store row that wraps midnight is a deliberate overnight stretch
				// when it ends in the small hours after an evening start.
				if (slot.end <= 360 && slot.start >= 720) continue
				slipFound = true
				const suggested = slot.end + 720
				out.push({
					key: `closes_before_opens:${scope}:${day}:${slot.index}`,
					code: 'closes_before_opens',
					scope,
					day,
					params: {
						start: fromMinutes(slot.start),
						end: fromMinutes(slot.end),
						...(suggested > slot.start && suggested < 1440
							? { suggested: fromMinutes(suggested) }
							: {}),
					},
					fix:
						suggested > slot.start && suggested < 1440
							? {
									kind: 'set_slot_end',
									scope,
									day,
									slotIndex: slot.index,
									end: fromMinutes(suggested),
								}
							: null,
				})
				continue
			}
			// Closes in the morning on a day that otherwise runs into the evening,
			// while the other days close at night: an AM and PM mix-up.
			if (
				slot.end < 720 &&
				slot.end - slot.start < 360 &&
				typicalClose !== null &&
				slot.end + 720 <= typicalClose + 120 &&
				slot.end + 720 > slot.start
			) {
				slipFound = true
				out.push({
					key: `closing_looks_like_morning:${scope}:${day}:${slot.index}`,
					code: 'closing_looks_like_morning',
					scope,
					day,
					params: {
						start: fromMinutes(slot.start),
						end: fromMinutes(slot.end),
						suggested: fromMinutes(slot.end + 720),
					},
					fix: {
						kind: 'set_slot_end',
						scope,
						day,
						slotIndex: slot.index,
						end: fromMinutes(slot.end + 720),
					},
				})
			}
		}
		if (facts.is24h || facts.tailOnly || slipFound) continue
		const hours = Math.round((facts.minutes / 60) * 10) / 10
		if (facts.minutes < MIN_DAY_MINUTES) {
			const typical = typicalSlots(schedule, day)
			out.push({
				key: `day_too_short:${scope}:${day}`,
				code: 'day_too_short',
				scope,
				day,
				params: { hours },
				fix: typical
					? { kind: 'set_day_slots', scope, day, slots: typical }
					: null,
			})
		} else if (facts.minutes > MAX_DAY_MINUTES) {
			const typical = typicalSlots(schedule, day)
			out.push({
				key: `day_too_long:${scope}:${day}`,
				code: 'day_too_long',
				scope,
				day,
				params: { hours },
				fix: typical
					? { kind: 'set_day_slots', scope, day, slots: typical }
					: null,
			})
		}
	}
}

function lintOnlineAgainstStore(
	store: WeeklySchedule | null | undefined,
	online: WeeklySchedule | null | undefined,
	prepMinutes: number | null | undefined,
	out: HoursWarning[],
) {
	if (!store || store.length === 0 || !online || online.length === 0) return
	const storeRanges = weekRanges(store, 'store')
	const onlineRanges = weekRanges(online, 'online')
	const minWindow = Math.max(MIN_ONLINE_WINDOW_MINUTES, prepMinutes ?? 0)
	for (const day of DAYS_OF_WEEK) {
		const ranges = onlineRanges.get(day) ?? []
		const covering = storeRanges.get(day) ?? []
		let outside: Range | null = null
		let shortest: number | null = null
		for (const range of ranges) {
			const gap = uncovered(range, covering)
			if (gap && !outside) outside = gap
			const length = range[1] - range[0] + 1
			if (!gap && (shortest === null || length < shortest)) shortest = length
		}
		if (outside) {
			out.push({
				key: `online_outside_store:${day}`,
				code: 'online_outside_store',
				scope: 'online',
				day,
				params: {
					from: fromMinutes(outside[0]),
					to: fromMinutes(outside[1] + 1),
				},
				fix: { kind: 'match_store_day', day },
			})
		} else if (shortest !== null && shortest < minWindow) {
			out.push({
				key: `online_no_time_to_order:${day}`,
				code: 'online_no_time_to_order',
				scope: 'online',
				day,
				params: { minutes: shortest, needed: minWindow },
				fix: { kind: 'match_store_day', day },
			})
		}
	}
}

function lintSpecial(
	special: readonly SpecialHour[] | null | undefined,
	today: string | null,
	out: HoursWarning[],
) {
	if (!special || special.length === 0) return
	const live = special.filter(
		(entry) =>
			isCalendarDate(entry.date) &&
			(today === null || nextSpecialHourDate(entry, today) !== null),
	)
	const seenExact = new Map<string, SpecialHour>()
	const seenYearly = new Map<string, SpecialHour>()
	for (const entry of live) {
		const base = {
			scope: 'special' as const,
			date: entry.date,
			specialId: entry.id,
		}
		const duplicate =
			seenExact.get(entry.date) ??
			(entry.repeatsYearly ? seenYearly.get(entry.date.slice(5)) : undefined)
		if (duplicate) {
			out.push({
				...base,
				key: `special_duplicate_date:${entry.id}`,
				code: 'special_duplicate_date',
				params: { date: entry.date },
				fix: { kind: 'remove_special', id: entry.id },
			})
		}
		seenExact.set(entry.date, entry)
		if (entry.repeatsYearly) seenYearly.set(entry.date.slice(5), entry)

		const slots = validSlots(entry.slots)
		if (entry.isOpen && slots.length === 0) {
			out.push({
				...base,
				key: `special_open_without_hours:${entry.id}`,
				code: 'special_open_without_hours',
				params: { date: entry.date },
				fix: { kind: 'close_special', id: entry.id },
			})
			continue
		}
		if (!entry.isOpen) {
			if (slots.length > 0) {
				out.push({
					...base,
					key: `special_closed_with_hours:${entry.id}`,
					code: 'special_closed_with_hours',
					params: { date: entry.date },
					fix: { kind: 'close_special', id: entry.id },
				})
			}
			continue
		}
		const sorted = [...slots].sort((a, b) => a.start - b.start)
		let overlap = false
		for (let i = 1; i < sorted.length; i++) {
			const before = sorted[i - 1]!
			const here = sorted[i]!
			if (before.end >= before.start && here.start <= before.end) overlap = true
		}
		if (overlap) {
			out.push({
				...base,
				key: `special_overlap:${entry.id}`,
				code: 'special_overlap',
				params: { date: entry.date },
				fix: { kind: 'merge_special_slots', id: entry.id },
			})
		}
		for (const slot of slots) {
			if (slot.end < slot.start && !(slot.end <= 360 && slot.start >= 720)) {
				const suggested = slot.end + 720
				const ok = suggested > slot.start && suggested < 1440
				out.push({
					...base,
					key: `closes_before_opens:special:${entry.id}:${slot.index}`,
					code: 'closes_before_opens',
					params: {
						start: fromMinutes(slot.start),
						end: fromMinutes(slot.end),
						...(ok ? { suggested: fromMinutes(suggested) } : {}),
					},
					fix: ok
						? {
								kind: 'set_special_slot_end',
								id: entry.id,
								slotIndex: slot.index,
								end: fromMinutes(suggested),
							}
						: null,
				})
			}
		}
	}
}

/**
 * The warnings for one location's hours. Overnight rows split at midnight and
 * 24-hour days never warn; past one-off special entries are not checked. The
 * special hours read "today" in the location's time zone.
 */
export function lintHours(
	input: HoursLintInput,
	options: HoursLintOptions = {},
): HoursWarning[] {
	const out: HoursWarning[] = []
	lintWeekly(input.storeHours, 'store', out)
	if (!options.syncOnline) {
		lintWeekly(input.onlineHours, 'online', out)
		lintOnlineAgainstStore(
			input.storeHours,
			input.onlineHours,
			options.prepMinutes,
			out,
		)
	}
	// A short online day that the store comparison already explains is not
	// warned about twice.
	const explained = new Set(
		out
			.filter(
				(w) =>
					w.scope === 'online' &&
					(w.code === 'online_no_time_to_order' ||
						w.code === 'online_outside_store'),
			)
			.map((w) => w.day),
	)
	for (let i = out.length - 1; i >= 0; i--) {
		const w = out[i]!
		if (
			w.scope === 'online' &&
			w.code === 'day_too_short' &&
			explained.has(w.day)
		) {
			out.splice(i, 1)
		}
	}
	const today = locationLocalClock(
		(options.now ?? new Date()).getTime(),
		options.timeZone ?? 'UTC',
	).date
	lintSpecial(input.specialHours, today, out)
	return out
}

export type HoursState = {
	storeHours: WeeklySchedule
	onlineHours: WeeklySchedule
	specialHours: SpecialHour[]
}

function withDay(
	schedule: WeeklySchedule,
	day: DayOfWeek,
	update: (entry: WeeklySchedule[number]) => WeeklySchedule[number],
): WeeklySchedule {
	return schedule.map((entry) => (entry.day === day ? update(entry) : entry))
}

/** The hours after a one-click fix. Pure; the caller stores the result. */
export function applyHoursFix(fix: HoursFix, state: HoursState): HoursState {
	switch (fix.kind) {
		case 'set_slot_end': {
			const key = fix.scope === 'store' ? 'storeHours' : 'onlineHours'
			return {
				...state,
				[key]: withDay(state[key], fix.day, (entry) => ({
					...entry,
					slots: entry.slots.map((slot, i) =>
						i === fix.slotIndex ? { ...slot, end: fix.end } : slot,
					),
				})),
			}
		}
		case 'set_day_slots': {
			const key = fix.scope === 'store' ? 'storeHours' : 'onlineHours'
			return {
				...state,
				[key]: withDay(state[key], fix.day, (entry) => ({
					...entry,
					isOpen: fix.slots.length > 0,
					slots: fix.slots.map((slot) => ({ ...slot })),
				})),
			}
		}
		case 'split_overnight': {
			const key = fix.scope === 'store' ? 'storeHours' : 'onlineHours'
			const schedule = state[key]
			const entry = dayEntry(schedule, fix.day)
			const slot = entry?.slots[fix.slotIndex]
			if (!entry || !slot) return state
			const tomorrow = nextDay(fix.day)
			return {
				...state,
				[key]: withDay(
					withDay(schedule, fix.day, (e) => ({
						...e,
						slots: e.slots.map((s, i) =>
							i === fix.slotIndex ? { start: slot.start, end: '23:59' } : s,
						),
					})),
					tomorrow,
					(e) => ({
						...e,
						isOpen: true,
						slots: [{ start: '00:00', end: slot.end }, ...e.slots],
					}),
				),
			}
		}
		case 'match_store_day': {
			const store = dayEntry(state.storeHours, fix.day)
			return {
				...state,
				onlineHours: withDay(state.onlineHours, fix.day, (entry) => ({
					...entry,
					isOpen: Boolean(store?.isOpen && store.slots.length > 0),
					slots: (store?.slots ?? []).map((slot) => ({ ...slot })),
				})),
			}
		}
		case 'set_special_slot_end':
			return {
				...state,
				specialHours: state.specialHours.map((entry) =>
					entry.id === fix.id
						? {
								...entry,
								slots: entry.slots.map((slot, i) =>
									i === fix.slotIndex ? { ...slot, end: fix.end } : slot,
								),
							}
						: entry,
				),
			}
		case 'merge_special_slots':
			return {
				...state,
				specialHours: state.specialHours.map((entry) => {
					if (entry.id !== fix.id) return entry
					const merged = mergeRanges(
						validSlots(entry.slots).map((slot): Range => [
							slot.start,
							Math.max(slot.start, slot.end),
						]),
					)
					return {
						...entry,
						slots: merged.map(([from, to]) => ({
							start: fromMinutes(from),
							end: to === 1440 ? '23:59' : fromMinutes(to),
						})),
					}
				}),
			}
		case 'close_special':
			return {
				...state,
				specialHours: state.specialHours.map((entry) =>
					entry.id === fix.id ? { ...entry, isOpen: false, slots: [] } : entry,
				),
			}
		case 'remove_special':
			return {
				...state,
				specialHours: state.specialHours.filter((entry) => entry.id !== fix.id),
			}
	}
}

/**
 * A short stable fingerprint of the three hours values. "Dismissed until the
 * hours change" stores it: any edit to the hours gives a new value.
 */
export function hoursFingerprint(input: HoursLintInput): string {
	const text = JSON.stringify([
		input.storeHours ?? null,
		input.onlineHours ?? null,
		(input.specialHours ?? []).map(({ date, isOpen, slots, repeatsYearly }) => [
			date,
			isOpen,
			slots,
			repeatsYearly === true,
		]),
	])
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return `${hash.toString(16).padStart(8, '0')}${text.length.toString(16)}`
}

/** `HH:MM` as `11:00 PM`, for "Did you mean 11:00 PM?". */
export function formatHoursTime(value: string, locale = 'en'): string {
	const minutes = toMinutes(value)
	if (minutes === null) return value
	return new Intl.DateTimeFormat(locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: 'UTC',
	}).format(
		new Date(Date.UTC(2024, 0, 1, Math.floor(minutes / 60), minutes % 60)),
	)
}
