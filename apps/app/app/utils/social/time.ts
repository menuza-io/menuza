/**
 * Calendar math in the member's time zone (the `timeZone` client hint), so the
 * server and the browser render the same days and times.
 */

function parts(date: Date, timeZone: string) {
	const values = Object.fromEntries(
		new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		})
			.formatToParts(date)
			.map((part) => [part.type, part.value]),
	)
	return {
		year: values.year!,
		month: values.month!,
		day: values.day!,
		hour: values.hour!,
		minute: values.minute!,
	}
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function dayKey(date: Date, timeZone: string): string {
	const p = parts(date, timeZone)
	return `${p.year}-${p.month}-${p.day}`
}

/** `YYYY-MM` of an instant in a time zone. */
export function monthKey(date: Date, timeZone: string): string {
	return dayKey(date, timeZone).slice(0, 7)
}

/** The value of a `datetime-local` input showing this instant. */
export function toLocalInputValue(date: Date, timeZone: string): string {
	const p = parts(date, timeZone)
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** The instant a wall-clock time (`YYYY-MM-DDTHH:mm`) names in a time zone. */
export function fromLocalInputValue(value: string, timeZone: string): Date {
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value)
	if (!match) return new Date(Number.NaN)
	const [, y, mo, d, h, mi] = match.map(Number) as number[]
	const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!)
	// Two passes settle the offset around daylight-saving changes.
	let guess = wall
	for (let i = 0; i < 2; i++) {
		const shown = toLocalInputValue(new Date(guess), timeZone)
		const [, sy, smo, sd, sh, smi] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u
			.exec(shown)!
			.map(Number) as number[]
		guess += wall - Date.UTC(sy!, smo! - 1, sd!, sh!, smi!)
	}
	const at = new Date(guess)
	if (toLocalInputValue(at, timeZone) !== value) {
		return new Date(Number.NaN)
	}
	return at
}

export function isMonthKey(value: string | null): value is string {
	return Boolean(value && /^\d{4}-(0[1-9]|1[0-2])$/u.test(value))
}

export function shiftMonth(month: string, by: number): string {
	const [year, monthNumber] = month.split('-').map(Number) as [number, number]
	const date = new Date(Date.UTC(year, monthNumber - 1 + by, 1))
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * The 6 x 7 grid of `YYYY-MM-DD` days shown for a month, weeks starting on
 * `weekStartsOn` (0 Sunday ... 6 Saturday).
 */
export function monthGrid(month: string, weekStartsOn = 0): string[] {
	const [year, monthNumber] = month.split('-').map(Number) as [number, number]
	const first = new Date(Date.UTC(year, monthNumber - 1, 1))
	const lead = (first.getUTCDay() - weekStartsOn + 7) % 7
	return Array.from({ length: 42 }, (_, index) => {
		const day = new Date(Date.UTC(year, monthNumber - 1, 1 + index - lead))
		return day.toISOString().slice(0, 10)
	})
}

/** A UTC window that holds every instant of the month in any time zone. */
export function monthWindow(month: string): { from: Date; to: Date } {
	const [year, monthNumber] = month.split('-').map(Number) as [number, number]
	return {
		from: new Date(Date.UTC(year, monthNumber - 1, 1) - 7 * 86_400_000),
		to: new Date(Date.UTC(year, monthNumber, 1) + 7 * 86_400_000),
	}
}

/** Matches `SocialPostFormSchema` schedule rules (at least one minute ahead). */
export const MIN_SCHEDULE_LEAD_MS = 60_000

export function isScheduleLocalValid(
	value: string,
	timeZone: string,
	now = new Date(),
): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return false
	const at = fromLocalInputValue(value, timeZone)
	return (
		!Number.isNaN(at.getTime()) &&
		at.getTime() >= now.getTime() + MIN_SCHEDULE_LEAD_MS
	)
}

/** Default `datetime-local` when opening the composer for a calendar day. */
export function schedulePrefillForDay(
	day: string,
	timeZone: string,
	now = new Date(),
): string {
	const nine = `${day}T09:00`
	if (isScheduleLocalValid(nine, timeZone, now)) return nine
	return toLocalInputValue(
		new Date(now.getTime() + 2 * MIN_SCHEDULE_LEAD_MS),
		timeZone,
	)
}
