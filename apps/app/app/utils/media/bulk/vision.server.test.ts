import { describe, expect, it, vi } from 'vitest'
import {
	buildVisionPrompt,
	cleanVisionLabel,
	createMockDishPhotoVision,
	createModelDishPhotoVision,
} from './vision.server.ts'

const image = { data: new Uint8Array([1]), mediaType: 'image/jpeg' }

describe('mock vision', () => {
	it('is deterministic from the file name', async () => {
		const vision = createMockDishPhotoVision()
		expect(
			await vision.describe(image, { dishNames: [], fileName: 'Our Logo.png' }),
		).toMatchObject({ looksLikeFood: false })
		expect(
			await vision.describe(image, {
				dishNames: [],
				fileName: 'Beef Burger 2.jpg',
			}),
		).toEqual({
			looksLikeFood: true,
			label: 'beef burger',
			qualityScore: 70,
		})
	})
})

describe('model vision', () => {
	it('sends only the image and dish names, and checks the answer again', async () => {
		const generate = vi.fn(async () => ({
			looksLikeFood: true,
			label: '  Pizza\u0000 slice ',
			qualityScore: 71.6,
		}))
		const vision = createModelDishPhotoVision({ generate: generate as never })
		const result = await vision.describe(image, {
			dishNames: ['Pizza'],
			fileName: 'secret-name.jpg',
		})
		expect(result).toEqual({
			looksLikeFood: true,
			label: 'Pizza slice',
			qualityScore: 72,
		})
		const call = generate.mock.calls[0] as unknown as [
			{ prompt: string; files: unknown[] },
		]
		expect(call[0].prompt).not.toContain('secret-name')
		expect(call[0].files).toHaveLength(1)
	})

	it('answers null on a bad answer, an error or an unsupported image type', async () => {
		const bad = createModelDishPhotoVision({
			generate: (async () => ({ nope: 1 })) as never,
		})
		expect(await bad.describe(image, { dishNames: [] })).toBeNull()
		const throwing = createModelDishPhotoVision({
			generate: (async () => {
				throw new Error('down')
			}) as never,
		})
		expect(await throwing.describe(image, { dishNames: [] })).toBeNull()
		const generate = vi.fn()
		const gif = createModelDishPhotoVision({ generate: generate as never })
		expect(
			await gif.describe(
				{ ...image, mediaType: 'image/gif' },
				{ dishNames: [] },
			),
		).toBeNull()
		expect(generate).not.toHaveBeenCalled()
	})

	it('drops the label of a photo that is not food', async () => {
		const vision = createModelDishPhotoVision({
			generate: (async () => ({
				looksLikeFood: false,
				label: 'a receipt',
				qualityScore: null,
			})) as never,
		})
		expect(await vision.describe(image, { dishNames: [] })).toEqual({
			looksLikeFood: false,
			label: null,
			qualityScore: null,
		})
	})

	it('cleans labels and caps the dish names in the prompt', () => {
		expect(cleanVisionLabel('   ')).toBeNull()
		expect(
			buildVisionPrompt(Array.from({ length: 400 }, (_, i) => `Dish ${i}`)),
		).not.toContain('Dish 399')
	})
})
