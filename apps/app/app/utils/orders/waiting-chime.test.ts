// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
	clearSoundChoice,
	readSoundChoice,
	shouldPollOrders,
	writeSoundChoice,
} from './waiting-chime.ts'

describe('waiting chime choice', () => {
	beforeEach(() => window.sessionStorage.clear())

	it('remembers the choice for the tab session and forgets it when turned off', () => {
		expect(readSoundChoice()).toBe(false)
		writeSoundChoice()
		expect(readSoundChoice()).toBe(true)
		clearSoundChoice()
		expect(readSoundChoice()).toBe(false)
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
