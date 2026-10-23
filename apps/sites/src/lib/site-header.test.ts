import { describe, expect, it } from 'vitest'
import {
	headerNeedsCompactNavigation,
	isCurrentHeaderLink,
} from './site-header'

describe('header current-page links', () => {
	const current = new URL('https://bakery.example/ar/menu?location=main')

	it('matches locale-prefixed pages and normalizes trailing slashes', () => {
		expect(isCurrentHeaderLink('/ar/menu', current)).toBe(true)
		expect(isCurrentHeaderLink('/ar/menu/', current)).toBe(true)
		expect(isCurrentHeaderLink('/ar/menu?location=other', current)).toBe(true)
	})

	it('does not treat another locale or a child page as the current page', () => {
		expect(isCurrentHeaderLink('/menu', current)).toBe(false)
		expect(isCurrentHeaderLink('/ar/menu/checkout', current)).toBe(false)
		expect(isCurrentHeaderLink('/ar/', current)).toBe(false)
	})

	it('does not mark section links, external URLs, or contact links current', () => {
		expect(isCurrentHeaderLink('#menu', current)).toBe(false)
		expect(isCurrentHeaderLink('/ar/menu#pastries', current)).toBe(false)
		expect(isCurrentHeaderLink('', current)).toBe(false)
		expect(isCurrentHeaderLink('http://[', current)).toBe(false)
		expect(isCurrentHeaderLink('https://other.example/ar/menu', current)).toBe(
			false,
		)
		expect(isCurrentHeaderLink('mailto:hello@example.com', current)).toBe(false)
		expect(isCurrentHeaderLink('tel:+15550000000', current)).toBe(false)
	})

	it('handles home-page links without mistaking every route for home', () => {
		expect(isCurrentHeaderLink('/', new URL('https://bakery.example/'))).toBe(
			true,
		)
		expect(isCurrentHeaderLink('/', current)).toBe(false)
	})
})

describe('header navigation fitting', () => {
	const widths = {
		available: 1088,
		brand: 210,
		navigation: 420,
		actions: 300,
		gap: 24,
	}
	it('keeps desktop navigation when all groups fit comfortably', () => {
		expect(headerNeedsCompactNavigation(widths)).toBe(false)
	})
	it('uses the menu before long labels crowd other controls', () => {
		expect(headerNeedsCompactNavigation({ ...widths, navigation: 580 })).toBe(
			true,
		)
	})
	it('accounts for customer-name and language-control width changes', () => {
		expect(headerNeedsCompactNavigation({ ...widths, actions: 500 })).toBe(true)
	})
	it('does not collapse an empty navigation', () => {
		expect(
			headerNeedsCompactNavigation({
				...widths,
				available: 100,
				navigation: 0,
			}),
		).toBe(false)
	})
})
