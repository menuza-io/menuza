// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
	clearSoundChoice,
	DEFAULT_SOUND_PREFS,
	readSoundChoice,
	readSoundPrefs,
	shouldPollOrders,
	writeSoundChoice,
	writeSoundPrefs,
} from './waiting-chime.ts'

describe('the Orders page sound choices (#265)', () => {
	beforeEach(() => window.localStorage.clear())

	it('remembers on, off, volume and sound per browser', () => {
		expect(readSoundPrefs()).toEqual(DEFAULT_SOUND_PREFS)
		expect(readSoundChoice()).toBe(false)
		writeSoundChoice()
		expect(readSoundChoice()).toBe(true)
		expect(readSoundPrefs().promptAnswered).toBe(true)
		writeSoundPrefs({ volume: 0.3, sound: 'bell' })
		expect(readSoundPrefs()).toMatchObject({
			enabled: true,
			volume: 0.3,
			sound: 'bell',
		})
		clearSoundChoice()
		expect(readSoundChoice()).toBe(false)
		// Still off, with the same volume and sound, after a reload.
		expect(readSoundPrefs()).toMatchObject({ volume: 0.3, sound: 'bell' })
	})

	it('repairs a damaged saved value', () => {
		window.localStorage.setItem(
			'orders.soundPrefs.v1',
			'{"volume":"loud","sound":"gong"}',
		)
		expect(readSoundPrefs()).toEqual(DEFAULT_SOUND_PREFS)
		window.localStorage.setItem('orders.soundPrefs.v1', 'not json')
		expect(readSoundPrefs()).toEqual(DEFAULT_SOUND_PREFS)
	})
})

describe('shouldPollOrders', () => {
	it('polls while the tab shows', () => {
		expect(shouldPollOrders('visible', false)).toBe(true)
		expect(shouldPollOrders('visible', true)).toBe(true)
	})

	it('keeps polling a hidden tab only while the chime is on', () => {
		expect(shouldPollOrders('hidden', true)).toBe(true)
		expect(shouldPollOrders('hidden', false)).toBe(false)
	})
})
