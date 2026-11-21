import { describe, expect, it } from 'vitest'
import {
	detectGuestPhotoMagicFormat,
	GUEST_PHOTO_MAX_DIMENSION,
	GuestPhotoImageError,
	stripAndReencodeGuestPhoto,
} from './image-reencode.ts'

function concat(...arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((sum, a) => sum + a.byteLength, 0)
	const out = new Uint8Array(total)
	let offset = 0
	for (const a of arrays) {
		out.set(a, offset)
		offset += a.byteLength
	}
	return out
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let i = 0; i < 256; i++) {
		let c = i
		for (let bit = 0; bit < 8; bit++) {
			c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
		}
		table[i] = c >>> 0
	}
	return table
})()

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff
	for (let i = 0; i < bytes.length; i++) {
		crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
	}
	return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.byteLength)
	const view = new DataView(out.buffer)
	view.setUint32(0, data.byteLength, false)
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
	out.set(data, 8)
	view.setUint32(
		8 + data.byteLength,
		crc32(out.subarray(4, 8 + data.byteLength)),
		false,
	)
	return out
}

function makePngWithMetadata(): Uint8Array {
	const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	const ihdr = new Uint8Array(13)
	const ihdrView = new DataView(ihdr.buffer)
	ihdrView.setUint32(0, 2, false)
	ihdrView.setUint32(4, 2, false)
	ihdr[8] = 8
	ihdr[9] = 2
	const exifPayload = new TextEncoder().encode('MM\x00*GPSLatitude37.7749N')
	const textPayload = new TextEncoder().encode(
		'Comment\x00Shot on iPhone at home',
	)
	const idat = new Uint8Array([
		0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
	])
	return concat(
		sig,
		pngChunk('IHDR', ihdr),
		pngChunk('eXIf', exifPayload),
		pngChunk('tEXt', textPayload),
		pngChunk('IDAT', idat),
		pngChunk('IEND', new Uint8Array(0)),
	)
}

function makeJpegWithExifAndComment(): Uint8Array {
	const soi = new Uint8Array([0xff, 0xd8])
	const app0 = new Uint8Array([
		0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
		0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
	])
	const exifBody = new TextEncoder().encode(
		'Exif\x00\x00II*\x00GPS_LAT_37_7749',
	)
	const app1 = concat(
		new Uint8Array([
			0xff,
			0xe1,
			((exifBody.length + 2) >> 8) & 0xff,
			(exifBody.length + 2) & 0xff,
		]),
		exifBody,
	)
	const comBody = new TextEncoder().encode('SecretCameraSerial123')
	const com = concat(
		new Uint8Array([
			0xff,
			0xfe,
			((comBody.length + 2) >> 8) & 0xff,
			(comBody.length + 2) & 0xff,
		]),
		comBody,
	)
	// SOF0 16x12
	const sof0 = new Uint8Array([
		0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x0c, 0x00, 0x10, 0x01, 0x01, 0x11,
		0x00,
	])
	const sos = new Uint8Array([
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xaa, 0xbb,
	])
	const eoi = new Uint8Array([0xff, 0xd9])
	return concat(soi, app0, app1, com, sof0, sos, eoi)
}

function makeWebpWithExifAndXmp(): Uint8Array {
	const vp8xData = new Uint8Array(10)
	vp8xData[0] = 0x08 | 0x04 // EXIF + XMP flags
	vp8xData[4] = 9 // width - 1 = 9 -> 10
	vp8xData[7] = 7 // height - 1 = 7 -> 8
	const vp8Data = new Uint8Array([
		0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x0a, 0x00, 0x08, 0x00,
	])
	const exifData = new TextEncoder().encode('EXIF_GPS_37.7749_-122.4194')
	const xmpData = new TextEncoder().encode('<x:xmpmeta>GPS</x:xmpmeta>')

	const chunk = (fourcc: string, data: Uint8Array) => {
		const pad = data.byteLength % 2
		const out = new Uint8Array(8 + data.byteLength + pad)
		for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i)
		new DataView(out.buffer).setUint32(4, data.byteLength, true)
		out.set(data, 8)
		return out
	}

	const body = concat(
		chunk('VP8X', vp8xData),
		chunk('VP8 ', vp8Data),
		chunk('EXIF', exifData),
		chunk('XMP ', xmpData),
	)
	const header = new Uint8Array(12)
	header.set([0x52, 0x49, 0x46, 0x46], 0)
	new DataView(header.buffer).setUint32(4, 4 + body.byteLength, true)
	header.set([0x57, 0x45, 0x42, 0x50], 8)
	return concat(header, body)
}

