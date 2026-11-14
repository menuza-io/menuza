/**
 * A short two-note chime for an order waiting to be accepted. Browsers only
 * let a page play sound after a tap, so "Turn on sound" primes the audio.
 */
let context: AudioContext | null = null

function audio(): AudioContext | null {
	try {
		context ??= new AudioContext()
		if (context.state === 'suspended') void context.resume().catch(() => {})
		return context
	} catch {
		return null
	}
}

/** Called from a tap: lets later chimes play. */
export function unlockChime() {
	audio()
}

/** Whether a chime would be heard now. */
export const chimeReady = () => context?.state === 'running'

export function playChime() {
	const ctx = audio()
	if (!ctx || ctx.state !== 'running') return
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

const KEY = 'orders.waitingSound'

export function readSoundChoice(): boolean {
	try {
		return window.sessionStorage.getItem(KEY) === 'on'
	} catch {
		return false
	}
}

export function writeSoundChoice() {
	try {
		window.sessionStorage.setItem(KEY, 'on')
	} catch {
		// Private mode: the button simply shows again next time.
	}
}
