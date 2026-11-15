/**
 * The gap between this computer's clock and the server's, for countdowns to a
 * deadline the server set (for example the time left to accept an order). A
 * clock a few minutes off would otherwise say "Time is up" while the order can
 * still be accepted, or the other way round.
 *
 * The browser learns the gap from the region's own clock: the operator orders
 * list and detail answers carry `serverNow`, and the gap is measured against
 * the middle of the round trip. Without a reading the offset is 0 (the local
 * clock).
 */
let offsetMs = 0

/** Note a server clock reading `serverNow` taken between `sentAt` and `receivedAt`. */
export function recordServerClock(
	serverNow: number,
	sentAt: number,
	receivedAt: number = Date.now(),
) {
	if (!Number.isFinite(serverNow) || !Number.isFinite(sentAt)) return
	offsetMs = Math.round(serverNow - (sentAt + receivedAt) / 2)
}

/** The server's time now, as best this browser can tell (ms since epoch). */
export function serverNow(): number {
	return Date.now() + offsetMs
}

/** Forget the reading (tests). */
export function resetServerClock() {
	offsetMs = 0
}
