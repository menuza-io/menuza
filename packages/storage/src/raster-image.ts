export type DetectedRasterFormat = {
	extension: 'jpg' | 'png' | 'gif' | 'webp' | 'avif'
	mimeType:
		'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/avif'
	width: number
	height: number
}

type Dimensions = Pick<DetectedRasterFormat, 'width' | 'height'>

function matches(bytes: Uint8Array, offset: number, expected: number[]) {
	return expected.every((value, index) => bytes[offset + index] === value)
}

function readUint16BE(bytes: Uint8Array, offset: number) {
	return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function readUint16LE(bytes: Uint8Array, offset: number) {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readUint24LE(bytes: Uint8Array, offset: number) {
	return (
		(bytes[offset] ?? 0) |
		((bytes[offset + 1] ?? 0) << 8) |
		((bytes[offset + 2] ?? 0) << 16)
	)
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

function readAscii(bytes: Uint8Array, offset: number, length: number) {
	let value = ''
	for (let index = 0; index < length; index++) {
		value += String.fromCharCode(bytes[offset + index] ?? 0)
	}
	return value
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function decodeJpeg(bytes: Uint8Array): Dimensions | null {
	if (bytes.length < 4 || !matches(bytes, 0, [0xff, 0xd8])) return null

	let offset = 2
	let dimensions: Dimensions | null = null
	let hasScan = false

	while (offset < bytes.length) {
		if (bytes[offset] !== 0xff) return null
		while (bytes[offset] === 0xff) offset++
		if (offset >= bytes.length) return null

		const marker = bytes[offset++]!
		if (marker === 0xd9) {
			return offset === bytes.length && hasScan ? dimensions : null
		}
		if (marker === 0x00) return null
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
		if (offset + 2 > bytes.length) return null

		const segmentLength = readUint16BE(bytes, offset)
		if (segmentLength < 2 || offset + segmentLength > bytes.length) return null
		const payloadStart = offset + 2
		const segmentEnd = offset + segmentLength

		if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
			if (segmentLength < 8) return null
			const height = readUint16BE(bytes, payloadStart + 1)
			const width = readUint16BE(bytes, payloadStart + 3)
			if (width === 0 || height === 0) return null
			dimensions = { width, height }
		}

		offset = segmentEnd
		if (marker !== 0xda) continue
		hasScan = true

		let foundNextMarker = false
		while (offset < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset++
				continue
			}

			const markerOffset = offset
			while (bytes[offset] === 0xff) offset++
			if (offset >= bytes.length) return null
			const scanMarker = bytes[offset]!
			if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
				offset++
				continue
			}
			offset = markerOffset
			foundNextMarker = true
			break
		}
		if (!foundNextMarker) return null
	}

	return null
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let index = 0; index < table.length; index++) {
		let value = index
		for (let bit = 0; bit < 8; bit++) {
			value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
		}
		table[index] = value >>> 0
	}
	return table
})()

function crc32(bytes: Uint8Array, start: number, end: number) {
	let crc = 0xffffffff
	for (let index = start; index < end; index++) {
		crc = CRC32_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff]! ^ (crc >>> 8)
	}
	return (crc ^ 0xffffffff) >>> 0
}

function decodePng(bytes: Uint8Array): Dimensions | null {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	if (bytes.length < 45 || !matches(bytes, 0, signature)) return null

	let offset = signature.length
	let dimensions: Dimensions | null = null
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
			const width = readUint32BE(bytes, dataStart)
			const height = readUint32BE(bytes, dataStart + 4)
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
			dimensions = { width, height }
		} else if (type === 'IHDR') {
			return null
		}

		if (type === 'IDAT' && length > 0) sawImageData = true
		if (type === 'IEND') {
			return length === 0 && chunkEnd === bytes.length && sawImageData
				? dimensions
				: null
		}

		offset = chunkEnd
		chunkIndex++
	}

	return null
}

function skipGifSubBlocks(bytes: Uint8Array, initialOffset: number) {
	let offset = initialOffset
	let sawData = false
	while (offset < bytes.length) {
		const size = bytes[offset++] ?? 0
		if (size === 0) return { offset, sawData }
		if (offset + size > bytes.length) return null
		sawData = true
		offset += size
	}
	return null
}

