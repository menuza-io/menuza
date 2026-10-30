import { msg } from '@lingui/macro'
import { describe, expect, it } from 'vitest'
import {
	aspectRatioFor,
	buildPhotoStudioPrompt,
	generalPhotoStudio,
	resolvePhotoStudioOptions,
	type PhotoStudioVertical,
} from './photo-studio.ts'

const preset = generalPhotoStudio.presets[0]!

const restaurant: PhotoStudioVertical = {
	...generalPhotoStudio,
	id: 'restaurant',
	subject: 'dish',
	options: [
		{
			id: 'keepDishware',
			label: msg`Keep dishware`,
			description: msg`Keep the plate from your photo`,
			defaultValue: false,
			whenOn: 'Keep the plate, bowl and cutlery from image 1.',
			whenOff: 'Replace the plate with dishware that suits the style.',
		},
	],
}

describe('aspectRatioFor', () => {
	it('picks the closest supported ratio', () => {
		expect(aspectRatioFor(1200, 997)).toBe('5:4')
		expect(aspectRatioFor(1080, 1920)).toBe('9:16')
		expect(aspectRatioFor(1000, 1000)).toBe('1:1')
		expect(aspectRatioFor(4000, 3000)).toBe('4:3')
	})

	it('falls back to square without dimensions', () => {
		expect(aspectRatioFor(null, 500)).toBe('1:1')
	})
})

describe('buildPhotoStudioPrompt', () => {
	it('describes a preset and keeps the subject unchanged', () => {
		const prompt = buildPhotoStudioPrompt({
			vertical: generalPhotoStudio,
			style: { type: 'preset', preset },
			options: {},
		})
		expect(prompt).toContain(`Restage image 1 as ${preset.prompt}.`)
		expect(prompt).toContain('Keep the main subject from image 1 identical')
		expect(prompt).not.toContain('Image 2')
	})

	it('numbers the style reference and the previous result', () => {
		const prompt = buildPhotoStudioPrompt({
			vertical: generalPhotoStudio,
			style: { type: 'reference' },
			options: {},
			instructions: 'Darker background',
			refining: true,
		})
		expect(prompt).toContain('Image 2 is a style reference.')
		expect(prompt).toContain('Image 3 is the previous result.')
		expect(prompt).toContain('--- change ---\nDarker background\n--- end ---')
	})

	it('adds the line for each vertical option', () => {
		const off = buildPhotoStudioPrompt({
			vertical: restaurant,
			style: { type: 'preset', preset },
			options: {},
		})
		expect(off).toContain('Keep the dish from image 1 identical')
		expect(off).toContain('Replace the plate with dishware')

		const on = buildPhotoStudioPrompt({
			vertical: restaurant,
			style: { type: 'preset', preset },
			options: { keepDishware: true },
		})
		expect(on).toContain('Keep the plate, bowl and cutlery from image 1.')
	})

	it('caps extra direction', () => {
		const prompt = buildPhotoStudioPrompt({
			vertical: generalPhotoStudio,
			style: { type: 'preset', preset },
			options: {},
			instructions: 'x'.repeat(2_000),
		})
		expect(prompt).not.toContain('x'.repeat(501))
	})
})

describe('resolvePhotoStudioOptions', () => {
	it('keeps known booleans and fills defaults', () => {
		expect(
			resolvePhotoStudioOptions(restaurant, {
				keepDishware: true,
				unknown: true,
			}),
		).toEqual({ keepDishware: true })
		expect(
			resolvePhotoStudioOptions(restaurant, { keepDishware: 'yes' }),
		).toEqual({ keepDishware: false })
	})
})
