/** 24-hour `HH:mm` value stored in location hours JSON. */
export type TimeOfDay24 = `${string}:${string}`

const MINUTES_PER_DAY = 24 * 60
const SLOT_MINUTES = 15

export function buildTimeOfDayOptions(
	stepMinutes = SLOT_MINUTES,
): TimeOfDay24[] {
	const options: TimeOfDay24[] = []
	for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += stepMinutes) {
		const hours = Math.floor(minutes / 60)
		const mins = minutes % 60
		options.push(
			`${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}` as TimeOfDay24,
		)
	}
	return options
}

export const TIME_OF_DAY_OPTIONS: readonly TimeOfDay24[] =
	buildTimeOfDayOptions()

export function formatTimeOfDay12h(value: string): string {
	const parts = value.split(':').map(Number)
	const hours24 = parts[0] ?? 0
	const minutes = parts[1] ?? 0
	const period = hours24 >= 12 ? 'PM' : 'AM'
	const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12
	return `${hours12}:${String(minutes).padStart(2, '0')} ${period}`
}

export function isValidTimeOfDay24(value: string): boolean {
	return (
		/^\d{2}:\d{2}$/.test(value) &&
		(TIME_OF_DAY_OPTIONS as readonly string[]).includes(value)
	)
}
