import { kioskPairingFragment } from '@repo/staffing'
import { describe, expect, it } from 'vitest'
import { buildKioskPairingUrl, parsePairingFragment } from './kiosk-pairing.ts'

const CODE = `kpc1.org_1.${'a'.repeat(43)}`

describe('kiosk pairing link', () => {
	it('puts the code in the fragment, never the path or query', () => {
		const url = buildKioskPairingUrl(
			'https://app.example.com/',
			kioskPairingFragment('us', CODE),
		)
		const parsed = new URL(url)
		expect(parsed.pathname).toBe('/kiosk/pair')
		expect(parsed.search).toBe('')
		expect(parsed.hash).toContain('c=')
		expect(url).not.toContain('?')
	})

	it('round-trips through the parser', () => {
		const url = new URL(
			buildKioskPairingUrl('https://x.test', kioskPairingFragment('ksa', CODE)),
		)
		expect(parsePairingFragment(url.hash)).toEqual({
			region: 'ksa',
			code: CODE,
		})
	})

	it('refuses anything malformed', () => {
		for (const bad of [
			'',
			'#',
			'#r=eu&c=' + CODE,
			'#r=us',
			'#c=' + CODE,
			'#r=us&c=short',
			'#r=us&c=' + 'x'.repeat(161),
		]) {
			expect(parsePairingFragment(bad)).toBeNull()
		}
	})
})
