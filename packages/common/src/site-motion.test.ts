import { describe, expect, it } from 'vitest'
import {
	FEATURE_ICON_KEYS,
	heroSlideshow,
	heroSlides,
	isFeatureIconKey,
	scrollingStripItems,
} from './site-motion.ts'

describe('hero slideshow and strip (#240)', () => {
	it('keeps at most six photos and falls back to the single image', () => {
		const many = Array.from({ length: 8 }, (_, index) => ({
			url: `https://cdn.example/${index}.jpg`,
			alt: String(index),
		}))
		expect(heroSlides({ slides: many })).toHaveLength(6)
		expect(heroSlideshow(heroSlides({ slides: many }))).toBe(true)
		expect(heroSlides({ imageUrl: 'https://cdn.example/one.jpg' })).toEqual([
			{ url: 'https://cdn.example/one.jpg', alt: '' },
		])
		expect(
			heroSlideshow(heroSlides({ imageUrl: 'https://cdn.example/one.jpg' })),
		).toBe(false)
	})

	it('accepts only the fixed feature icons', () => {
		expect(isFeatureIconKey('leaf')).toBe(true)
		expect(isFeatureIconKey('rocket')).toBe(false)
		expect(FEATURE_ICON_KEYS).toContain('utensils')
	})

	it('reads strip items and drops blanks', () => {
		expect(
			scrollingStripItems({
				items: [{ text: ' Fresh bread ' }, { text: '  ' }, 'Open late'],
			}),
		).toEqual([{ text: 'Fresh bread' }, { text: 'Open late' }])
	})
})