function decodeGif(bytes: Uint8Array): Dimensions | null {
	const header = readAscii(bytes, 0, 6)
	if (bytes.length < 14 || (header !== 'GIF87a' && header !== 'GIF89a')) {
		return null
	}

	const width = readUint16LE(bytes, 6)
	const height = readUint16LE(bytes, 8)
	if (width === 0 || height === 0) return null

	const packed = bytes[10] ?? 0
	let offset = 13
	if (packed & 0x80) {
		offset += 3 * 2 ** ((packed & 0x07) + 1)
	}
	if (offset > bytes.length) return null

	let sawImage = false
	while (offset < bytes.length) {
		const blockType = bytes[offset++]
		if (blockType === 0x3b) {
			return offset === bytes.length && sawImage ? { width, height } : null
		}

		if (blockType === 0x21) {
			if (offset >= bytes.length) return null
			offset++
			const extension = skipGifSubBlocks(bytes, offset)
			if (!extension) return null
			offset = extension.offset
			continue
		}

		if (blockType !== 0x2c || offset + 9 > bytes.length) return null
		const imageWidth = readUint16LE(bytes, offset + 4)
		const imageHeight = readUint16LE(bytes, offset + 6)
		const imagePacked = bytes[offset + 8] ?? 0
		if (imageWidth === 0 || imageHeight === 0) return null
		offset += 9
		if (imagePacked & 0x80) {
			offset += 3 * 2 ** ((imagePacked & 0x07) + 1)
		}
		if (offset >= bytes.length) return null

		const minimumCodeSize = bytes[offset++] ?? 0
		if (minimumCodeSize < 2 || minimumCodeSize > 8) return null
		const imageData = skipGifSubBlocks(bytes, offset)
		if (!imageData?.sawData) return null
		offset = imageData.offset
		sawImage = true
	}

	return null
}

function decodeWebpBitstream(
	bytes: Uint8Array,
	type: string,
	dataStart: number,
	length: number,
): Dimensions | null {
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
		return {
			width:
				1 +
				((bytes[dataStart + 1] ?? 0) |
					(((bytes[dataStart + 2] ?? 0) & 0x3f) << 8)),
			height:
				1 +
				(((bytes[dataStart + 2] ?? 0) >> 6) |
					((bytes[dataStart + 3] ?? 0) << 2) |
					(((bytes[dataStart + 4] ?? 0) & 0x0f) << 10)),
		}
	}

	return null
}

function decodeWebpAnimationFrame(
	bytes: Uint8Array,
	dataStart: number,
	dataEnd: number,
): Dimensions | null {
	if (dataStart + 16 > dataEnd) return null
	let offset = dataStart + 16

	while (offset + 8 <= dataEnd) {
		const type = readAscii(bytes, offset, 4)
		const length = readUint32LE(bytes, offset + 4)
		const nestedDataStart = offset + 8
		const nestedDataEnd = nestedDataStart + length
		const chunkEnd = nestedDataEnd + (length % 2)
		if (nestedDataEnd < nestedDataStart || chunkEnd > dataEnd) return null

		if (type === 'VP8 ' || type === 'VP8L') {
			return decodeWebpBitstream(bytes, type, nestedDataStart, length)
		}
		offset = chunkEnd
	}

	return null
}

function decodeWebp(bytes: Uint8Array): Dimensions | null {
	if (
		bytes.length < 20 ||
		readAscii(bytes, 0, 4) !== 'RIFF' ||
		readAscii(bytes, 8, 4) !== 'WEBP' ||
		readUint32LE(bytes, 4) + 8 !== bytes.length
	) {
		return null
	}

	let offset = 12
	let dimensions: Dimensions | null = null
	let sawImageData = false
	while (offset + 8 <= bytes.length) {
		const type = readAscii(bytes, offset, 4)
		const length = readUint32LE(bytes, offset + 4)
		const dataStart = offset + 8
		const dataEnd = dataStart + length
		const chunkEnd = dataEnd + (length % 2)
		if (dataEnd < dataStart || chunkEnd > bytes.length) return null

		if (type === 'VP8X') {
			if (length !== 10) return null
			dimensions = {
				width: readUint24LE(bytes, dataStart + 4) + 1,
				height: readUint24LE(bytes, dataStart + 7) + 1,
			}
		} else if (type === 'VP8 ' || type === 'VP8L') {
			const bitstreamDimensions = decodeWebpBitstream(
				bytes,
				type,
				dataStart,
				length,
			)
			if (!bitstreamDimensions) return null
			dimensions ??= bitstreamDimensions
			sawImageData = true
		} else if (type === 'ANMF') {
			const frameDimensions = decodeWebpAnimationFrame(
				bytes,
				dataStart,
				dataEnd,
			)
			if (!frameDimensions) return null
			dimensions ??= frameDimensions
			sawImageData = true
		}

		offset = chunkEnd
	}

	return offset === bytes.length && sawImageData && dimensions?.width
		? dimensions
		: null
}

