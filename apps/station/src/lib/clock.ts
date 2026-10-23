import { create } from 'zustand'

/**
 * How far this tablet's clock is from the server's. Every timestamp the till
 * records (business date, payments, refunds, the time signed into a fiscal
 * document) comes from the tablet, so a wrong clock mis-dates invoices. The
 * offset is learned from the `Date` header of tenant-api answers and kept for
 * this session only: a reload, or the next answer, measures it again.
 *
 * The server must expose `Date` to the browser (`Access-Control-Expose-Headers`);
 * when it is not readable nothing is known and nothing is blocked.
 */

/** Beyond this the till warns, and refuses to sign ZATCA documents. */
export const MAX_CLOCK_SKEW_MS = 2 * 60_000

type ClockState = {
	/** Server time minus tablet time when last measured, or null when unknown. */
	skewMs: number | null
}

export const useClock = create<ClockState>(() => ({ skewMs: null }))

/**
 * Records the offset from one server answer. `sentAt` is when the request
 * left: the server stamped its answer somewhere between then and now, so the
 * midpoint is the fairest local time to compare with (the header has whole
 * seconds only, which is far finer than the limit).
 */
export function noteServerDate(
	response: Pick<Response, 'headers'>,
	sentAt: number,
	now = Date.now(),
): void {
	const header = response.headers.get('Date')
	if (!header) return
	const server = Date.parse(header)
	if (!Number.isFinite(server)) return
	const local = sentAt + (now - sentAt) / 2
	useClock.setState({ skewMs: server - local })
}

/** The measured offset, or null when no answer has carried one. */
export const clockSkewMs = (): number | null => useClock.getState().skewMs

/** True when the tablet's clock is known to be off by more than the limit. */
export const clockIsOff = (skew = clockSkewMs()): boolean =>
	skew !== null && Math.abs(skew) > MAX_CLOCK_SKEW_MS

/** Whole minutes the clock is off by, for messages. */
export const skewMinutes = (skew = clockSkewMs()): number =>
	skew === null ? 0 : Math.round(Math.abs(skew) / 60_000)

/**
 * A clock that only moves forward, for waits that must not end early when
 * someone changes the tablet's time (the PIN lockout). It restarts with the
 * page, so it complements, never replaces, a stored wall-clock deadline.
 */
export const monotonicNow = (): number =>
	typeof performance !== 'undefined' ? performance.now() : Date.now()

/** The server's time as best known: the tablet's clock corrected by the measured offset. */
export const serverNow = (now = Date.now()): number =>
	now + (clockSkewMs() ?? 0)
