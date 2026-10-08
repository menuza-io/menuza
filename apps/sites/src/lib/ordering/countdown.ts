export type RemainingParts = {
	days: number
	hours: number
	minutes: number
	seconds: number
	totalMs: number
}

export function splitRemaining(ms: number): RemainingParts {
	const totalMs = Math.max(0, ms)
	const totalSeconds = Math.floor(totalMs / 1000)
	return {
		days: Math.floor(totalSeconds / 86_400),
		hours: Math.floor((totalSeconds % 86_400) / 3_600),
		minutes: Math.floor((totalSeconds % 3_600) / 60),
		seconds: totalSeconds % 60,
		totalMs,
	}
}

function unit(
	value: number,
	name: 'day' | 'hour' | 'minute' | 'second',
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'unit',
			unit: name,
			unitDisplay: 'narrow',
		}).format(value)
	} catch {
		return `${value}${name[0]}`
	}
}

/**
 * Compact, locale-aware remaining time: "3h 12m", "2d 4h", "45s". Uses
 * `Intl` unit formatting so no translation strings are needed.
 */
export function formatRemaining(ms: number, locale: string = 'en'): string {
	const parts = splitRemaining(ms)
	if (parts.days > 0) {
		return `${unit(parts.days, 'day', locale)} ${unit(parts.hours, 'hour', locale)}`
	}
	if (parts.hours > 0) {
		return `${unit(parts.hours, 'hour', locale)} ${unit(parts.minutes, 'minute', locale)}`
	}
	if (parts.minutes > 0) {
		return `${unit(parts.minutes, 'minute', locale)} ${unit(parts.seconds, 'second', locale)}`
	}
	return unit(parts.seconds, 'second', locale)
}

/**
 * Ticks once per second until `target`, then calls `onDone`. Returns a stop
 * function. Ticks are aligned to wall-clock seconds so displays stay in step.
 */
export function startCountdown(
	target: Date | number,
	onTick: (remainingMs: number, parts: RemainingParts) => void,
	onDone?: () => void,
): () => void {
	const end = typeof target === 'number' ? target : target.getTime()
	let timer: ReturnType<typeof setTimeout> | null = null
	let stopped = false

	const tick = () => {
		if (stopped) return
		const remaining = end - Date.now()
		onTick(Math.max(0, remaining), splitRemaining(remaining))
		if (remaining <= 0) {
			stopped = true
			onDone?.()
			return
		}
		timer = setTimeout(tick, 1000 - (Date.now() % 1000))
	}
	tick()

	return () => {
		stopped = true
		if (timer) clearTimeout(timer)
	}
}