type IsoBox = {
	type: string
	payloadStart: number
	end: number
}

function readIsoBox(
	bytes: Uint8Array,
	offset: number,
	containerEnd: number,
): IsoBox | null {
	if (offset + 8 > containerEnd) return null
	let size = readUint32BE(bytes, offset)
	const type = readAscii(bytes, offset + 4, 4)
	let headerSize = 8

	if (size === 1) {
		if (offset + 16 > containerEnd) return null
		const high = readUint32BE(bytes, offset + 8)
		const low = readUint32BE(bytes, offset + 12)
		if (high > 0x1fffff) return null
		size = high * 0x100000000 + low
		headerSize = 16
	} else if (size === 0) {
		size = containerEnd - offset
	}

	if (size < headerSize || offset + size > containerEnd) return null
	return { type, payloadStart: offset + headerSize, end: offset + size }
}

function decodeAvif(bytes: Uint8Array): Dimensions | null {
	if (bytes.length < 32) return null

	let hasAvifBrand = false
	let hasMeta = false
	let hasImageData = false
	let dimensions: Dimensions | null = null
	const containers = new Set(['meta', 'iprp', 'ipco'])
	const maxNestingDepth = 16

	const scanBoxes = (
		start: number,
		end: number,
		parent?: string,
		depth = 0,
	): boolean => {
		if (depth > maxNestingDepth) return false
		let offset = parent === 'meta' ? start + 4 : start
		if (offset > end) return false

		while (offset < end) {
			const box = readIsoBox(bytes, offset, end)
			if (!box) return false

			if (box.type === 'ftyp') {
				if (box.end - box.payloadStart < 8) return false
				for (let brandOffset = box.payloadStart; brandOffset + 4 <= box.end;) {
					const brand = readAscii(bytes, brandOffset, 4)
					if (brand === 'avif' || brand === 'avis') hasAvifBrand = true
					brandOffset += brandOffset === box.payloadStart ? 8 : 4
				}
			} else if (box.type === 'meta') {
				hasMeta = true
			} else if (box.type === 'mdat' || box.type === 'idat') {
				hasImageData ||= box.end > box.payloadStart
			} else if (box.type === 'ispe') {
				if (box.end - box.payloadStart < 12) return false
				const width = readUint32BE(bytes, box.payloadStart + 4)
				const height = readUint32BE(bytes, box.payloadStart + 8)
				if (width === 0 || height === 0) return false
				dimensions = { width, height }
			}

			if (
				containers.has(box.type) &&
				!scanBoxes(box.payloadStart, box.end, box.type, depth + 1)
			) {
				return false
			}
			offset = box.end
		}
		return offset === end
	}

	return scanBoxes(0, bytes.length) && hasAvifBrand && hasMeta && hasImageData
		? dimensions
		: null
}

export function detectRasterImage(
	buffer: ArrayBuffer,
): DetectedRasterFormat | null {
	const bytes = new Uint8Array(buffer)

	const jpeg = decodeJpeg(bytes)
	if (jpeg) return { extension: 'jpg', mimeType: 'image/jpeg', ...jpeg }

	const png = decodePng(bytes)
	if (png) return { extension: 'png', mimeType: 'image/png', ...png }

	const gif = decodeGif(bytes)
	if (gif) return { extension: 'gif', mimeType: 'image/gif', ...gif }

	const webp = decodeWebp(bytes)
	if (webp) return { extension: 'webp', mimeType: 'image/webp', ...webp }

	const avif = decodeAvif(bytes)
	if (avif) return { extension: 'avif', mimeType: 'image/avif', ...avif }

	return null
}

export function isValidRasterBytes(buffer: ArrayBuffer): boolean {
	return detectRasterImage(buffer) !== null
}
