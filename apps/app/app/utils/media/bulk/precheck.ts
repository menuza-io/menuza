import {
	BULK_PHOTO_MAX_FILE_BYTES,
	BULK_PHOTO_MAX_FILES,
	BULK_PHOTO_MAX_TOTAL_BYTES,
	checkBulkPhotoBatch,
	type BulkPhotoRefusal,
} from '@repo/common/dish-photo-match'
import { hasLowResolution } from '@repo/common/photo-quality'

/**
 * Checks run in the browser before and while a batch uploads (#316), so the
 * operator sees "Not a photo", "Too small" and "Duplicate" next to each file
 * before anything is attached. The server checks every upload again (magic
 * bytes, size, re-encoding); this is only the early, friendly pass.
 */

export type PrecheckFlag =
	'not_an_image' | 'too_large' | 'too_small' | 'duplicate'

export type ImageKind = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif'

export type ImageSize = { width: number; height: number }

export type PrecheckResult = {
	hash: string | null
	kind: ImageKind | null
	width: number | null
	height: number | null
	flags: PrecheckFlag[]
}

export function detectImageKind(bytes: Uint8Array): ImageKind | null {
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return 'jpeg'
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return 'png'
	}
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38
	) {
		return 'gif'
	}
	if (
		bytes.length >= 12 &&
		ascii(bytes, 0, 4) === 'RIFF' &&
		ascii(bytes, 8, 4) === 'WEBP'
	) {
		return 'webp'
	}
	if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
		const brand = ascii(bytes, 8, 4)
		if (brand === 'avif' || brand === 'avis') return 'avif'
	}
	return null
}

function ascii(bytes: Uint8Array, start: number, length: number) {
	let out = ''
	for (let i = start; i < start + length && i < bytes.length; i += 1) {
		out += String.fromCharCode(bytes[i]!)
	}
	return out
}

/**
 * Width and height from the file header (JPEG, PNG, GIF and WebP), without
 * decoding the picture. `null` when the header does not say (AVIF: the caller
 * measures it in the browser).
 */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
	const kind = detectImageKind(bytes)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (kind === 'png') {
		if (bytes.length < 24) return null
		return sized(view.getUint32(16), view.getUint32(20))
	}
	if (kind === 'gif') {
		if (bytes.length < 10) return null
		return sized(view.getUint16(6, true), view.getUint16(8, true))
	}
	if (kind === 'jpeg') {
		let offset = 2
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset += 1
				continue
			}
			const marker = bytes[offset + 1]!
			if (marker === 0xff) {
				offset += 1
				continue
			}
			// Markers without a length.
			if (
				marker === 0xd8 ||
				marker === 0x01 ||
				(marker >= 0xd0 && marker <= 0xd7)
			) {
				offset += 2
				continue
			}
			const length = view.getUint16(offset + 2)
			if (length < 2) return null
			// Start of frame (not DHT, JPG, DAC): height, then width.
			if (
				marker >= 0xc0 &&
				marker <= 0xcf &&
				marker !== 0xc4 &&
				marker !== 0xc8 &&
				marker !== 0xcc
			) {
				return sized(view.getUint16(offset + 7), view.getUint16(offset + 5))
			}
			offset += 2 + length
		}
		return null
	}
	if (kind === 'webp') {
		if (bytes.length < 30) return null
		const chunk = ascii(bytes, 12, 4)
		if (chunk === 'VP8 ') {
			return sized(
				view.getUint16(26, true) & 0x3fff,
				view.getUint16(28, true) & 0x3fff,
			)
		}
		if (chunk === 'VP8L') {
			const bits = view.getUint32(21, true)
			return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
		}
		if (chunk === 'VP8X') {
			const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
			const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
			return sized(width, height)
		}
	}
	return null
}

function sized(width: number, height: number): ImageSize | null {
	return width > 0 && height > 0 ? { width, height } : null
}

