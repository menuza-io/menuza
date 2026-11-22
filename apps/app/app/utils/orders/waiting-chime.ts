import {
	clampVolume,
	createChimePlayer,
	isChimeSound,
	type ChimeSound,
} from '@repo/common/order-chime'

/**
 * The Orders page's sound (#265), one for every alert on it: the "Waiting for
 * you" lane, and the new-order alert. The sound system is the one Station's
 * kitchen shares (`@repo/common/order-chime`). Browsers only let a page play
 * sound after a tap, so "Sound on" and the bell's Test button prime the audio;
 * the choices (sound on or off, volume, which of three sounds) are remembered
 * per browser.
 */
export const chimePlayer = createChimePlayer()

export type OrderSoundPrefs = {
	enabled: boolean
	/** 0 to 1. */
	volume: number
	sound: ChimeSound
	/** The one-line "turn on sound" prompt was answered. */
	promptAnswered: boolean
}

export const DEFAULT_SOUND_PREFS: OrderSoundPrefs = {
	enabled: false,
	volume: 0.8,
	sound: 'chime',
	promptAnswered: false,
}

const PREFS_KEY = 'orders.soundPrefs.v1'

export function readSoundPrefs(): OrderSoundPrefs {
	try {
		const raw = window.localStorage.getItem(PREFS_KEY)
		if (!raw) return { ...DEFAULT_SOUND_PREFS }
		const parsed = JSON.parse(raw) as Partial<OrderSoundPrefs>
		return {
			enabled: parsed.enabled === true,
			volume: clampVolume(parsed.volume, DEFAULT_SOUND_PREFS.volume),
			sound: isChimeSound(parsed.sound) ? parsed.sound : 'chime',
			promptAnswered: parsed.promptAnswered === true,
		}
	} catch {
		return { ...DEFAULT_SOUND_PREFS }
	}
}

export function writeSoundPrefs(
	patch: Partial<OrderSoundPrefs>,
): OrderSoundPrefs {
	const next = { ...readSoundPrefs(), ...patch }
	try {
		window.localStorage.setItem(PREFS_KEY, JSON.stringify(next))
	} catch {
		// Private mode: the choice lasts until the page is closed.
	}
	return next
}

/** Called from a tap: lets later chimes play. */
export function unlockChime() {
	chimePlayer.unlock()
}

/** Whether a chime would be heard now. */
export const chimeReady = () => chimePlayer.ready()

/** Plays the chosen sound at the chosen volume (a quieter one for `soft`). */
export function playChime(options: { soft?: boolean } = {}) {
	const prefs = readSoundPrefs()
	return chimePlayer.play({
		sound: prefs.sound,
		volume: prefs.volume,
		soft: options.soft,
	})
}

/** Plays a given sound, whatever is saved (the Test button, the sound picker). */
export function playSample(sound: ChimeSound, volume: number) {
	return chimePlayer.play({ sound, volume })
}

/** Whether the member has the sound on (the page may still be waiting for a tap). */
export function readSoundChoice(): boolean {
	return readSoundPrefs().enabled
}

export function writeSoundChoice() {
	writeSoundPrefs({ enabled: true, promptAnswered: true })
}

/** Sound turned off: remembered, so it stays off after a reload. */
export function clearSoundChoice() {
	writeSoundPrefs({ enabled: false })
}

/**
 * Whether the orders inbox should refresh on its timer: while the tab shows,
 * and also while it is hidden if the chime is on, so a new order that waits
 * for acceptance is heard from another tab.
 */
export function shouldPollOrders(
	visibility: DocumentVisibilityState,
	soundOn: boolean,
): boolean {
	return visibility === 'visible' || soundOn
}
