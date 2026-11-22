import {
	BULK_PHOTO_MAX_FILES,
	BULK_PHOTO_MAX_TOTAL_BYTES,
} from '@repo/common/dish-photo-match'
import { describe, expect, it } from 'vitest'
import {
	acceptIntoBatch,
	detectImageKind,
	isBlockedByPrecheck,
	markDuplicates,
	precheckFile,
	readImageSize,
	sha256Hex,
} from './precheck.ts'

function png(width: number, height: number) {
	const bytes = new Uint8Array(33)
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	const view = new DataView(bytes.buffer)
	view.setUint32(8, 13)
	bytes.set([0x49, 0x48, 0x44, 0x52], 12)
	view.setUint32(16, width)
	view.setUint32(20, height)
	return bytes
}

function jpeg(width: number, height: number) {
	// SOI, an APP0 segment, then SOF0 with height and width.
	const bytes = new Uint8Array(2 + 4 + 14 + 4 + 11 + 2)
	const view = new DataView(bytes.buffer)
	bytes.set([0xff, 0xd8])
	bytes.set([0xff, 0xe0], 2)
	view.setUint16(4, 16)
	bytes.set([0xff, 0xc0], 20)
	view.setUint16(22, 11)
	bytes[24] = 8
	view.setUint16(25, height)
	view.setUint16(27, width)
	return bytes
}

function gif(width: number, height: number) {
	const bytes = new Uint8Array(13)
	bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
	const view = new DataView(bytes.buffer)
	view.setUint16(6, width, true)
	view.setUint16(8, height, true)
	return bytes
}

function webpX(width: number, height: number) {
	const bytes = new Uint8Array(30)
	bytes.set([0x52, 0x49, 0x46, 0x46], 0)
	bytes.set([0x57, 0x45, 0x42, 0x50], 8)
	bytes.set([0x56, 0x50, 0x38, 0x58], 12)
	const w = width - 1
	const h = height - 1
	bytes.set([w & 255, (w >> 8) & 255, (w >> 16) & 255], 24)
	bytes.set([h & 255, (h >> 8) & 255, (h >> 16) & 255], 27)
	return bytes
}

function webpLossless(width: number, height: number) {
	const bytes = new Uint8Array(30)
	bytes.set([0x52, 0x49, 0x46, 0x46], 0)
	bytes.set([0x57, 0x45, 0x42, 0x50], 8)
	bytes.set([0x56, 0x50, 0x38, 0x4c], 12)
	new DataView(bytes.buffer).setUint32(
		21,
		(width - 1) | ((height - 1) << 14),
		true,
	)
	return bytes
}

function file(name: string, data: Uint8Array, type = 'image/jpeg') {
	return {
		name,
		type,
		size: data.byteLength,
		arrayBuffer: async () =>
			data.buffer.slice(
				data.byteOffset,
				data.byteOffset + data.byteLength,
			) as ArrayBuffer,
	}
}

describe('image header reading', () => {
	it('reads the size of PNG, JPEG, GIF and WebP files', () => {
		expect(readImageSize(png(2000, 1500))).toEqual({
			width: 2000,
			height: 1500,
		})
		expect(readImageSize(jpeg(1200, 800))).toEqual({ width: 1200, height: 800 })
		expect(readImageSize(gif(640, 480))).toEqual({ width: 640, height: 480 })
		expect(readImageSize(webpX(1600, 900))).toEqual({
			width: 1600,
			height: 900,
		})
		expect(readImageSize(webpLossless(1024, 768))).toEqual({
			width: 1024,
			height: 768,
		})
	})

	it('recognises types by their bytes and rejects everything else', () => {
		expect(detectImageKind(png(1, 1))).toBe('png')
		expect(detectImageKind(jpeg(1, 1))).toBe('jpeg')
		expect(
			detectImageKind(new TextEncoder().encode('<svg xmlns="..."></svg>')),
		).toBeNull()
		expect(detectImageKind(new TextEncoder().encode('%PDF-1.7'))).toBeNull()
		const avif = new Uint8Array(16)
		avif.set(new TextEncoder().encode('ftypavif'), 4)
		expect(detectImageKind(avif)).toBe('avif')
		expect(readImageSize(avif)).toBeNull()
		expect(readImageSize(new Uint8Array(3))).toBeNull()
	})

	it('does not loop on a truncated JPEG', () => {
		expect(
			readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2])),
		).toBeNull()
	})
})

