import {
	BULK_PHOTO_MAX_FILE_BYTES,
	BULK_PHOTO_MAX_FILES,
	BULK_PHOTO_MAX_TOTAL_BYTES,
	BULK_PHOTO_MAX_ZIP_BYTES,
	imageTypeFromName,
} from '@repo/common/dish-photo-match'

/**
 * Reads a dropped `.zip` of dish photos in the browser (#316). Only the images
 * come out: the central directory is read first, then each wanted entry is
 * read and inflated on its own (stored and deflate, through
 * `DecompressionStream`), so a big zip is never held in memory whole.
 *
 * Zip-bomb safe: an entry whose declared size is over the limits is not read,
 * inflating stops as soon as the real size passes the declared one, and the
 * sizes, the entry count and the total are all capped. Names are cut to their
 * last path segment, so `../../x.jpg` is just `x.jpg`.
 */

export type UnzipErrorCode =
	| 'not_a_zip'
	| 'zip_too_large'
	| 'too_many_entries'
	| 'too_many_photos'
	| 'batch_too_large'
	| 'unsupported'
	| 'corrupt'
	| 'no_photos'

export class UnzipError extends Error {
	constructor(
		readonly code: UnzipErrorCode,
		message?: string,
	) {
		super(message ?? code)
		this.name = 'UnzipError'
	}
}

export type UnzipSkipReason =
	'not_an_image' | 'too_large' | 'encrypted' | 'unsupported' | 'corrupt'

export type UnzipResult = {
	files: File[]
	/** Image entries that could not be used, with why (never silently). */
	skipped: Array<{ name: string; reason: UnzipSkipReason }>
}

/** The central directory of a real photo zip is small; this stops a hostile one. */
export const UNZIP_MAX_ENTRIES = 2000

type Entry = {
	path: string
	flags: number
	method: number
	compressedSize: number
	uncompressedSize: number
	localHeaderOffset: number
}

type ZipSource = {
	size: number
	slice(start?: number, end?: number): ZipSlice
}
type ZipSlice = { arrayBuffer(): Promise<ArrayBuffer> }

function u16(view: DataView, offset: number) {
	return view.getUint16(offset, true)
}
function u32(view: DataView, offset: number) {
	return view.getUint32(offset, true)
}

/** The last path segment, with nothing that could climb out of a folder. */
export function safeZipFileName(path: string): string | null {
	const segments = path.split(/[\\/]+/)
	const last = segments[segments.length - 1] ?? ''
	const cleaned = last

		.replace(/[\u0000-\u001f\u007f]+/g, '')
		.replace(/^\.+/, '')
		.trim()
	if (!cleaned || cleaned === '.' || cleaned === '..') return null
	return cleaned.slice(0, 200)
}

/** Skipped on sight: folders, macOS resource forks and hidden files. */
export function isIgnoredZipPath(path: string): boolean {
	if (path.endsWith('/') || path.endsWith('\\')) return true
	const segments = path.split(/[\\/]+/).filter(Boolean)
	if (segments.includes('__MACOSX')) return true
	const last = segments[segments.length - 1] ?? ''
	return last.startsWith('.') || last.toLowerCase() === 'thumbs.db'
}

async function readCentralDirectory(source: ZipSource): Promise<Entry[]> {
	const tailSize = Math.min(source.size, 65_557)
	const tail = new Uint8Array(
		await source.slice(source.size - tailSize, source.size).arrayBuffer(),
	)
	const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
	let eocd = -1
	for (let i = tail.length - 22; i >= 0; i -= 1) {
		if (u32(tailView, i) === 0x06054b50) {
			eocd = i
			break
		}
	}
	if (eocd < 0) throw new UnzipError('not_a_zip')

	const entryCount = u16(tailView, eocd + 10)
	const directorySize = u32(tailView, eocd + 12)
	const directoryOffset = u32(tailView, eocd + 16)
	if (
		entryCount === 0xffff ||
		directorySize === 0xffffffff ||
		directoryOffset === 0xffffffff
	) {
		// Zip64 is for archives over 4 GB; a photo batch never needs it.
		throw new UnzipError('unsupported', 'Zip64 archives are not supported')
	}
	if (entryCount > UNZIP_MAX_ENTRIES) throw new UnzipError('too_many_entries')
	if (directoryOffset + directorySize > source.size) {
		throw new UnzipError('corrupt', 'Corrupt central directory')
	}

	const directory = new Uint8Array(
		await source
			.slice(directoryOffset, directoryOffset + directorySize)
			.arrayBuffer(),
	)
	const view = new DataView(
		directory.buffer,
		directory.byteOffset,
		directory.byteLength,
	)
	const decoder = new TextDecoder('utf-8')
	const entries: Entry[] = []
	let offset = 0
	for (let i = 0; i < entryCount; i += 1) {
		if (offset + 46 > directory.length || u32(view, offset) !== 0x02014b50) {
			throw new UnzipError('corrupt', 'Bad central directory entry')
		}
		const nameLength = u16(view, offset + 28)
		const extraLength = u16(view, offset + 30)
		const commentLength = u16(view, offset + 32)
		if (offset + 46 + nameLength > directory.length) {
			throw new UnzipError('corrupt', 'Truncated file name')
		}
		entries.push({
			path: decoder.decode(
				directory.subarray(offset + 46, offset + 46 + nameLength),
			),
			flags: u16(view, offset + 8),
			method: u16(view, offset + 10),
			compressedSize: u32(view, offset + 20),
			uncompressedSize: u32(view, offset + 24),
			localHeaderOffset: u32(view, offset + 42),
		})
		offset += 46 + nameLength + extraLength + commentLength
	}
	return entries
}

