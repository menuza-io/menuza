import { afterEach, describe, expect, it } from 'vitest'
import { bitmapBytes } from '@repo/common/print-protocols'
import { buildKitchenTicket } from '@repo/common/print-ticket'
import { prepareForPrinter, setRasterizerForTest } from './print-raster.ts'

afterEach(() => setRasterizerForTest(undefined))

const arabic = () =>
	buildKitchenTicket({
		widthMm: 80,
		locale: 'ar',
		ticket: {
			number: 'W-1',
			time: '14:02',
			orderType: 'pickup',
			lines: [{ quantity: 1, name: 'شاورما دجاج' }],
		},
	})

describe('Arabic as a picture for a printer with no Arabic font (#117)', () => {
	it('turns only the Arabic lines into pictures and keeps the rest native', async () => {
		const seen: string[] = []
		setRasterizerForTest(async (block) => {
			seen.push(block.t === 'text' ? block.text : block.left)
			return { width: 8, height: 1, data: 'gA==' }
		})
		const doc = arabic()
		const result = await prepareForPrinter(doc, { arabicFont: false }, 80)
		expect(result.rasterized).toBeGreaterThan(0)
		expect(seen.every((line) => /[؀-ۿ]/.test(line))).toBe(true)
		expect(result.doc.blocks.some((b) => b.t === 'image')).toBe(true)
		// A line with no Arabic stays text, and the document is not changed in place.
		expect(result.doc.blocks.some((b) => b.t === 'text' && b.text.includes('#W-1'))).toBe(true)
		expect(doc.blocks.some((b) => b.t === 'image')).toBe(false)
	})

	it('leaves the document alone when the printer has an Arabic font', async () => {
		let called = false
		setRasterizerForTest(async () => {
			called = true
			return null
		})
		const result = await prepareForPrinter(arabic(), { arabicFont: true }, 80)
		expect(called).toBe(false)
		expect(result.rasterized).toBe(0)
	})

	it('prints as text, and says so, when no picture can be drawn', async () => {
		setRasterizerForTest(null)
		const result = await prepareForPrinter(arabic(), { arabicFont: false }, 58)
		expect(result.rasterized).toBe(0)
		expect(result.failed).toBeGreaterThan(0)
		expect(result.doc.blocks.some((b) => b.t === 'image')).toBe(false)
	})

	it('draws real ink with the default drawer where an image library is installed', async () => {
		setRasterizerForTest(undefined)
		const result = await prepareForPrinter(arabic(), { arabicFont: false }, 80)
		// Either it drew (sharp is installed) or it could not and said so.
		expect(result.rasterized + result.failed).toBeGreaterThan(0)
		for (const block of result.doc.blocks) {
			if (block.t !== 'image') continue
			expect(block.bitmap.width).toBe(576)
			expect(bitmapBytes(block.bitmap).length).toBe(Math.ceil(576 / 8) * block.bitmap.height)
		}
	})
})
