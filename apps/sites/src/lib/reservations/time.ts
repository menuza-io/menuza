/** Date and time helpers. Reservation times are restaurant-local; nothing here guesses a zone. */

/** Times, dates and party sizes keep Western digits in every locale (Arabic included). */
export function latinDigits(locale: string): string {
	return locale.includes('-u-') ? locale : `${locale}-u-nu-latn`
}

export function pad2(value: number): string {
	return String(value).padStart(2, '0')
}

/** `HH:MM` for minutes since local midnight (the engine allows past 24h for late services). */
export function formatHhmm(localMin: number): string {
	return `${pad2(Math.floor(localMin / 60) % 24)}:${pad2(localMin % 60)}`
}

/** Localized clock text for a local-minute value (digits follow the page locale). */
export function formatClock(localMin: number, locale: string): string {
	const date = new Date(
		Date.UTC(2000, 0, 1, Math.floor(localMin / 60) % 24, localMin % 60),
	)
	try {
		return new Intl.DateTimeFormat(latinDigits(locale), {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: 'UTC',
		}).format(date)
	} catch {
		return formatHhmm(localMin)
	}
}

export function parseHhmm(text: string | null | undefined): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec((text ?? '').trim())
	if (!match) return null
	const hours = Number(match[1])
	const minutes = Number(match[2])
	if (hours > 23 || minutes > 59) return null
	return hours * 60 + minutes
}

/** A calendar date (`YYYY-MM-DD`) shown without any zone shift. */
export function formatDateLong(isoDate: string, locale: string): string {
	const [y, m, d] = isoDate.split('-').map(Number)
	if (!y || !m || !d) return isoDate
	try {
		return new Intl.DateTimeFormat(latinDigits(locale), {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC',
		}).format(new Date(Date.UTC(y, m - 1, d)))
	} catch {
		return isoDate
	}
}

export function formatDateShort(isoDate: string, locale: string): string {
	const [y, m, d] = isoDate.split('-').map(Number)
	if (!y || !m || !d) return isoDate
	try {
		return new Intl.DateTimeFormat(latinDigits(locale), {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC',
		}).format(new Date(Date.UTC(y, m - 1, d)))
	} catch {
		return isoDate
	}
}

export function addDaysIso(isoDate: string, days: number): string {
	const [y, m, d] = isoDate.split('-').map(Number)
	const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days))
	return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** Today's calendar date in an IANA zone. */
export function todayIn(timeZone: string, now: number = Date.now()): string {
	try {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(new Date(now))
		return /^\d{4}-\d{2}-\d{2}$/.test(parts)
			? parts
			: new Date(now).toISOString().slice(0, 10)
	} catch {
		return new Date(now).toISOString().slice(0, 10)
	}
}

/** The visitor's own zone, or `null` when the browser will not say. */
export function visitorTimeZone(): string | null {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || null
	} catch {
		return null
	}
}

/**
 * Names the restaurant's zone when the visitor's differs, so a time is never
 * read as the visitor's own. `null` when both match.
 */
export function zoneNote(
	restaurantZone: string,
	visitorZone: string | null = visitorTimeZone(),
	now: number = Date.now(),
): string | null {
	if (!restaurantZone || !visitorZone || restaurantZone === visitorZone) {
		return null
	}
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: restaurantZone,
			timeZoneName: 'short',
		}).formatToParts(new Date(now))
		const abbreviation = parts.find(
			(part) => part.type === 'timeZoneName',
		)?.value
		return abbreviation ? `${restaurantZone} (${abbreviation})` : restaurantZone
	} catch {
		return restaurantZone
	}
}
