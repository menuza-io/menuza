/**
 * Service worker updates. A new version is downloaded in the background but only
 * activated when the till is idle (nothing on screen, no sheet open), because
 * activating reloads the page and the cart lives only in memory.
 */
let apply: (() => void) | null = null

export const setUpdater = (fn: () => void): void => {
	apply = fn
}

export const updateWaiting = (): boolean => apply !== null

/** Applies a waiting update if the till is idle. Returns whether it did. */
export function applyUpdateIfIdle(state: {
	cartEmpty: boolean
	dialogOpen: boolean
}): boolean {
	if (!apply || !state.cartEmpty || state.dialogOpen) return false
	const run = apply
	apply = null
	run()
	return true
}
