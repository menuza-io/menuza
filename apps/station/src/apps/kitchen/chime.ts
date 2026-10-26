/**
 * A short two-note chime for a new ticket. Browsers only let a page play sound
 * after a tap, so the sound toggle primes the audio when it is switched on.
 */
let context: AudioContext | null = null

function audio(): AudioContext | null {
	try {
		context ??= new AudioContext()
		// Without a tap (iPad Safari) this is refused: the chime is skipped, not an error.
		if (context.state === 'suspended') void context.resume().catch(() => {})
		return context
	} catch {
		return null
	}
}

/** Called from a tap: lets later chimes play (iPad Safari needs one per page load). */
export function unlockChime() {
	audio()
}

/** Whether a chime would be heard now (the audio was allowed by a tap). */
export const chimeReady = () => context?.state === 'running'

export function chime() {
	const ctx = audio()
	if (!ctx) return
	const start = ctx.currentTime
	;[880, 1320].forEach((frequency, index) => {
		const at = start + index * 0.18
		const tone = ctx.createOscillator()
		const gain = ctx.createGain()
		tone.type = 'sine'
		tone.frequency.value = frequency
		gain.gain.setValueAtTime(0.0001, at)
		gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02)
		gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
		tone.connect(gain).connect(ctx.destination)
		tone.start(at)
		tone.stop(at + 0.17)
	})
}
