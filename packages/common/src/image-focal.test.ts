import { describe, expect, it } from 'vitest'
import {
	coverCropRect,
	focalCropUrl,
	mediaIdOfUrl,
	focalCdnOption,
	focalGravity,
	focalObjectPosition,
	focalPointOf,
	formatFocalPoint,
	normalizeFocalPoint,
	parseFocalPoint,
} from './image-focal.ts'

describe('normalizeFocalPoint', () => {
	it('keeps a point and rounds it to two decimals', () => {
		expect(normalizeFocalPoint(0.123, 0.987)).toEqual({ x: 0.12, y: 0.99 })
	})
	it('treats the exact centre and bad input as no focal point', () => {
		expect(normalizeFocalPoint(0.5, 0.5)).toBeNull()
		expect(normalizeFocalPoint(null, 0.2)).toBeNull()
		expect(normalizeFocalPoint(Number.NaN, 0.2)).toBeNull()
		expect(normalizeFocalPoint('0.2', 0.2)).toBeNull()
	})
	it('clamps to the photo', () => {
		expect(normalizeFocalPoint(-2, 7)).toEqual({ x: 0, y: 1 })
	})
})

describe('parse and format', () => {
	it('round-trips', () => {
		expect(parseFocalPoint('0.2,0.35')).toEqual({ x: 0.2, y: 0.35 })
		expect(formatFocalPoint({ x: 0.2, y: 0.35 })).toBe('0.2,0.35')
	})
	it('refuses junk', () => {
		expect(parseFocalPoint('left,top')).toBeNull()
		expect(parseFocalPoint('0.2')).toBeNull()
		expect(parseFocalPoint(undefined)).toBeNull()
		expect(formatFocalPoint(null)).toBe('')
	})
})

describe('channel outputs', () => {
	it('defaults to the centre', () => {
		expect(focalObjectPosition(null)).toBe('50% 50%')
		expect(focalCdnOption(null)).toBe('')
		expect(focalGravity(null)).toBeNull()
	})
	it('top left', () => {
		const topLeft = { x: 0, y: 0 }
		expect(focalObjectPosition(topLeft)).toBe('0% 0%')
		expect(focalCdnOption(topLeft)).toBe('gravity=0x0')
	})
	it('reads a row without a focal point as none', () => {
		expect(focalPointOf({ focalX: null, focalY: null })).toBeNull()
		expect(focalPointOf({})).toBeNull()
		expect(focalPointOf({ focalX: 0.1, focalY: 0.9 })).toEqual({
			x: 0.1,
			y: 0.9,
		})
	})
})

describe('coverCropRect', () => {
	const wide = {
		sourceWidth: 4000,
		sourceHeight: 3000,
		outWidth: 1,
		outHeight: 1,
	}

	it('crops the middle by default (existing photos keep centre crops)', () => {
		const rect = coverCropRect(wide)
		expect(rect).toEqual({ left: 500, top: 0, width: 3000, height: 3000 })
		expect(coverCropRect({ ...wide, focal: null })).toEqual(rect)
	})

	it('shifts every crop toward a top-left focal point', () => {
		const centre = coverCropRect(wide)
		const topLeft = coverCropRect({ ...wide, focal: { x: 0, y: 0 } })
		expect(topLeft.left).toBeLessThan(centre.left)
		expect(topLeft.left).toBe(0)
		const tall = {
			sourceWidth: 3000,
			sourceHeight: 4000,
			outWidth: 16,
			outHeight: 9,
		}
		const tallCentre = coverCropRect(tall)
		const tallTopLeft = coverCropRect({ ...tall, focal: { x: 0, y: 0 } })
		expect(tallTopLeft.top).toBeLessThan(tallCentre.top)
		expect(tallTopLeft.top).toBe(0)
	})

	it('never leaves the photo', () => {
		const rect = coverCropRect({ ...wide, focal: { x: 1, y: 1 } })
		expect(rect.left + rect.width).toBeLessThanOrEqual(4000)
		expect(rect.top + rect.height).toBeLessThanOrEqual(3000)
	})

	it('keeps the focal point inside the crop', () => {
		const focal = { x: 0.9, y: 0.5 }
		const rect = coverCropRect({ ...wide, focal })
		const px = focal.x * wide.sourceWidth
		expect(px).toBeGreaterThanOrEqual(rect.left)
		expect(px).toBeLessThanOrEqual(rect.left + rect.width)
	})
})

describe('delivery crops', () => {
	const url = '/resources/images?mediaId=abc123&v=5'
	it('hands a delivery platform a crop around the focal point', () => {
		expect(focalCropUrl(url, { x: 0, y: 0 })).toBe(
			`${url}&fit=cover&w=1200&h=1200&fp=0,0`,
		)
	})
	it('leaves a photo without a point, or a foreign address, unchanged', () => {
		expect(focalCropUrl(url, null)).toBe(url)
		expect(focalCropUrl(url, { x: 0.5, y: 0.5 })).toBe(url)
		expect(focalCropUrl('https://cdn.example/x.jpg', { x: 0, y: 0 })).toBe(
			'https://cdn.example/x.jpg',
		)
		expect(focalCropUrl(null, { x: 0, y: 0 })).toBeNull()
	})
	it('finds the media id', () => {
		expect(mediaIdOfUrl(url)).toBe('abc123')
		expect(mediaIdOfUrl('https://x/y.jpg')).toBeNull()
	})
})
