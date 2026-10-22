/**
 * Attempt guard for signing in on this device with no connection. Same shape as
 * the server's: a few free typos, then an escalating wait (30 s doubling to 5 min)
 * during which even the right PIN is refused unseen. Counted failures fade after
 * five quiet minutes, and a correct PIN forgives only one. It lives in IndexedDB
 * so a reload does not reset it. It deters a person at the till; it cannot stop
 * someone who controls the device's storage.
 */
export type PinGuard = {
	failures: number
	lastFailureAt: number | null
	blockedUntil: number | null
}

export const EMPTY_GUARD: PinGuard = {
	failures: 0,
	lastFailureAt: null,
	blockedUntil: null,
}

const FREE_FAILURES = 4
const BASE_DELAY_S = 30
const MAX_DELAY_S = 5 * 60
const WINDOW_MS = 5 * 60 * 1000

const decayed = (g: PinGuard, now: number): number => {
	if (g.failures <= 0 || g.lastFailureAt === null) return 0
	return Math.max(
		0,
		g.failures - Math.floor((now - g.lastFailureAt) / WINDOW_MS),
	)
}

/** Whole seconds still to wait, or 0. */
export const waitSeconds = (g: PinGuard, now: number): number =>
	g.blockedUntil !== null && g.blockedUntil > now
		? Math.ceil((g.blockedUntil - now) / 1000)
		: 0

export function afterFailure(
	g: PinGuard,
	now: number,
): { guard: PinGuard; delaySeconds: number } {
	const failures = decayed(g, now) + 1
	const delaySeconds =
		failures <= FREE_FAILURES
			? 0
			: Math.min(
					BASE_DELAY_S * 2 ** Math.min(failures - FREE_FAILURES - 1, 10),
					MAX_DELAY_S,
				)
	return {
		guard: {
			failures,
			lastFailureAt: now,
			blockedUntil:
				delaySeconds > 0 ? now + delaySeconds * 1000 : g.blockedUntil,
		},
		delaySeconds,
	}
}

/** A refused attempt during the wait does not extend it, but is not forgiven either. */
export const afterSuccess = (g: PinGuard, now: number): PinGuard => {
	const failures = Math.max(0, decayed(g, now) - 1)
	return {
		failures,
		lastFailureAt: failures === 0 ? null : now,
		blockedUntil:
			g.blockedUntil !== null && g.blockedUntil > now ? g.blockedUntil : null,
	}
}
