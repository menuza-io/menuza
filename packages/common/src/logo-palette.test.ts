import { describe, expect, it } from 'vitest'
import { samplesFromPng, solidPng } from './logo-png.ts'
import {
	DEFAULT_SITE_THEME,
	contrastRatio,
	paletteMeetsContrast,
	suggestLogoPalette,
	themeWithLogoPalette,
} from './site-theme.ts'

function hexToRgb(hex: string) {
	const value = hex.replace('#', '')
	return {
		r: Number.parseInt(value.slice(0, 2), 16),
		g: Number.parseInt(value.slice(2, 4), 16),
		b: Number.parseInt(value.slice(4, 6), 16),
	}
}

describe('logo palette (#396)', () => {
	it('turns a logo into a palette that passes contrast checks', () => {
		const bytes = solidPng(180, 30, 40)
		const samples = samplesFromPng(bytes)
		expect(samples.length).toBeGreaterThan(0)
		expect(samples[0]).toEqual({ r: 180, g: 30, b: 40 })
		const palette = suggestLogoPalette(samples)
		expect(paletteMeetsContrast(palette)).toBe(true)
		const primary = hexToRgb(palette.cssVars.primary!)
		const primaryText = hexToRgb(palette.cssVars['primary-foreground']!)
		const background = hexToRgb(palette.cssVars.background!)
		const foreground = hexToRgb(palette.cssVars.foreground!)
		expect(contrastRatio(primary, primaryText)).toBeGreaterThanOrEqual(4.5)
		expect(contrastRatio(background, foreground)).toBeGreaterThanOrEqual(4.5)
	})

	it('keeps a pale logo readable by darkening the button', () => {
		const palette = suggestLogoPalette([{ r: 255, g: 230, b: 80 }])
		expect(paletteMeetsContrast(palette)).toBe(true)
	})

	it('applies the palette onto a copy of the theme', () => {
		const live = { ...DEFAULT_SITE_THEME, cssVars: { radius: '0px' } }
		const next = themeWithLogoPalette(live, [{ r: 20, g: 80, b: 60 }])
		expect(live.cssVars).toEqual({ radius: '0px' })
		expect(next.cssVars?.primary).toMatch(/^#[0-9a-f]{6}$/)
		expect(next.cssVars?.radius).toBe('0px')
		expect(next).not.toBe(live)
	})
})