describe('precheckFile', () => {
	it('flags a photo whose short side is under 800 px', async () => {
		const small = await precheckFile(
			file('small.png', png(640, 480), 'image/png'),
		)
		expect(small).toMatchObject({ kind: 'png', width: 640, height: 480 })
		expect(small.flags).toEqual(['too_small'])
		const fine = await precheckFile(
			file('fine.png', png(2000, 1500), 'image/png'),
		)
		expect(fine.flags).toEqual([])
	})

	it('flags a file that is not an image by its bytes, whatever its name says', async () => {
		const fake = await precheckFile(
			file('menu.jpg', new TextEncoder().encode('just text, not a photo')),
		)
		expect(fake.flags).toEqual(['not_an_image'])
		expect(fake.kind).toBeNull()
		expect(isBlockedByPrecheck(fake.flags)).toBe(true)
		const pdf = await precheckFile(
			file('doc.pdf', new TextEncoder().encode('%PDF-1.7'), 'application/pdf'),
		)
		expect(pdf.flags).toContain('not_an_image')
	})

	it('flags an empty file and one over the size limit without reading it', async () => {
		const empty = await precheckFile(file('empty.jpg', new Uint8Array(0)))
		expect(empty.flags).toEqual(['not_an_image'])
		let read = false
		const huge = await precheckFile({
			name: 'huge.jpg',
			type: 'image/jpeg',
			size: 200 * 1024 * 1024,
			arrayBuffer: async () => {
				read = true
				return new ArrayBuffer(0)
			},
		})
		expect(huge.flags).toEqual(['too_large'])
		expect(read).toBe(false)
		const large = await precheckFile({
			name: 'big.jpg',
			type: 'image/jpeg',
			size: 11 * 1024 * 1024,
			arrayBuffer: async () => jpeg(2000, 2000).buffer as ArrayBuffer,
		})
		expect(large.flags).toContain('too_large')
		expect(isBlockedByPrecheck(large.flags)).toBe(true)
	})

	it('measures what the header does not say', async () => {
		const avif = new Uint8Array(16)
		avif.set(new TextEncoder().encode('ftypavif'), 4)
		const result = await precheckFile(
			file('a.avif', avif, 'image/avif'),
			async () => ({
				width: 500,
				height: 500,
			}),
		)
		expect(result).toMatchObject({ kind: 'avif', width: 500, height: 500 })
		expect(result.flags).toEqual(['too_small'])
		const failed = await precheckFile(
			file('a.avif', avif, 'image/avif'),
			async () => {
				throw new Error('cannot decode')
			},
		)
		expect(failed.flags).toEqual([])
	})

	it('hashes the content, so equal files share a hash', async () => {
		const a = await precheckFile(file('a.png', png(1000, 1000), 'image/png'))
		const b = await precheckFile(
			file('copy of a.png', png(1000, 1000), 'image/png'),
		)
		const c = await precheckFile(file('c.png', png(1001, 1000), 'image/png'))
		expect(a.hash).toMatch(/^[0-9a-f]{64}$/)
		expect(a.hash).toBe(b.hash)
		expect(a.hash).not.toBe(c.hash)
		expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		)
	})
})

describe('markDuplicates', () => {
	it('flags the later copy and leaves the first clean', () => {
		const marked = markDuplicates([
			{ hash: 'a', flags: [] as Array<'duplicate' | 'too_small'> },
			{ hash: 'b', flags: [] },
			{ hash: 'a', flags: ['too_small'] },
			{ hash: null, flags: [] },
			{ hash: null, flags: [] },
		])
		expect(marked.map((item) => item.flags)).toEqual([
			[],
			[],
			['too_small', 'duplicate'],
			[],
			[],
		])
	})
})

describe('acceptIntoBatch', () => {
	it('keeps the first 100 photos and names the rest', () => {
		const existing = Array.from({ length: 98 }, () => ({ size: 10 }))
		const incoming = Array.from({ length: 5 }, (_, i) => ({ size: 10, i }))
		const { accepted, tooMany, tooBig } = acceptIntoBatch(existing, incoming)
		expect(98 + accepted.length).toBe(BULK_PHOTO_MAX_FILES)
		expect(accepted.map((f) => f.i)).toEqual([0, 1])
		expect(tooMany.map((f) => f.i)).toEqual([2, 3, 4])
		expect(tooBig).toEqual([])
	})

	it('refuses a file that takes the batch past the total size', () => {
		const existing = [{ size: BULK_PHOTO_MAX_TOTAL_BYTES - 100 }]
		const { accepted, tooBig } = acceptIntoBatch(existing, [
			{ size: 60 },
			{ size: 60 },
			{ size: 30 },
		])
		expect(accepted.map((f) => f.size)).toEqual([60, 30])
		expect(tooBig.map((f) => f.size)).toEqual([60])
	})
})
