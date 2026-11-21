import {
	GUEST_PHOTO_MAX_BYTES,
	type GuestPhotoMimeType,
} from '@repo/common/guest-photos'

export type CleanGuestPhotoFormat = 'image/jpeg' | 'image/png' | 'image/webp'
export type CleanGuestPhotoExtension = 'jpg' | 'png' | 'webp'

export type CleanedGuestPhoto = {
	bytes: Uint8Array
	contentType: CleanGuestPhotoFormat
	extension: CleanGuestPhotoExtension
	width: number
	height: number
	sourceFormat: GuestPhotoMimeType
}

export type HeicConversionResult = {
	bytes: Uint8Array
	contentType?: CleanGuestPhotoFormat
}

/**
 * Worker-safe HEIC/HEIF conversion seam.
 *
 * `sharp` and libheif native bindings cannot execute in Cloudflare Workers
 * (`workerd`). Callers in browsers convert HEIC via `createImageBitmap` +
 * `<canvas>` before upload when supported (e.g. Safari/iOS). On the server,
 * an external/WASM converter adapter may be injected here; when none is
 * configured, raw HEIC uploads fail cleanly with `heic_conversion_unavailable`
 * (HTTP 422) rather than storing unstripped EXIF/GPS metadata.
 */
export type HeicConverterAdapter = (
	bytes: Uint8Array,
) => Promise<HeicConversionResult | null>

export type ImageReencodeErrorCode =
	| 'file_empty'
	| 'file_too_large'
	| 'unsupported_image_type'
	| 'invalid_image_data'
	| 'heic_conversion_unavailable'

export class GuestPhotoImageError extends Error {
	constructor(
		readonly code: ImageReencodeErrorCode,
		readonly status: 400 | 413 | 422,
		message: string,
	) {
		super(message)
		this.name = 'GuestPhotoImageError'
	}
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const JPEG_SOF_MARKERS = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

// Metadata / ancillary segments stripped from JPEGs:
// - APP1..APP13 (EXIF, GPS IFD, XMP, ICC/MPF, IPTC, Photoshop IRB)
// - APP15
// - COM (0xFE)
const JPEG_STRIPPED_MARKERS = new Set([
	0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed,
	0xef, 0xfe,
])

const PNG_ALLOWED_CHUNKS = new Set([
	'IHDR',
	'PLTE',
	'tRNS',
	'gAMA',
	'cHRM',
	'sRGB',
	'bKGD',
	'IDAT',
	'IEND',
])

const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ', 'ICCP'])

const HEIC_BRANDS = new Set([
	'heic',
	'heix',
	'hevc',
	'hevx',
	'mif1',
	'msf1',
	'heis',
	'hevm',
	'hevs',
])

function matches(
	bytes: Uint8Array,
	offset: number,
	expected: readonly number[],
) {
	if (offset + expected.length > bytes.length) return false
	for (let i = 0; i < expected.length; i++) {
		if (bytes[offset + i] !== expected[i]) return false
	}
	return true
}

function readUint16BE(bytes: Uint8Array, offset: number) {
	return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function readUint16LE(bytes: Uint8Array, offset: number) {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readUint32BE(bytes: Uint8Array, offset: number) {
	return (
		(((bytes[offset] ?? 0) << 24) |
			((bytes[offset + 1] ?? 0) << 16) |
			((bytes[offset + 2] ?? 0) << 8) |
			(bytes[offset + 3] ?? 0)) >>>
		0
	)
}

function readUint32LE(bytes: Uint8Array, offset: number) {
	return (
		((bytes[offset] ?? 0) |
			((bytes[offset + 1] ?? 0) << 8) |
			((bytes[offset + 2] ?? 0) << 16) |
			((bytes[offset + 3] ?? 0) << 24)) >>>
		0
	)
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number) {
	bytes[offset] = value & 0xff
	bytes[offset + 1] = (value >>> 8) & 0xff
	bytes[offset + 2] = (value >>> 16) & 0xff
	bytes[offset + 3] = (value >>> 24) & 0xff
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
	if (offset + length > bytes.length) return ''
	let out = ''
	for (let i = 0; i < length; i++) {
		out += String.fromCharCode(bytes[offset + i] ?? 0)
	}
	return out
}

function concatUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array {
	let total = 0
	for (const chunk of chunks) total += chunk.byteLength
	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.byteLength
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

function crc32(bytes: Uint8Array, start: number, end: number) {
	let crc = 0xffffffff
	for (let i = start; i < end; i++) {
		crc = CRC32_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff]! ^ (crc >>> 8)
	}
	return (crc ^ 0xffffffff) >>> 0
}

export function detectGuestPhotoMagicFormat(
	bytes: Uint8Array,
): GuestPhotoMimeType | null {
	if (bytes.byteLength >= 4 && matches(bytes, 0, [0xff, 0xd8])) {
		return 'image/jpeg'
	}
	if (bytes.byteLength >= 45 && matches(bytes, 0, PNG_SIGNATURE)) {
		return 'image/png'
	}
	if (
		bytes.byteLength >= 20 &&
		readAscii(bytes, 0, 4) === 'RIFF' &&
		readAscii(bytes, 8, 4) === 'WEBP'
	) {
		return 'image/webp'
	}
	if (bytes.byteLength >= 16 && readAscii(bytes, 4, 4) === 'ftyp') {
		const boxSize = readUint32BE(bytes, 0)
		if (boxSize >= 16 && boxSize <= bytes.byteLength) {
			const majorBrand = readAscii(bytes, 8, 4)
			const brands = [majorBrand]
			for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
				brands.push(readAscii(bytes, offset, 4))
			}
			if (brands.some((brand) => HEIC_BRANDS.has(brand))) {
				return majorBrand === 'mif1' || majorBrand === 'msf1'
					? 'image/heif'
					: 'image/heic'
			}
		}
	}
	return null
}

function stripJpegMetadata(bytes: Uint8Array): {
	bytes: Uint8Array
	width: number
	height: number
} | null {
	if (bytes.length < 4 || !matches(bytes, 0, [0xff, 0xd8])) return null

	const kept: Uint8Array[] = [new Uint8Array([0xff, 0xd8])]
	let offset = 2
	let width = 0
	let height = 0
	let hasScan = false

	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) return null
		while (offset < bytes.length && bytes[offset] === 0xff) offset++
		if (offset >= bytes.length) return null

		const marker = bytes[offset++]!
		if (marker === 0xd9) {
			if (offset !== bytes.length || !hasScan || width <= 0 || height <= 0) {
				return null
			}
			kept.push(new Uint8Array([0xff, 0xd9]))
			return { bytes: concatUint8Arrays(kept), width, height }
		}
		if (marker === 0x00) return null
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			kept.push(new Uint8Array([0xff, marker]))
			continue
		}

