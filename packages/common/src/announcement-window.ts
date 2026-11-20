/**
 * When a website announcement bar is on screen (#238). The public site decides
 * at request time from the stored window (UTC instants), so nothing has to be
 * republished when a window opens or closes, and the page cache is never kept
 * past the next start or end.
 *
 * Both dates empty behaves exactly as before: shown while enabled.
 */

export type AnnouncementWindow = {
	startsAt?: string | number | Date | null
	endsAt?: string | number | Date | null
}

export type AnnouncementStatus = 'off' | 'scheduled' | 'showing' | 'ended'

function instant(value: AnnouncementWindow['startsAt']): number | null {
	if (value === null || value === undefined || value === '') return null
	const ms = new Date(value).getTime()
	return Number.isFinite(ms) ? ms : null
}

/** From the start instant (inclusive) until the end instant (exclusive). */
export function announcementIsInWindow(
	window: AnnouncementWindow,
	now: number,
): boolean {
	const start = instant(window.startsAt)
	const end = instant(window.endsAt)
	if (start !== null && now < start) return false
	if (end !== null && now >= end) return false
	return true
}

/** The list status: Scheduled, Showing or Ended (Off while the switch is off). */
export function announcementStatus(
	announcement: AnnouncementWindow & { isEnabled: boolean },
	now: number,
): AnnouncementStatus {
	const start = instant(announcement.startsAt)
	const end = instant(announcement.endsAt)
	if (end !== null && now >= end) return 'ended'
	if (!announcement.isEnabled) return 'off'
	if (start !== null && now < start) return 'scheduled'
	return 'showing'
}

/** "Until" must be after "from" when both are set. */
export function isAnnouncementWindowValid(window: AnnouncementWindow): boolean {
	const start = instant(window.startsAt)
	const end = instant(window.endsAt)
	return start === null || end === null || end > start
}

/** The announcements the site shows at `now`. */
export function activeAnnouncements<T extends AnnouncementWindow>(
	announcements: readonly T[],
	now: number,
): T[] {
	return announcements.filter((item) => announcementIsInWindow(item, now))
}

/** The next instant after `now` at which any announcement starts or ends. */
export function nextAnnouncementBoundary(
	announcements: readonly AnnouncementWindow[],
	now: number,
): number | null {
	let next: number | null = null
	for (const item of announcements) {
		for (const candidate of [instant(item.startsAt), instant(item.endsAt)]) {
			if (
				candidate !== null &&
				candidate > now &&
				(next === null || candidate < next)
			) {
				next = candidate
			}
		}
	}
	return next
}

/**
 * A `Cache-Control` value for a page that shows these announcements: the
 * usual lifetime, cut so that max-age plus the stale-while-revalidate window
 * ends no later than the next boundary. Without a boundary the usual value
 * is returned.
 */
export function cacheControlBeforeBoundary(
	boundary: number | null,
	now: number,
	usual: { maxAge: number; staleWhileRevalidate: number },
): string {
	const usualValue = `public, max-age=${usual.maxAge}, s-maxage=${usual.maxAge}, stale-while-revalidate=${usual.staleWhileRevalidate}`
	if (boundary === null) return usualValue
	const seconds = Math.floor((boundary - now) / 1000)
	if (seconds >= usual.maxAge + usual.staleWhileRevalidate) return usualValue
	if (seconds <= 0) return 'no-store'
	const maxAge = Math.min(usual.maxAge, seconds)
	const stale = Math.min(
		usual.staleWhileRevalidate,
		Math.max(0, seconds - maxAge),
	)
	return `public, max-age=${maxAge}, s-maxage=${maxAge}${stale > 0 ? `, stale-while-revalidate=${stale}` : ''}`
}
