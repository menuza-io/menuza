/**
 * Event dates on the website (#184), in the event's own time zone and the
 * reader's language: "Tue, Nov 3 · 8:00 PM – 10:30 PM".
 */
export function formatOccurrence(
	occurrence: { startMs: number; endMs: number },
	timeZone: string,
	locale: string,
): string {
	try {
		const day = new Intl.DateTimeFormat(locale, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			timeZone,
		}).format(new Date(occurrence.startMs))
		const time = new Intl.DateTimeFormat(locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone,
		})
		return `${day} · ${time.format(new Date(occurrence.startMs))} – ${time.format(new Date(occurrence.endMs))}`
	} catch {
		return new Date(occurrence.startMs).toISOString()
	}
}