async function readEntryBytes(
	source: ZipSource,
	entry: Entry,
): Promise<Uint8Array> {
	const header = new Uint8Array(
		await source
			.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30)
			.arrayBuffer(),
	)
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
	if (header.length < 30 || u32(view, 0) !== 0x04034b50) {
		throw new UnzipError('corrupt', 'Bad local file header')
	}
	const dataStart = entry.localHeaderOffset + 30 + u16(view, 26) + u16(view, 28)
	const dataEnd = dataStart + entry.compressedSize
	if (dataEnd > source.size) throw new UnzipError('corrupt', 'Truncated entry')
	const compressed = new Uint8Array(
		await source.slice(dataStart, dataEnd).arrayBuffer(),
	)

	if (entry.method === 0) {
		if (compressed.byteLength !== entry.uncompressedSize) {
			throw new UnzipError('corrupt', 'Stored entry size mismatch')
		}
		return compressed
	}
	if (entry.method !== 8) throw new UnzipError('unsupported')

	const stream = new Blob([compressed as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream('deflate-raw'))
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			total += value.byteLength
			// The declared size is the budget: a lie is stopped, not inflated.
			if (total > entry.uncompressedSize) {
				await reader.cancel().catch(() => undefined)
				throw new UnzipError('corrupt', 'Entry is larger than declared')
			}
			chunks.push(value)
		}
	} catch (error) {
		if (error instanceof UnzipError) throw error
		throw new UnzipError('corrupt', 'Entry could not be inflated')
	} finally {
		reader.releaseLock()
	}
	if (total !== entry.uncompressedSize) {
		throw new UnzipError('corrupt', 'Entry is smaller than declared')
	}
	const out = new Uint8Array(total)
	let position = 0
	for (const chunk of chunks) {
		out.set(chunk, position)
		position += chunk.byteLength
	}
	return out
}

/** Makes names unique inside one batch: `a.jpg`, `a (2).jpg`. */
function uniqueName(name: string, used: Set<string>) {
	if (!used.has(name.toLowerCase())) {
		used.add(name.toLowerCase())
		return name
	}
	const dot = name.lastIndexOf('.')
	const base = dot > 0 ? name.slice(0, dot) : name
	const extension = dot > 0 ? name.slice(dot) : ''
	for (let n = 2; ; n += 1) {
		const candidate = `${base} (${n})${extension}`
		if (!used.has(candidate.toLowerCase())) {
			used.add(candidate.toLowerCase())
			return candidate
		}
	}
}

export function isZipFileName(name: string) {
	return /\.zip$/i.test(name)
}

/** The images in a zip as `File`s, or an `UnzipError` that says why not. */
export async function unzipPhotos(zip: Blob): Promise<UnzipResult> {
	if (zip.size > BULK_PHOTO_MAX_ZIP_BYTES) throw new UnzipError('zip_too_large')
	if (zip.size < 22) throw new UnzipError('not_a_zip')
	const source: ZipSource = zip
	const entries = await readCentralDirectory(source)

	const files: File[] = []
	const skipped: UnzipResult['skipped'] = []
	const usedNames = new Set<string>()
	let total = 0
	for (const entry of entries) {
		if (isIgnoredZipPath(entry.path)) continue
		const name = safeZipFileName(entry.path)
		const type = name ? imageTypeFromName(name) : null
		if (!name || !type) {
			// Not an image: nothing is read, it is just not part of the batch.
			if (name) skipped.push({ name, reason: 'not_an_image' })
			continue
		}
		if ((entry.flags & 1) !== 0) {
			skipped.push({ name, reason: 'encrypted' })
			continue
		}
		if (entry.method !== 0 && entry.method !== 8) {
			skipped.push({ name, reason: 'unsupported' })
			continue
		}
		if (entry.uncompressedSize === 0) {
			skipped.push({ name, reason: 'corrupt' })
			continue
		}
		if (entry.uncompressedSize > BULK_PHOTO_MAX_FILE_BYTES) {
			skipped.push({ name, reason: 'too_large' })
			continue
		}
		if (files.length >= BULK_PHOTO_MAX_FILES) {
			throw new UnzipError('too_many_photos')
		}
		total += entry.uncompressedSize
		if (total > BULK_PHOTO_MAX_TOTAL_BYTES)
			throw new UnzipError('batch_too_large')
		try {
			const bytes = await readEntryBytes(source, entry)
			files.push(
				new File(
					[bytes as Uint8Array<ArrayBuffer>],
					uniqueName(name, usedNames),
					{
						type,
					},
				),
			)
		} catch (error) {
			if (error instanceof UnzipError && error.code === 'unsupported') {
				skipped.push({ name, reason: 'unsupported' })
			} else {
				skipped.push({ name, reason: 'corrupt' })
			}
		}
	}
	if (files.length === 0) throw new UnzipError('no_photos')
	return { files, skipped }
}
