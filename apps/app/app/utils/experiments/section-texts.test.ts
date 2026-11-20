import { parseLocalizedString } from '@repo/common/site-locales'
import { describe, expect, it } from 'vitest'
import {
	applyTextEdits,
	sectionTestableTexts,
	variantDiffers,
} from './section-texts.ts'

const hero = {
	heading: JSON.stringify({ en: 'Welcome', ar: 'أهلا' }),
	subheading: 'Fresh food',
	links: [
		{ url: '/menu', link: { label: JSON.stringify({ en: 'Order now' }) } },
		{ url: '/book', link: { label: 'Book' } },
	],
	minHeight: 560,
	imageUrl: 'https://img',
}

describe('testable texts (#338)', () => {
	it("lists the block's localized texts with concrete paths", () => {
		expect(sectionTestableTexts('hero', hero, 'en')).toEqual([
			{ path: 'heading', value: 'Welcome' },
			{ path: 'subheading', value: 'Fresh food' },
			{ path: 'links.0.link.label', value: 'Order now' },
			{ path: 'links.1.link.label', value: 'Book' },
		])
		expect(sectionTestableTexts('unknown', hero, 'en')).toEqual([])
	})

	it('changes only the edited text and keeps other languages', () => {
		const next = applyTextEdits(
			'hero',
			hero,
			[{ path: 'heading', value: 'Order dinner tonight' }],
			'en',
		)!
		expect(parseLocalizedString(next.heading as string)).toEqual({
			en: 'Order dinner tonight',
			ar: 'أهلا',
		})
		expect(next.subheading).toBe(hero.subheading)
		expect(next.minHeight).toBe(560)
		expect(next.links).toEqual(hero.links)
		// The original is untouched.
		expect(hero.heading).toContain('Welcome')
		expect(variantDiffers(hero, next)).toBe(true)
		expect(variantDiffers(hero, applyTextEdits('hero', hero, [], 'en'))).toBe(
			false,
		)
	})

	it('refuses to touch anything that is not a testable text', () => {
		for (const path of [
			'imageUrl',
			'minHeight',
			'links.0.url',
			'links.5.link.label',
			'__proto__.x',
		]) {
			expect(
				applyTextEdits('hero', hero, [{ path, value: 'x' }], 'en'),
			).toBeNull()
		}
	})

	it('edits a text inside a list', () => {
		const next = applyTextEdits(
			'hero',
			hero,
			[{ path: 'links.0.link.label', value: 'Get 10% off' }],
			'en',
		)!
		expect(
			parseLocalizedString(
				(next.links as Array<{ link: { label: string } }>)[0]!.link.label,
			).en,
		).toBe('Get 10% off')
	})
})