		if (offset + 2 > bytes.length) return null
		const segmentLength = readUint16BE(bytes, offset)
		if (segmentLength < 2 || offset + segmentLength > bytes.length) return null
		const payloadStart = offset + 2
		const segmentEnd = offset + segmentLength

		if (JPEG_SOF_MARKERS.has(marker)) {
			if (segmentLength < 8) return null
			height = readUint16BE(bytes, payloadStart + 1)
			width = readUint16BE(bytes, payloadStart + 3)
			if (width === 0 || height === 0) return null
		}

		const shouldStrip =
			JPEG_STRIPPED_MARKERS.has(marker) ||
			// Strip APP0 extensions/thumbnails; standard 14-byte JFIF header is safe
			// or can be omitted cleanly.
			(marker === 0xe0 &&
				(segmentLength !== 16 ||
					readAscii(bytes, payloadStart, 5) !== 'JFIF\0'))

		if (!shouldStrip) {
			kept.push(new Uint8Array([0xff, marker]))
			kept.push(bytes.subarray(offset, segmentEnd))
		}

		offset = segmentEnd
		if (marker !== 0xda) continue

		hasScan = true
		const scanStart = offset
		let foundNextMarker = false
		while (offset < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset++
				continue
			}
			const markerOffset = offset
			while (offset < bytes.length && bytes[offset] === 0xff) offset++
			if (offset >= bytes.length) return null
			const scanMarker = bytes[offset]!
			if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
				offset++
				continue
			}
			kept.push(bytes.subarray(scanStart, markerOffset))
			offset = markerOffset
			foundNextMarker = true
			break
		}
		if (!foundNextMarker) return null
	}

	return null
}

