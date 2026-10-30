import { describe, expect, it } from 'vitest'
import {
	createPrintCatalog,
	printArtworkFit,
	printArtworkSchema,
} from './print-shop.ts'

const A3 = { widthMm: 297, heightMm: 420 }

describe('printArtworkFit', () => {
	it('accepts the product size, with or without an even bleed', () => {
		expect(printArtworkFit(A3, { widthMm: 297, heightMm: 420 })).toEqual({
			fits: true,
			bleedMm: 0,
		})
		expect(printArtworkFit(A3, { widthMm: 303, heightMm: 426 })).toEqual({
			fits: true,
			bleedMm: 3,
		})
		// Rounding of a PDF's point sizes is not bleed.
		expect(printArtworkFit(A3, { widthMm: 297.4, heightMm: 420.6 })).toEqual({
			fits: true,
			bleedMm: 0,
		})
	})

	it('never records more bleed than an artwork may have', () => {
		// 7 mm a side (311 × 434) is past the 6 mm limit.
		expect(printArtworkFit(A3, { widthMm: 311, heightMm: 434 })).toEqual({
			fits: false,
		})
		const rounded = printArtworkFit(A3, { widthMm: 309.4, heightMm: 432.4 })
		expect(rounded).toEqual({ fits: true, bleedMm: 6 })
		expect(
			printArtworkSchema.shape.bleedMm.safeParse(
				(rounded as { bleedMm: number }).bleedMm,
			).success,
		).toBe(true)
	})

	it('refuses another size, the other orientation, uneven or huge bleed', () => {
		for (const page of [
			{ widthMm: 210, heightMm: 297 },
			{ widthMm: 420, heightMm: 297 },
			{ widthMm: 309, heightMm: 426 },
			{ widthMm: 321, heightMm: 444 },
		]) {
			expect(printArtworkFit(A3, page)).toEqual({ fits: false })
		}
	})
})

describe('catalog artwork products', () => {
	it('takes artwork only for products that may go without a QR code', () => {
		const catalog = createPrintCatalog({
			products: [
				{
					key: 'seat_card',
					family: 'card',
					shippable: true,
					featuredItems: false,
					qrTargets: ['site'],
					sizes: [{ key: 'a6', widthMm: 105, heightMm: 148, label: 'A6' }],
				},
			],
		})
		expect(catalog.acceptsArtwork('poster')).toBe(true)
		expect(catalog.acceptsArtwork('window_sticker')).toBe(true)
		expect(catalog.acceptsArtwork('seat_card')).toBe(false)
		expect(catalog.acceptsArtwork('missing')).toBe(false)
	})
})
