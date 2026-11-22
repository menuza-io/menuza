/**
 * The order chime, shared by the App's Orders page (#265) and Station's
 * kitchen screen: one sound system, three sounds. Browsers only let a page
 * play sound after a tap, so the page "unlocks" the audio from a tap (the
 * bell's Test button, "Sound on") and a chime that is played before that is
 * skipped, never an error.
 */

export const CHIME_SOUNDS = ['chime', 'bell', 'pulse'] as const
export type ChimeSound = (typeof CHIME_SOUNDS)[number]

export function isChimeSound(value: unknown): value is ChimeSound {
	return (
		typeof value === 'string' &&
		(CHIME_SOUNDS as readonly string[]).includes(value)
	)
}

type Note = { frequency: number; at: number; length: number }

type SoundShape = {
	wave: OscillatorType
	notes: readonly Note[]
}

/** A softer sound (a scheduled order placed, not one to start now) plays at this share. */
export const SOFT_CHIME_GAIN = 0.45

const SHAPES: Record<ChimeSound, SoundShape> = {
	// The kitchen's original two notes.
	chime: {
		wave: 'sine',
		notes: [
			{ frequency: 880, at: 0, length: 0.17 },
			{ frequency: 1320, at: 0.18, length: 0.17 },
		],
	},
	bell: {
		wave: 'sine',
		notes: [
			{ frequency: 1046.5, at: 0, length: 0.22 },
			{ frequency: 1318.5, at: 0.2, length: 0.22 },
			{ frequency: 1568, at: 0.4, length: 0.34 },
		],
	},
	pulse: {
		wave: 'triangle',
		notes: [
			{ frequency: 660, at: 0, length: 0.14 },
			{ frequency: 660, at: 0.22, length: 0.14 },
			{ frequency: 660, at: 0.44, length: 0.14 },
		],
	},
}

export type ChimePlayOptions = {
	sound?: ChimeSound
	/** 0 to 1. Default 0.6. */
	volume?: number
	/** Quieter, for an order that does not need doing right now. */
	soft?: boolean
}

export type ChimePlayer = {
	/** Call from a tap: lets later chimes play (iPad Safari needs one per page load). */
	unlock: () => void
	/** Whether a chime would be heard now. */
	ready: () => boolean
	/** `blocked` when the browser has not allowed sound yet or has no audio at all. */
	state: () => 'running' | 'blocked' | 'unsupported'
	/** Plays once. Returns false when nothing could play. */
	play: (options?: ChimePlayOptions) => boolean
}

export function clampVolume(value: unknown, fallback = 0.6): number {
	const n = typeof value === 'number' ? value : Number.NaN
	if (!Number.isFinite(n)) return fallback
	return Math.min(1, Math.max(0, n))
}

/** `create` is injected so a test can supply a fake audio context. */
export function createChimePlayer(
	create: () => AudioContext = () => new AudioContext(),
): ChimePlayer {
	let context: AudioContext | null = null
	let unsupported = false

	function audio(): AudioContext | null {
		if (unsupported) return null
		try {
			context ??= create()
			// Without a tap (iPad Safari) this is refused: the chime is skipped.
			if (context.state === 'suspended') void context.resume().catch(() => {})
			return context
		} catch {
			unsupported = true
			return null
		}
	}

	return {
		unlock() {
			audio()
		},
		ready: () => context?.state === 'running',
		state: () => {
			if (unsupported) return 'unsupported'
			return context?.state === 'running' ? 'running' : 'blocked'
		},
		play(options = {}) {
			const ctx = audio()
			if (!ctx || ctx.state !== 'running') return false
			const shape = SHAPES[options.sound ?? 'chime']
			const peak =
				0.3 * clampVolume(options.volume) * (options.soft ? SOFT_CHIME_GAIN : 1)
			if (peak <= 0) return true
			const start = ctx.currentTime
			for (const note of shape.notes) {
				const at = start + note.at
				const tone = ctx.createOscillator()
				const gain = ctx.createGain()
				tone.type = shape.wave
				tone.frequency.value = note.frequency
				gain.gain.setValueAtTime(0.0001, at)
				gain.gain.exponentialRampToValueAtTime(peak, at + 0.02)
				gain.gain.exponentialRampToValueAtTime(0.0001, at + note.length - 0.01)
				tone.connect(gain).connect(ctx.destination)
				tone.start(at)
				tone.stop(at + note.length)
			}
			return true
		},
	}
}
