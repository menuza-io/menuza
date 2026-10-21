import { formatHoldClock } from '~/lib/ordering/hold-timer'

/**
 * A hold counts down to the server's `expiresAt`. The visitor's clock may be
 * off, so the offset between the server's `now` and the device clock at
 * response time corrects the target.
 */
export function holdTargetMs(
	hold: { expiresAt: string; now: string },
	deviceNow: number = Date.now(),
): number | null {
	const expires = Date.parse(hold.expiresAt)
	const serverNow = Date.parse(hold.now)
	if (Number.isNaN(expires) || Number.isNaN(serverNow)) return null
	const offset = serverNow - deviceNow
	return expires - offset
}

export function holdRemainingMs(
	targetMs: number,
	deviceNow: number = Date.now(),
): number {
	return Math.max(0, targetMs - deviceNow)
}

export { formatHoldClock }
