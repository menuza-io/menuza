import { describe, expect, it } from 'vitest'

import {
	oklchToHex,
	radiusToPx,
	resolveEmailAssetUrl,
	resolveEmailTheme,
	solidEmailTheme,
	toEmailColor,
	toSolidHex,
} from './email-theme'

describe('oklchToHex', () => {
	it('converts black and white exactly', () => {
		expect(oklchToHex('oklch(0 0 0)')).toBe('#000000')
		expect(oklchToHex('oklch(1 0 0)')).toBe('#ffffff')
	})

	it('converts a saturated color to a hex value', () => {
		const hex = oklchToHex('oklch(0.55 0.22 264)')
		expect(hex).toMatch(/^#[0-9a-f]{6}$/)
	})

	it('returns rgba when an alpha channel is present', () => {
		expect(oklchToHex('oklch(0 0 0 / 50%)')).toMatch(/^rgba\(/)
	})

	it('accepts percentage lightness', () => {
		expect(oklchToHex('oklch(0% 0 0)')).toBe('#000000')
		expect(oklchToHex('oklch(100% 0 0)')).toBe('#ffffff')
	})

	it('returns null for non-oklch input', () => {
		expect(oklchToHex('#ffffff')).toBeNull()
		expect(oklchToHex('rgb(0, 0, 0)')).toBeNull()
	})
})

describe('toEmailColor', () => {
	it('converts oklch values', () => {
		expect(toEmailColor('oklch(0 0 0)', '#123456')).toBe('#000000')
	})

	it('passes through email-safe formats', () => {
		expect(toEmailColor('#2563EB', '#000')).toBe('#2563EB')
		expect(toEmailColor('rgb(1, 2, 3)', '#000')).toBe('rgb(1, 2, 3)')
		expect(toEmailColor('hsl(210 90% 50%)', '#000')).toBe('hsl(210 90% 50%)')
	})

	it('falls back for empty or unparseable oklch', () => {
		expect(toEmailColor(null, '#abcdef')).toBe('#abcdef')
		expect(toEmailColor('   ', '#abcdef')).toBe('#abcdef')
		expect(toEmailColor('oklch(bogus)', '#abcdef')).toBe('#abcdef')
	})
})

describe('radiusToPx', () => {
	it('converts rem and px, falling back on garbage', () => {
		expect(radiusToPx('0.625rem')).toBe(10)
		expect(radiusToPx('0')).toBe(0)
		expect(radiusToPx('12px')).toBe(12)
		expect(radiusToPx(undefined, 8)).toBe(8)
		expect(radiusToPx('auto', 8)).toBe(8)
	})
})

describe('resolveEmailAssetUrl', () => {
	it('leaves absolute URLs untouched', () => {
		expect(
			resolveEmailAssetUrl('https://cdn.example.com/a.png', 'https://app.test'),
		).toBe('https://cdn.example.com/a.png')
	})

	it('resolves relative asset paths against the app origin', () => {
		expect(
			resolveEmailAssetUrl(
				'/resources/images?objectKey=abc',
				'https://app.test',
			),
		).toBe('https://app.test/resources/images?objectKey=abc')
	})

	it('returns empty for empty input', () => {
		expect(resolveEmailAssetUrl('', 'https://app.test')).toBe('')
		expect(resolveEmailAssetUrl(null, 'https://app.test')).toBe('')
	})
})

describe('resolveEmailTheme', () => {
	it('derives literal colors from the default theme', () => {
		const theme = resolveEmailTheme({ organizationName: 'Acme' })
		expect(theme.organizationName).toBe('Acme')
		expect(theme.logoUrl).toBeNull()
		expect(theme.background).not.toMatch(/oklch/)
		expect(theme.primary).not.toMatch(/oklch/)
		expect(theme.radius).toBeGreaterThanOrEqual(0)
		expect(theme.bodyFont).toContain('sans-serif')
	})

	it('accepts a raw stored theme string', () => {
		const theme = resolveEmailTheme({
			organizationName: 'Acme',
			siteTheme: JSON.stringify({ baseColor: 'zinc', theme: 'blue' }),
		})
		expect(theme.primary).not.toMatch(/oklch/)
	})
})

describe('solid colors for the reservations context', () => {
	it('lays a transparent color over the background and expands short hex', () => {
		expect(toSolidHex('#E4E4E7', '#000000', '#111111')).toBe('#E4E4E7')
		expect(toSolidHex('#abc', '#000000', '#111111')).toBe('#aabbcc')
		// White at 10% over black is the grey a dark theme's border looks like.
		expect(toSolidHex('rgba(255, 255, 255, 0.1)', '#000000', '#111111')).toBe(
			'#1a1a1a',
		)
		expect(toSolidHex('rgb(255, 0, 0)', '#000000', '#111111')).toBe('#ff0000')
		expect(
			toSolidHex('color-mix(in oklab, red, blue)', '#000000', '#111111'),
		).toBe('#111111')
		// An unusable backdrop mixes over the fallback instead.
		expect(toSolidHex('rgba(1, 2, 3, 0.5)', 'not-a-color', '#111111')).toBe(
			'#090a0a',
		)
		// Alpha is clamped to [0, 1].
		expect(toSolidHex('rgba(255, 255, 255, 0)', '#000000', '#111111')).toBe(
			'#000000',
		)
	})

	it('a dark theme resolves to colors the context schema accepts', () => {
		const theme = solidEmailTheme(
			resolveEmailTheme({
				organizationName: 'Acme',
				siteTheme: JSON.stringify({
					baseColor: 'neutral',
					theme: 'violet',
					radius: 'full',
					mode: 'dark',
					headingFont: 'inter',
					bodyFont: 'inter',
					headingCustomFont: null,
					bodyCustomFont: null,
					cssVars: null,
				}),
			}),
		)
		for (const key of [
			'background',
			'card',
			'foreground',
			'muted',
			'mutedForeground',
			'border',
			'primary',
			'primaryForeground',
			'accent',
			'accentForeground',
		] as const)
			expect(theme[key], key).toMatch(/^#[0-9a-fA-F]{6}$/)
	})
})
