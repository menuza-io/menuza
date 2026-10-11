import { describe, expect, it } from 'vitest'
import { normalizePairingCode } from './kiosk-terminal.tsx'
import { formatPairingCode } from './pair-kiosk-dialog.tsx'

describe('kiosk pairing codes', () => {
	it('groups a code for reading and accepts it back as typed', () => {
		const code = 'K7M2Q9X4BD'
		const shown = formatPairingCode(code)
		expect(shown).toBe('K7M2Q-9X4BD')
		expect(normalizePairingCode(shown)).toBe(code)
		expect(normalizePairingCode(' k7m2q 9x4bd ')).toBe(code)
	})

	it('maps Crockford look-alike letters to digits', () => {
		expect(normalizePairingCode('O1Il-oLi0')).toBe('01110110')
	})
})
