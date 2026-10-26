const units = new Map<string, Intl.NumberFormat>()
function unit(locale: string, name: 'hour' | 'minute', value: number) {
	const key = `${locale}|${name}`
	let format = units.get(key)
	if (!format) {
		format = new Intl.NumberFormat(locale, {
			style: 'unit',
			unit: name,
			unitDisplay: 'short',
		})
		units.set(key, format)
	}
	return format.format(value)
}

/**
 * A wait or a stay in the till's language, short: "12 min", then "3 hr 33 min"
 * from an hour on, where "213 min" would need working out.
 */
export function shortDuration(minutes: number, locale: string): string {
	const whole = Math.max(0, Math.round(minutes))
	if (whole < 60) return unit(locale, 'minute', whole)
	const hours = Math.floor(whole / 60)
	const rest = whole % 60
	return rest
		? `${unit(locale, 'hour', hours)} ${unit(locale, 'minute', rest)}`
		: unit(locale, 'hour', hours)
}
