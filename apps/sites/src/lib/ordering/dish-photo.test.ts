// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
	decorateDishPhoto,
	dishPhotoPosition,
	dishPhotoStyle,
	photoTestAttributes,
} from './dish-photo.ts'

describe('dish photo crop (#394)', () => {
	it('is the centre without a focal point, and never overrides the default crop', () => {
		for (const none of [undefined, null, { x: 0.5, y: 0.5 }]) {
			expect(dishPhotoPosition(none)).toBe('50% 50%')
			expect(dishPhotoStyle(none)).toBeUndefined()
		}
	})

	it('moves the crop toward a top-left point', () => {
		expect(dishPhotoPosition({ x: 0, y: 0 })).toBe('0% 0%')
		expect(dishPhotoStyle({ x: 0, y: 0 })).toBe('object-position: 0% 0%')
		expect(dishPhotoStyle({ x: 0.2, y: 0.35 })).toBe('object-position: 20% 35%')
	})

	it('ignores a focal point that is not a number pair', () => {
		expect(dishPhotoStyle({ x: Number.NaN, y: 0 })).toBeUndefined()
	})
})

describe('photo test markers (#192)', () => {
	const test = {
		id: 'test_abcdefgh',
		imageUrlB: 'https://cdn.test/b.jpg',
		imageFocalB: { x: 0.25, y: 0.75 },
	}

	it('marks a photo with the test, the dish, photo B and its focal point', () => {
		expect(photoTestAttributes('dish_1', test)).toEqual({
			'data-photo-test-id': 'test_abcdefgh',
			'data-photo-test-item': 'dish_1',
			'data-photo-test-src-b': 'https://cdn.test/b.jpg',
			'data-photo-test-focal-b': '0.25,0.75',
		})
	})

	it('adds nothing without a test or without photo B', () => {
		expect(photoTestAttributes('dish_1', null)).toEqual({})
		expect(photoTestAttributes('dish_1', undefined)).toEqual({})
		expect(photoTestAttributes('dish_1', { ...test, imageUrlB: '' })).toEqual(
			{},
		)
	})

	it('decorates a browser-built photo and keeps photo A as the source', () => {
		const img = document.createElement('img')
		img.src = 'https://cdn.test/a.jpg'
		decorateDishPhoto(img, {
			itemId: 'dish_1',
			focal: { x: 0, y: 0 },
			test,
		})
		expect(img.style.objectPosition).toBe('0% 0%')
		expect(img.getAttribute('src')).toBe('https://cdn.test/a.jpg')
		expect(img.dataset.photoTestSrcB).toBe('https://cdn.test/b.jpg')
		const plain = document.createElement('img')
		decorateDishPhoto(plain, { itemId: 'dish_2' })
		expect(plain.getAttribute('style')).toBeNull()
		expect(plain.dataset.photoTestId).toBeUndefined()
	})
})
