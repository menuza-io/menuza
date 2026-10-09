/**
 * Checkout hold countdown for the success page. The tenant-api sets
 * `holdExpiresAt` only after `POST /orders` succeeds for an online-payment
 * order; unpaid orders are released when it passes. Pure helpers so the
 * timing rules are unit-testable without a browser.
 */

/**
 * Milliseconds left on a live hold, or `null` when there is nothing to count
 * down: payment is not pending, the hold is missing/unparseable, or it has
 * already passed.
 */
export function liveHoldRemainingMs(
	input: { paymentStatus?: string | null; holdExpiresAt?: string | null },
	now: number,
): number | null {
	if (input.paymentStatus !== 'pending' || !input.holdExpiresAt) return null
	const instant = Date.parse(input.holdExpiresAt)
	if (Number.isNaN(instant)) return null
	const remaining = instant - now
	return remaining > 0 ? remaining : null
}

/** Whole minutes shown on the clock, rounded up: 4:01 → 5, 4:00 → 4. */
export function minutesLeft(remainingMs: number): number {
	const totalSeconds = Math.floor(Math.max(0, remainingMs) / 1000)
	return Math.ceil(totalSeconds / 60)
}

/**
 * Minute marks worth a screen reader announcement: every minute in the last
 * five, every five minutes up to half an hour, then every ten.
 */
export function isAnnouncementMark(minutes: number): boolean {
	if (minutes <= 0) return false
	if (minutes <= 5) return true
	if (minutes <= 30) return minutes % 5 === 0
	return minutes % 10 === 0
}

/**
 * Throttles live-region updates to minute marks. Returns the minutes to
 * announce when the clock crossed a mark since the previous tick (a
 * backgrounded tab can skip several), otherwise `null`. The visible timer
 * still updates every second; only speech is throttled.
 */
export function holdAnnouncement(
	previousMs: number | null,
	remainingMs: number,
): number | null {
	if (previousMs === null) return null
	const before = minutesLeft(previousMs)
	const now = minutesLeft(remainingMs)
	if (now <= 0 || now >= before) return null
	// Every whole minute in [now, before) was reached; any mark among them
	// counts, announced as the current value.
	for (let minute = now; minute < before; minute++) {
		if (isAnnouncementMark(minute)) return now
	}
	return null
}

/** Last-minute urgency: the banner turns from warning to danger. */
export function isFinalMinute(remainingMs: number): boolean {
	return remainingMs > 0 && remainingMs <= 60_000
}

/**
 * Clock face for the hold: "4:59", or "1:05:00" for holds over an hour.
 * Digits follow the page locale; the caller isolates it as LTR.
 */
export function formatHoldClock(
	remainingMs: number,
	locale: string = 'en',
): string {
	const totalSeconds = Math.floor(Math.max(0, remainingMs) / 1000)
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	let pad: (value: number) => string
	let plain: (value: number) => string
	try {
		const two = new Intl.NumberFormat(locale, {
			minimumIntegerDigits: 2,
			useGrouping: false,
		})
		const one = new Intl.NumberFormat(locale, { useGrouping: false })
		pad = (value) => two.format(value)
		plain = (value) => one.format(value)
	} catch {
		pad = (value) => String(value).padStart(2, '0')
		plain = (value) => String(value)
	}
	return hours > 0
		? `${plain(hours)}:${pad(minutes)}:${pad(seconds)}`
		: `${plain(minutes)}:${pad(seconds)}`
}

/** Spoken duration for announcements and notes: "4 minutes", "1 minute". */
export function formatMinutesLong(
	minutes: number,
	locale: string = 'en',
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'unit',
			unit: 'minute',
			unitDisplay: 'long',
		}).format(minutes)
	} catch {
		return `${minutes} min`
	}
}
