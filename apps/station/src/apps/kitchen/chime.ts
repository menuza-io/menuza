import { createChimePlayer } from '@repo/common/order-chime'

/**
 * A short two-note chime for a new ticket. Browsers only let a page play sound
 * after a tap, so the sound toggle primes the audio when it is switched on. The
 * sound system is shared with the App's Orders page (`@repo/common/order-chime`).
 */
const player = createChimePlayer()

/** Called from a tap: lets later chimes play (iPad Safari needs one per page load). */
export function unlockChime() {
	player.unlock()
}

/** Whether a chime would be heard now (the audio was allowed by a tap). */
export const chimeReady = () => player.ready()

export function chime() {
	// Without a tap the browser refuses the audio: the chime is skipped, not an error.
	player.play({ sound: 'chime', volume: 0.83 })
}
