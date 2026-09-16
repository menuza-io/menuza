import { describe, expect, it } from 'vitest'
import { detectRasterImage, isValidRasterBytes } from './raster-image'

const VALID_IMAGES = {
	png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	gif: 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
	webp: 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
} as const

function fromBase64(value: string) {
	const buffer = Buffer.from(value, 'base64')
	return toArrayBuffer(buffer)
}

function toArrayBuffer(buffer: Buffer) {
	return buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	) as ArrayBuffer
}

function webpChunk(type: string, payload: Buffer) {
	const header = Buffer.alloc(8)
	header.write(type, 0, 'ascii')
	header.writeUInt32LE(payload.length, 4)
	return Buffer.concat([
		header,
		payload,
		...(payload.length % 2 ? [Buffer.from([0])] : []),
	])
}

function isoBox(type: string, payload: Buffer) {
	const header = Buffer.alloc(8)
	header.writeUInt32BE(header.length + payload.length, 0)
	header.write(type, 4, 'ascii')
	return Buffer.concat([header, payload])
}

function createAnimatedWebp() {
	const staticWebp = Buffer.from(VALID_IMAGES.webp, 'base64')
	const staticImageChunk = staticWebp.subarray(12)
	const extendedHeader = Buffer.alloc(10)
	extendedHeader[0] = 0x02
	const animationHeader = Buffer.alloc(6)
	const frameHeader = Buffer.alloc(16)
	const frame = webpChunk(
		'ANMF',
		Buffer.concat([frameHeader, staticImageChunk]),
	)
	const payload = Buffer.concat([
		Buffer.from('WEBP', 'ascii'),
		webpChunk('VP8X', extendedHeader),
		webpChunk('ANIM', animationHeader),
		frame,
	])
	const riffHeader = Buffer.alloc(8)
	riffHeader.write('RIFF', 0, 'ascii')
	riffHeader.writeUInt32LE(payload.length, 4)
	return toArrayBuffer(Buffer.concat([riffHeader, payload]))
}

describe('raster image validation', () => {
	it.each(Object.entries(VALID_IMAGES))(
		'accepts a complete %s image and reports its dimensions',
		(ignoredName, encoded) => {
			expect(detectRasterImage(fromBase64(encoded))).toMatchObject({
				width: 1,
				height: 1,
			})
		},
	)

	it('accepts animated WebP frames with nested image chunks', () => {
		expect(detectRasterImage(createAnimatedWebp())).toMatchObject({
			extension: 'webp',
			width: 1,
			height: 1,
		})
	})

	it.each(Object.entries(VALID_IMAGES))(
		'rejects a truncated %s image',
		(ignoredName, encoded) => {
			const complete = new Uint8Array(fromBase64(encoded))
			const truncated = complete.slice(0, -1).buffer
			expect(isValidRasterBytes(truncated)).toBe(false)
		},
	)

	it('rejects files that contain only a recognized signature', () => {
		const signatures = [
			[0xff, 0xd8, 0xff, 0xe0],
			[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
			[0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
			[0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
			[0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66],
		]

		for (const signature of signatures) {
			expect(isValidRasterBytes(Uint8Array.from(signature).buffer)).toBe(false)
		}
	})

	it('rejects excessively nested AVIF metadata', () => {
		const ispePayload = Buffer.alloc(12)
		ispePayload.writeUInt32BE(1, 4)
		ispePayload.writeUInt32BE(1, 8)
		let nested = isoBox('ispe', ispePayload)
		for (let depth = 0; depth < 18; depth++) {
			nested = isoBox('ipco', nested)
		}

		const ftyp = isoBox(
			'ftyp',
			Buffer.concat([
				Buffer.from('avif', 'ascii'),
				Buffer.alloc(4),
				Buffer.from('avif', 'ascii'),
			]),
		)
		const meta = isoBox('meta', Buffer.concat([Buffer.alloc(4), nested]))
		const mdat = isoBox('mdat', Buffer.from([1]))

		expect(
			detectRasterImage(toArrayBuffer(Buffer.concat([ftyp, meta, mdat]))),
		).toBeNull()
	})
})