export async function sha256Hex(
	data: ArrayBuffer | Uint8Array,
): Promise<string> {
	const source =
		data instanceof Uint8Array
			? (data.buffer.slice(
					data.byteOffset,
					data.byteOffset + data.byteLength,
				) as ArrayBuffer)
			: data
	const digest = await crypto.subtle.digest('SHA-256', source)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

/** Checks one file: type, size, resolution, and its content hash. */
export async function precheckFile(
	file: Pick<File, 'name' | 'size' | 'type' | 'arrayBuffer'>,
	/** Measures what the header does not say (the browser decodes it). */
	measure?: (
		file: Pick<File, 'name' | 'size' | 'type' | 'arrayBuffer'>,
	) => Promise<ImageSize | null>,
): Promise<PrecheckResult> {
	const flags: PrecheckFlag[] = []
	const batchCheck = checkBulkPhotoBatch([file])
	if (!batchCheck.ok) flags.push(refusalFlag(batchCheck.error))
	if (file.size <= 0 || file.size > BULK_PHOTO_MAX_FILE_BYTES * 4) {
		// Not read at all: far past the limit, or empty.
		return {
			hash: null,
			kind: null,
			width: null,
			height: null,
			flags: unique(flags),
		}
	}
	let data: Uint8Array
	try {
		data = new Uint8Array(await file.arrayBuffer())
	} catch {
		return {
			hash: null,
			kind: null,
			width: null,
			height: null,
			flags: unique([...flags, 'not_an_image']),
		}
	}
	const kind = detectImageKind(data)
	// The bytes decide, not the extension or the browser's guess.
	if (!kind) flags.push('not_an_image')
	let size = kind ? readImageSize(data) : null
	if (kind && !size && measure) {
		try {
			size = await measure(file)
		} catch {
			size = null
		}
	}
	if (size && hasLowResolution(size.width, size.height)) flags.push('too_small')
	return {
		hash: await sha256Hex(data),
		kind,
		width: size?.width ?? null,
		height: size?.height ?? null,
		flags: unique(flags),
	}
}

function refusalFlag(error: BulkPhotoRefusal): PrecheckFlag {
	return error === 'too_large' ? 'too_large' : 'not_an_image'
}

function unique<T>(list: T[]): T[] {
	return [...new Set(list)]
}

/**
 * Marks the later of two files with the same content hash as a duplicate.
 * The first one stays clean, so one copy of each photo goes on.
 */
export function markDuplicates<
	T extends { hash: string | null; flags: PrecheckFlag[] },
>(results: readonly T[]): T[] {
	const seen = new Set<string>()
	return results.map((result) => {
		if (!result.hash) return result
		if (seen.has(result.hash)) {
			return {
				...result,
				flags: result.flags.includes('duplicate')
					? result.flags
					: [...result.flags, 'duplicate' as const],
			}
		}
		seen.add(result.hash)
		return result
	})
}

/** A file that should not be uploaded at all. */
export function isBlockedByPrecheck(flags: readonly PrecheckFlag[]) {
	return flags.includes('not_an_image') || flags.includes('too_large')
}

/**
 * Which of the incoming files still fit in the batch: at most
 * `BULK_PHOTO_MAX_FILES` photos and `BULK_PHOTO_MAX_TOTAL_BYTES` together
 * (what is already in the batch counts). The rest are named, not dropped
 * silently.
 */
export function acceptIntoBatch<T extends { size: number }>(
	existing: ReadonlyArray<{ size: number }>,
	incoming: readonly T[],
): { accepted: T[]; tooMany: T[]; tooBig: T[] } {
	let count = existing.length
	let bytes = existing.reduce((sum, file) => sum + file.size, 0)
	const accepted: T[] = []
	const tooMany: T[] = []
	const tooBig: T[] = []
	for (const file of incoming) {
		if (count >= BULK_PHOTO_MAX_FILES) {
			tooMany.push(file)
		} else if (bytes + file.size > BULK_PHOTO_MAX_TOTAL_BYTES) {
			tooBig.push(file)
		} else {
			accepted.push(file)
			count += 1
			bytes += file.size
		}
	}
	return { accepted, tooMany, tooBig }
}