function makeHeicHeader(): Uint8Array {
	const out = new Uint8Array(24)
	new DataView(out.buffer).setUint32(0, 24, false)
	out.set(new TextEncoder().encode('ftypheic\x00\x00\x00\x00mif1heic'), 4)
	return out
}

describe('image-reencode (Worker-safe EXIF/GPS stripper)', () => {
	it('strips EXIF, GPS, and COM segments from JPEG while keeping image data', async () => {
		const raw = makeJpegWithExifAndComment()
		expect(detectGuestPhotoMagicFormat(raw)).toBe('image/jpeg')

		const cleaned = await stripAndReencodeGuestPhoto(raw)
		expect(cleaned.contentType).toBe('image/jpeg')
		expect(cleaned.extension).toBe('jpg')
		expect(cleaned.width).toBe(16)
		expect(cleaned.height).toBe(12)

		const text = new TextDecoder('latin1').decode(cleaned.bytes)
		expect(text).not.toContain('GPS_LAT_37_7749')
		expect(text).not.toContain('Exif')
		expect(text).not.toContain('SecretCameraSerial123')
		expect(cleaned.bytes[0]).toBe(0xff)
		expect(cleaned.bytes[1]).toBe(0xd8)
		expect(cleaned.bytes[cleaned.bytes.length - 2]).toBe(0xff)
		expect(cleaned.bytes[cleaned.bytes.length - 1]).toBe(0xd9)
	})

	it('strips eXIf and tEXt chunks from PNG while preserving IHDR/IDAT/IEND', async () => {
		const raw = makePngWithMetadata()
		expect(detectGuestPhotoMagicFormat(raw)).toBe('image/png')

		const cleaned = await stripAndReencodeGuestPhoto(raw)
		expect(cleaned.contentType).toBe('image/png')
		expect(cleaned.extension).toBe('png')
		expect(cleaned.width).toBe(2)
		expect(cleaned.height).toBe(2)

		const text = new TextDecoder('latin1').decode(cleaned.bytes)
		expect(text).not.toContain('eXIf')
		expect(text).not.toContain('GPSLatitude37.7749N')
		expect(text).not.toContain('Shot on iPhone')
		expect(text).toContain('IHDR')
		expect(text).toContain('IDAT')
		expect(text).toContain('IEND')
	})

	it('strips EXIF and XMP chunks from WebP', async () => {
		const raw = makeWebpWithExifAndXmp()
		expect(detectGuestPhotoMagicFormat(raw)).toBe('image/webp')

		const cleaned = await stripAndReencodeGuestPhoto(raw)
		expect(cleaned.contentType).toBe('image/webp')
		expect(cleaned.extension).toBe('webp')
		expect(cleaned.width).toBe(10)
		expect(cleaned.height).toBe(8)

		const text = new TextDecoder('latin1').decode(cleaned.bytes)
		expect(text).not.toContain('EXIF_GPS')
		expect(text).not.toContain('xmpmeta')
		expect(text).toContain('WEBP')
		expect(text).toContain('VP8 ')
	})

	it('rejects non-image payloads disguised as images by magic bytes', async () => {
		const svg = new TextEncoder().encode('<svg onload="alert(1)"></svg>')
		await expect(stripAndReencodeGuestPhoto(svg)).rejects.toMatchObject({
			code: 'unsupported_image_type',
			status: 400,
		})
	})

	it('rejects payloads larger than 10 MB', async () => {
		const oversized = new Uint8Array(10 * 1024 * 1024 + 1)
		oversized[0] = 0xff
		oversized[1] = 0xd8
		await expect(stripAndReencodeGuestPhoto(oversized)).rejects.toBeInstanceOf(
			GuestPhotoImageError,
		)
		await expect(stripAndReencodeGuestPhoto(oversized)).rejects.toMatchObject({
			code: 'file_too_large',
			status: 413,
		})
	})

	it('rejects raw HEIC with heic_conversion_unavailable when no converter adapter is configured', async () => {
		const heic = makeHeicHeader()
		expect(detectGuestPhotoMagicFormat(heic)).toBe('image/heic')
		await expect(stripAndReencodeGuestPhoto(heic)).rejects.toMatchObject({
			code: 'heic_conversion_unavailable',
			status: 422,
		})
	})

	it('converts HEIC via injectable converter adapter and strips EXIF from converted output', async () => {
		const heic = makeHeicHeader()
		const cleaned = await stripAndReencodeGuestPhoto(heic, {
			heicConverter: async () => ({
				bytes: makeJpegWithExifAndComment(),
				contentType: 'image/jpeg',
			}),
		})
		expect(cleaned.sourceFormat).toBe('image/heic')
		expect(cleaned.contentType).toBe('image/jpeg')
		const text = new TextDecoder('latin1').decode(cleaned.bytes)
		expect(text).not.toContain('GPS_LAT_37_7749')
		expect(text).not.toContain('SecretCameraSerial123')
	})

	it('strips unknown JPEG markers (APP14 0xEE and JPG2 0xF2) via allow-list', async () => {
		const soi = new Uint8Array([0xff, 0xd8])
		const app14Body = new TextEncoder().encode('AdobeHiddenPayload')
		const app14 = concat(
			new Uint8Array([
				0xff,
				0xee,
				((app14Body.length + 2) >> 8) & 0xff,
				(app14Body.length + 2) & 0xff,
			]),
			app14Body,
		)
		const jpg2Body = new TextEncoder().encode('CustomJPG2Segment')
		const jpg2 = concat(
			new Uint8Array([
				0xff,
				0xf2,
				((jpg2Body.length + 2) >> 8) & 0xff,
				(jpg2Body.length + 2) & 0xff,
			]),
			jpg2Body,
		)
		const sof0 = new Uint8Array([
			0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x0c, 0x00, 0x10, 0x01, 0x01, 0x11,
			0x00,
		])
		const sos = new Uint8Array([
			0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xaa, 0xbb,
		])
		const eoi = new Uint8Array([0xff, 0xd9])
		const raw = concat(soi, app14, jpg2, sof0, sos, eoi)

		const cleaned = await stripAndReencodeGuestPhoto(raw)
		const text = new TextDecoder('latin1').decode(cleaned.bytes)
		expect(text).not.toContain('AdobeHiddenPayload')
		expect(text).not.toContain('CustomJPG2Segment')
	})

	it('strips WebP ANMF/ANIM chunks and rejects animated-only WebP without static VP8/VP8L frame', async () => {
		const chunk = (fourcc: string, data: Uint8Array) => {
			const pad = data.byteLength % 2
			const out = new Uint8Array(8 + data.byteLength + pad)
			for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i)
			new DataView(out.buffer).setUint32(4, data.byteLength, true)
			out.set(data, 8)
			return out
		}
		const vp8Data = new Uint8Array([
			0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x0a, 0x00, 0x08, 0x00,
		])
		const animData = new Uint8Array(6)
		const anmfData = new TextEncoder().encode('ANMF_HIDDEN_EXIF_PAYLOAD')
		const bodyWithStatic = concat(
			chunk('VP8 ', vp8Data),
			chunk('ANIM', animData),
			chunk('ANMF', anmfData),
		)
		const hdr1 = new Uint8Array(12)
		hdr1.set([0x52, 0x49, 0x46, 0x46], 0)
		new DataView(hdr1.buffer).setUint32(4, 4 + bodyWithStatic.byteLength, true)
		hdr1.set([0x57, 0x45, 0x42, 0x50], 8)
		const cleaned = await stripAndReencodeGuestPhoto(
			concat(hdr1, bodyWithStatic),
		)
		const text = new TextDecoder('latin1').decode(cleaned.bytes)
		expect(text).not.toContain('ANMF_HIDDEN_EXIF_PAYLOAD')
		expect(text).not.toContain('ANMF')
		expect(text).not.toContain('ANIM')

		// Animated-only WebP (only VP8X + ANIM + ANMF) is rejected
		const vp8xData = new Uint8Array(10)
		vp8xData[0] = 0x02 // animation flag
		vp8xData[4] = 9
		vp8xData[7] = 7
		const bodyAnimOnly = concat(
			chunk('VP8X', vp8xData),
			chunk('ANIM', animData),
			chunk('ANMF', anmfData),
		)
		const hdr2 = new Uint8Array(12)
		hdr2.set([0x52, 0x49, 0x46, 0x46], 0)
		new DataView(hdr2.buffer).setUint32(4, 4 + bodyAnimOnly.byteLength, true)
		hdr2.set([0x57, 0x45, 0x42, 0x50], 8)
		await expect(
			stripAndReencodeGuestPhoto(concat(hdr2, bodyAnimOnly)),
		).rejects.toMatchObject({ code: 'invalid_image_data', status: 400 })
	})

	it('enforces dimension and total-pixel limits across JPEG, PNG, and WebP', async () => {
		const makeJpegWithDims = (w: number, h: number) => {
			const soi = new Uint8Array([0xff, 0xd8])
			const sof0 = new Uint8Array([
				0xff,
				0xc0,
				0x00,
				0x0b,
				0x08,
				(h >> 8) & 0xff,
				h & 0xff,
				(w >> 8) & 0xff,
				w & 0xff,
				0x01,
				0x01,
				0x11,
				0x00,
			])
			const sos = new Uint8Array([
				0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xaa, 0xbb,
			])
			const eoi = new Uint8Array([0xff, 0xd9])
			return concat(soi, sof0, sos, eoi)
		}
		const makePngWithDims = (w: number, h: number) => {
			const sig = new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			])
			const ihdr = new Uint8Array(13)
			const view = new DataView(ihdr.buffer)
			view.setUint32(0, w, false)
			view.setUint32(4, h, false)
			ihdr[8] = 8
			ihdr[9] = 2
			const idat = new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02])
			return concat(
				sig,
				pngChunk('IHDR', ihdr),
				pngChunk('IDAT', idat),
				pngChunk('IEND', new Uint8Array(0)),
			)
		}
		const makeWebpWithDims = (w: number, h: number) => {
			const vp8 = new Uint8Array([
				0x00,
				0x00,
				0x00,
				0x9d,
				0x01,
				0x2a,
				w & 0xff,
				(w >> 8) & 0x3f,
				h & 0xff,
				(h >> 8) & 0x3f,
			])
			const body = new Uint8Array(8 + vp8.byteLength)
			body.set([0x56, 0x50, 0x38, 0x20], 0)
			new DataView(body.buffer).setUint32(4, vp8.byteLength, true)
			body.set(vp8, 8)
			const header = new Uint8Array(12)
			header.set([0x52, 0x49, 0x46, 0x46], 0)
			new DataView(header.buffer).setUint32(4, 4 + body.byteLength, true)
			header.set([0x57, 0x45, 0x42, 0x50], 8)
			return concat(header, body)
		}

		// Edge > 8192
		await expect(
			stripAndReencodeGuestPhoto(
				makeJpegWithDims(GUEST_PHOTO_MAX_DIMENSION + 1, 10),
			),
		).rejects.toMatchObject({ code: 'image_dimensions_too_large' })
		await expect(
			stripAndReencodeGuestPhoto(
				makePngWithDims(10, GUEST_PHOTO_MAX_DIMENSION + 1),
			),
		).rejects.toMatchObject({ code: 'image_dimensions_too_large' })
		await expect(
			stripAndReencodeGuestPhoto(
				makeWebpWithDims(GUEST_PHOTO_MAX_DIMENSION + 1, 10),
			),
		).rejects.toMatchObject({ code: 'image_dimensions_too_large' })

		// Total pixels > 40_000_000 (7000 * 7000 = 49_000_000)
		await expect(
			stripAndReencodeGuestPhoto(makeJpegWithDims(7000, 7000)),
		).rejects.toMatchObject({ code: 'image_dimensions_too_large' })
		await expect(
			stripAndReencodeGuestPhoto(makePngWithDims(7000, 7000)),
		).rejects.toMatchObject({ code: 'image_dimensions_too_large' })
		await expect(
			stripAndReencodeGuestPhoto(makeWebpWithDims(7000, 7000)),
		).rejects.toMatchObject({ code: 'image_dimensions_too_large' })
	})
})
