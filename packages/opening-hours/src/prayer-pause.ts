import {
	CalculationMethod as AdhanMethod,
	Coordinates,
	PrayerTimes,
	type CalculationParameters,
} from 'adhan'

export type PrayerName = 'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha'

export type PrayerPauseRow = {
	name: PrayerName
	beforeMinutes: number
	afterMinutes: number
}

export type PrayerPauseConfig = {
	enabled: boolean
	calculationMethod: 'UmmAlQura' | 'MuslimWorldLeague' | 'Egyptian'
	prayers: PrayerPauseRow[]
}

export type PrayerPauseWindow = {
	name: PrayerName
	startMs: number
	endMs: number
	resumeMs: number
}

function calculationParams(
	method: PrayerPauseConfig['calculationMethod'],
): CalculationParameters {
	switch (method) {
		case 'UmmAlQura':
			return AdhanMethod.UmmAlQura()
		case 'Egyptian':
			return AdhanMethod.Egyptian()
		default:
			return AdhanMethod.MuslimWorldLeague()
	}
}

function prayerMs(times: PrayerTimes, name: PrayerName): number {
	switch (name) {
		case 'fajr':
			return times.fajr.getTime()
		case 'dhuhr':
			return times.dhuhr.getTime()
		case 'asr':
			return times.asr.getTime()
		case 'maghrib':
			return times.maghrib.getTime()
		default:
			return times.isha.getTime()
	}
}

/** Pause windows for one local calendar day (location time zone). */
export function prayerPauseWindowsForDay(
	config: PrayerPauseConfig,
	coords: { lat: number; lng: number },
	localDate: string,
	_timeZone: string,
): PrayerPauseWindow[] {
	if (!config.enabled) return []
	const [y, m, d] = localDate.split('-').map(Number) as [number, number, number]
	const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
	const params = calculationParams(config.calculationMethod)
	const times = new PrayerTimes(
		new Coordinates(coords.lat, coords.lng),
		date,
		params,
	)
	const out: PrayerPauseWindow[] = []
	for (const row of config.prayers) {
		const at = prayerMs(times, row.name)
		const startMs = at - row.beforeMinutes * 60_000
		const endMs = at + row.afterMinutes * 60_000
		out.push({
			name: row.name,
			startMs,
			endMs,
			resumeMs: endMs,
		})
	}
	return out.sort((a, b) => a.startMs - b.startMs)
}

export function activePrayerPause(
	windows: PrayerPauseWindow[],
	instantMs: number,
): PrayerPauseWindow | null {
	for (const w of windows) {
		if (instantMs >= w.startMs && instantMs < w.endMs) return w
	}
	return null
}