function stripPngMetadata(bytes: Uint8Array): {
	bytes: Uint8Array
	width: number
	height: number
} | null {
	if (bytes.length < 45 || !matches(bytes, 0, PNG_SIGNATURE)) return null

	const kept: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)]
	let offset = PNG_SIGNATURE.length
	let width = 0
	let height = 0
	let sawImageData = false
	let chunkIndex = 0

	while (offset + 12 <= bytes.length) {
		const length = readUint32BE(bytes, offset)
		const typeStart = offset + 4
		const dataStart = offset + 8
		const dataEnd = dataStart + length
		const chunkEnd = dataEnd + 4
		if (dataEnd < dataStart || chunkEnd > bytes.length) return null

		const type = readAscii(bytes, typeStart, 4)
		const expectedCrc = readUint32BE(bytes, dataEnd)
		if (crc32(bytes, typeStart, dataEnd) !== expectedCrc) return null

		if (chunkIndex === 0) {
			if (type !== 'IHDR' || length !== 13) return null
			width = readUint32BE(bytes, dataStart)
			height = readUint32BE(bytes, dataStart + 4)
			const bitDepth = bytes[dataStart + 8]
			const colorType = bytes[dataStart + 9]
			const validBitDepths: Record<number, number[]> = {
				0: [1, 2, 4, 8, 16],
				2: [8, 16],
				3: [1, 2, 4, 8],
				4: [8, 16],
				6: [8, 16],
			}
			if (
				width === 0 ||
				height === 0 ||
				!validBitDepths[colorType ?? -1]?.includes(bitDepth ?? -1) ||
				bytes[dataStart + 10] !== 0 ||
				bytes[dataStart + 11] !== 0 ||
				(bytes[dataStart + 12] !== 0 && bytes[dataStart + 12] !== 1)
			) {
				return null
			}
		} else if (type === 'IHDR') {
			return null
		}

		if (type === 'IDAT' && length > 0) sawImageData = true

		if (PNG_ALLOWED_CHUNKS.has(type)) {
			kept.push(bytes.subarray(offset, chunkEnd))
		}

		if (type === 'IEND') {
			if (length !== 0 || chunkEnd !== bytes.length || !sawImageData) {
				return null
			}
			return { bytes: concatUint8Arrays(kept), width, height }
		}

		offset = chunkEnd
		chunkIndex++
	}

	return null
}

function decodeWebpBitstreamDimensions(
	bytes: Uint8Array,
	type: string,
	dataStart: number,
	length: number,
): { width: number; height: number } | null {
	if (type === 'VP8 ') {
		if (length < 10 || !matches(bytes, dataStart + 3, [0x9d, 0x01, 0x2a])) {
			return null
		}
		const width = readUint16LE(bytes, dataStart + 6) & 0x3fff
		const height = readUint16LE(bytes, dataStart + 8) & 0x3fff
		return width > 0 && height > 0 ? { width, height } : null
	}
	if (type === 'VP8L') {
		if (length < 5 || bytes[dataStart] !== 0x2f) return null
		const width =
			1 +
			((bytes[dataStart + 1] ?? 0) |
				(((bytes[dataStart + 2] ?? 0) & 0x3f) << 8))
		const height =
			1 +
			(((bytes[dataStart + 2] ?? 0) >> 6) |
				((bytes[dataStart + 3] ?? 0) << 2) |
				(((bytes[dataStart + 4] ?? 0) & 0x0f) << 10))
		return width > 0 && height > 0 ? { width, height } : null
	}
	return null
}

function stripWebpMetadata(bytes: Uint8Array): {
	bytes: Uint8Array
	width: number
	height: number
} | null {
	if (
		bytes.length < 20 ||
		readAscii(bytes, 0, 4) !== 'RIFF' ||
		readAscii(bytes, 8, 4) !== 'WEBP' ||
		readUint32LE(bytes, 4) + 8 !== bytes.length
	) {
		return null
	}

	const keptChunks: Array<{ type: string; data: Uint8Array }> = []
	let offset = 12
	let width = 0
	let height = 0
	let sawImageData = false
	let hasAlphaOrAnim = false

	while (offset + 8 <= bytes.length) {
		const type = readAscii(bytes, offset, 4)
		const length = readUint32LE(bytes, offset + 4)
		const dataStart = offset + 8
		const dataEnd = dataStart + length
		const chunkEnd = dataEnd + (length % 2)
		if (dataEnd < dataStart || chunkEnd > bytes.length) return null

		if (type === 'VP8 ' || type === 'VP8L') {
			const dims = decodeWebpBitstreamDimensions(bytes, type, dataStart, length)
			if (!dims) return null
			width = dims.width
			height = dims.height
			sawImageData = true
			keptChunks.push({ type, data: bytes.subarray(dataStart, dataEnd) })
		} else if (type === 'VP8X') {
			if (length !== 10) return null
			width =
				1 +
				((bytes[dataStart + 4] ?? 0) |
					((bytes[dataStart + 5] ?? 0) << 8) |
					((bytes[dataStart + 6] ?? 0) << 16))
			height =
				1 +
				((bytes[dataStart + 7] ?? 0) |
					((bytes[dataStart + 8] ?? 0) << 8) |
					((bytes[dataStart + 9] ?? 0) << 16))
			if (width === 0 || height === 0) return null
			const copy = new Uint8Array(bytes.subarray(dataStart, dataEnd))
			// Clear ICCP (0x20), EXIF (0x08), XMP (0x04) feature flags.
			copy[0] = (copy[0] ?? 0) & ~(0x20 | 0x08 | 0x04)
			keptChunks.push({ type, data: copy })
		} else if (type === 'ALPH' || type === 'ANIM') {
			hasAlphaOrAnim = true
			keptChunks.push({ type, data: bytes.subarray(dataStart, dataEnd) })
		} else if (type === 'ANMF') {
			hasAlphaOrAnim = true
			sawImageData = true
			keptChunks.push({ type, data: bytes.subarray(dataStart, dataEnd) })
		} else if (!WEBP_METADATA_CHUNKS.has(type)) {
			// Unknown non-image ancillary chunks are also dropped so hidden metadata
			// cannot ride along in custom FourCC chunks.
		}

		offset = chunkEnd
	}

	if (!sawImageData || width === 0 || height === 0) return null

	const finalChunks = hasAlphaOrAnim
		? keptChunks
		: keptChunks.filter((chunk) => chunk.type !== 'VP8X')

	const parts: Uint8Array[] = [new Uint8Array(12)]
	for (const chunk of finalChunks) {
		const header = new Uint8Array(8)
		for (let i = 0; i < 4; i++) header[i] = chunk.type.charCodeAt(i)
		writeUint32LE(header, 4, chunk.data.byteLength)
		parts.push(header, chunk.data)
		if (chunk.data.byteLength % 2 === 1) {
			parts.push(new Uint8Array([0]))
		}
	}

	const output = concatUint8Arrays(parts)
	output.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
	writeUint32LE(output, 4, output.byteLength - 8)
	output.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
	return { bytes: output, width, height }
}

