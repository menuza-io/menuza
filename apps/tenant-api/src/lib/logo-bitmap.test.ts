import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { bitmapBytes } from '@repo/common/print-protocols'
import { decodePng, logoBitmapFor, setLogoFetcherForTest } from './logo-bitmap.ts'

function chunk(type: string, data: Buffer) {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length)
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(zlib.crc32(body) >>> 0)
	return Buffer.concat([length, body, crc])
}

/** A width x height RGBA PNG: the left half black and opaque, the right half transparent. */
function png(width: number, height: number, filter = 0) {
	const header = Buffer.alloc(13)
	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header[8] = 8
	header[9] = 6
	const rows: Buffer[] = []
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(1 + width * 4)
		row[0] = filter
		for (let x = 0; x < width; x++) {
			const black = x < width / 2
			row.set([0, 0, 0, black ? 255 : 0], 1 + x * 4)
		}
		rows.push(row)
	}
	// Filter 1 (Sub) stores each pixel minus the one before it.
	if (filter === 1) {
		for (const row of rows) {
			for (let i = row.length - 1; i >= 5; i--) {
				row[i] = (row[i]! - row[i - 4]!) & 0xff
			}
		}
	}
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			chunk('IHDR', header),
			chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
			chunk('IEND', Buffer.alloc(0)),
		]),
	)
}

afterEach(() => setLogoFetcherForTest(null))

describe('the receipt logo as a one-colour picture (#263)', () => {
	it('decodes a PNG, with and without a row filter', async () => {
		for (const filter of [0, 1]) {
			const image = await decodePng(png(4, 2, filter))
			expect(image).toMatchObject({ width: 4, height: 2 })
			expect([...image!.data.slice(0, 4)]).toEqual([0, 0, 0, 255])
			expect(image!.data[3 + 4 * 3]).toBe(0)
		}
		expect(await decodePng(new Uint8Array([1, 2, 3]))).toBeNull()
	})

	it('makes ink of the dark half only, and caps the height', async () => {
		setLogoFetcherForTest(async () => png(400, 400))
		const bitmap = await logoBitmapFor('https://app.test/logo.png', 80)
		expect(bitmap).not.toBeNull()
		expect(bitmap!.height).toBeLessThanOrEqual(120)
		const bytes = bitmapBytes(bitmap!)
		expect(bytes[0]! & 0x80).toBe(0x80)
		const rowBytes = Math.ceil(bitmap!.width / 8)
		// The right edge of the first row is white.
		expect(bytes[rowBytes - 1]! & 0x01).toBe(0)
	})

	it('leaves the logo off when it cannot be fetched or read', async () => {
		setLogoFetcherForTest(async () => null)
		expect(await logoBitmapFor('https://app.test/x.png', 80)).toBeNull()
		setLogoFetcherForTest(async () => new Uint8Array([0, 1, 2, 3]))
		expect(await logoBitmapFor('https://app.test/y.png', 80)).toBeNull()
		expect(await logoBitmapFor(null, 80)).toBeNull()
	})
})