/**
 * Validates magic bytes and size (<= 10 MB), strips EXIF/GPS/XMP/IPTC/comment
 * metadata from JPEG/PNG/WebP in pure TypeScript (safe for Cloudflare Workers),
 * and delegates HEIC/HEIF to an optional injectable converter adapter.
 */
export async function stripAndReencodeGuestPhoto(
	rawBytes: Uint8Array,
	options: {
		maxBytes?: number
		heicConverter?: HeicConverterAdapter
	} = {},
): Promise<CleanedGuestPhoto> {
	const maxBytes = options.maxBytes ?? GUEST_PHOTO_MAX_BYTES
	if (rawBytes.byteLength === 0) {
		throw new GuestPhotoImageError('file_empty', 400, 'Image file is empty')
	}
	if (rawBytes.byteLength > maxBytes) {
		throw new GuestPhotoImageError(
			'file_too_large',
			413,
			`Image exceeds ${maxBytes} byte limit`,
		)
	}

	const detected = detectGuestPhotoMagicFormat(rawBytes)
	if (!detected) {
		throw new GuestPhotoImageError(
			'unsupported_image_type',
			400,
			'Unsupported or invalid image format',
		)
	}

	if (detected === 'image/heic' || detected === 'image/heif') {
		if (!options.heicConverter) {
			throw new GuestPhotoImageError(
				'heic_conversion_unavailable',
				422,
				'HEIC images must be converted to JPEG, PNG, or WebP before upload',
			)
		}
		const converted = await options.heicConverter(rawBytes)
		if (!converted || converted.bytes.byteLength === 0) {
			throw new GuestPhotoImageError(
				'heic_conversion_unavailable',
				422,
				'HEIC conversion is unavailable',
			)
		}
		const cleanedConverted = await stripAndReencodeGuestPhoto(converted.bytes, {
			maxBytes,
		})
		return {
			...cleanedConverted,
			sourceFormat: detected,
		}
	}

	if (detected === 'image/jpeg') {
		const stripped = stripJpegMetadata(rawBytes)
		if (!stripped) {
			throw new GuestPhotoImageError(
				'invalid_image_data',
				400,
				'Invalid JPEG image data',
			)
		}
		return {
			bytes: stripped.bytes,
			contentType: 'image/jpeg',
			extension: 'jpg',
			width: stripped.width,
			height: stripped.height,
			sourceFormat: detected,
		}
	}

	if (detected === 'image/png') {
		const stripped = stripPngMetadata(rawBytes)
		if (!stripped) {
			throw new GuestPhotoImageError(
				'invalid_image_data',
				400,
				'Invalid PNG image data',
			)
		}
		return {
			bytes: stripped.bytes,
			contentType: 'image/png',
			extension: 'png',
			width: stripped.width,
			height: stripped.height,
			sourceFormat: detected,
		}
	}

	const stripped = stripWebpMetadata(rawBytes)
	if (!stripped) {
		throw new GuestPhotoImageError(
			'invalid_image_data',
			400,
			'Invalid WebP image data',
		)
	}
	return {
		bytes: stripped.bytes,
		contentType: 'image/webp',
		extension: 'webp',
		width: stripped.width,
		height: stripped.height,
		sourceFormat: detected,
	}
}
