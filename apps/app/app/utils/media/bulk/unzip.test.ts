import {
	BULK_PHOTO_MAX_FILE_BYTES,
	BULK_PHOTO_MAX_FILES,
	BULK_PHOTO_MAX_ZIP_BYTES,
} from '@repo/common/dish-photo-match'
import { describe, expect, it } from 'vitest'
import {
	isIgnoredZipPath,
	safeZipFileName,
	UnzipError,
	unzipPhotos,
} from './unzip.ts'

type ZipEntrySpec = {
	name: string
	data?: Uint8Array
	method?: number
	/** Lie about the uncompressed size in both headers. */
	declaredSize?: number
	flags?: number
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new CompressionStream('deflate-raw'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A real zip file, built by hand: local headers, central directory, EOCD. */
async function buildZip(entries: ZipEntrySpec[]): Promise<Blob> {
	const encoder = new TextEncoder()
	const parts: Uint8Array[] = []
	const central: Uint8Array[] = []
	let offset = 0
	for (const entry of entries) {
		const raw = entry.data ?? new Uint8Array(0)
		const method = entry.method ?? 0
		const stored = method === 8 ? await deflateRaw(raw) : raw
		const usize = entry.declaredSize ?? raw.length
		const name = encoder.encode(entry.name)
		const flags = entry.flags ?? 0

		const local = new Uint8Array(30 + name.length)
		const lv = new DataView(local.buffer)
		lv.setUint32(0, 0x04034b50, true)
		lv.setUint16(4, 20, true)
		lv.setUint16(6, flags, true)
		lv.setUint16(8, method, true)
		lv.setUint32(18, stored.length, true)
		lv.setUint32(22, usize, true)
		lv.setUint16(26, name.length, true)
		local.set(name, 30)

		const cd = new Uint8Array(46 + name.length)
		const cv = new DataView(cd.buffer)
		cv.setUint32(0, 0x02014b50, true)
		cv.setUint16(4, 20, true)
		cv.setUint16(6, 20, true)
		cv.setUint16(8, flags, true)
		cv.setUint16(10, method, true)
		cv.setUint32(20, stored.length, true)
		cv.setUint32(24, usize, true)
		cv.setUint16(28, name.length, true)
		cv.setUint32(42, offset, true)
		cd.set(name, 46)

		parts.push(local, stored)
		central.push(cd)
		offset += local.length + stored.length
	}
	const directorySize = central.reduce((sum, part) => sum + part.length, 0)
	const eocd = new Uint8Array(22)
	const ev = new DataView(eocd.buffer)
	ev.setUint32(0, 0x06054b50, true)
	ev.setUint16(8, entries.length, true)
	ev.setUint16(10, entries.length, true)
	ev.setUint32(12, directorySize, true)
	ev.setUint32(16, offset, true)
	return new Blob([...parts, ...central, eocd] as BlobPart[])
}

const bytes = (...values: number[]) => new Uint8Array(values)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6)

async function text(file: File) {
	return new Uint8Array(await file.arrayBuffer())
}

describe('unzipPhotos', () => {
	it('reads stored and deflated image entries', async () => {
		const big = new Uint8Array(5000).fill(7)
		const zip = await buildZip([
			{ name: 'Margherita Pizza.jpg', data: JPEG, method: 0 },
			{ name: 'photos/Beef Burger.PNG', data: big, method: 8 },
		])
		const { files, skipped } = await unzipPhotos(zip)
		expect(files.map((file) => [file.name, file.type, file.size])).toEqual([
			['Margherita Pizza.jpg', 'image/jpeg', JPEG.length],
			['Beef Burger.PNG', 'image/png', 5000],
		])
		expect(skipped).toEqual([])
		expect(await text(files[0]!)).toEqual(JPEG)
		expect(await text(files[1]!)).toEqual(big)
	})

	it('ignores folders, macOS resource forks, hidden files and non-images', async () => {
		const zip = await buildZip([
			{ name: 'photos/' },
			{ name: '__MACOSX/photos/._pizza.jpg', data: JPEG },
			{ name: 'photos/.DS_Store', data: JPEG },
			{ name: 'photos/Thumbs.db', data: JPEG },
			{ name: 'photos/notes.txt', data: bytes(1, 2, 3) },
			{ name: 'photos/pizza.jpg', data: JPEG },
		])
		const { files, skipped } = await unzipPhotos(zip)
		expect(files.map((file) => file.name)).toEqual(['pizza.jpg'])
		// A non-image is reported, never read; the junk entries are not mentioned.
		expect(skipped).toEqual([{ name: 'notes.txt', reason: 'not_an_image' }])
	})

	it('keeps only the base name, so a path cannot climb out of a folder', async () => {
		const zip = await buildZip([
			{ name: '../../evil/pizza.jpg', data: JPEG },
			{ name: '..\\..\\windows\\burger.png', data: JPEG },
			{ name: '/etc/absolute.webp', data: JPEG },
		])
		const { files } = await unzipPhotos(zip)
		expect(files.map((file) => file.name)).toEqual([
			'pizza.jpg',
			'burger.png',
			'absolute.webp',
		])
		expect(safeZipFileName('a/b/..')).toBeNull()
		expect(safeZipFileName('..')).toBeNull()
		expect(safeZipFileName('dir/\u0000x.jpg')).toBe('x.jpg')
		expect(isIgnoredZipPath('dir/')).toBe(true)
	})

	it('gives two files with the same name different names', async () => {
		const zip = await buildZip([
			{ name: 'a/pizza.jpg', data: JPEG },
			{ name: 'b/pizza.jpg', data: JPEG },
			{ name: 'c/Pizza.jpg', data: JPEG },
		])
		const { files } = await unzipPhotos(zip)
		expect(files.map((file) => file.name)).toEqual([
			'pizza.jpg',
			'pizza (2).jpg',
			'Pizza (3).jpg',
		])
	})

	it('skips an image that declares more than the single-photo limit, without reading it', async () => {
		const zip = await buildZip([
			{
				name: 'huge.jpg',
				data: JPEG,
				declaredSize: BULK_PHOTO_MAX_FILE_BYTES + 1,
			},
			{ name: 'ok.jpg', data: JPEG },
		])
		const { files, skipped } = await unzipPhotos(zip)
		expect(files.map((file) => file.name)).toEqual(['ok.jpg'])
		expect(skipped).toEqual([{ name: 'huge.jpg', reason: 'too_large' }])
	})

	it('is zip-bomb safe: inflating stops when the real size passes the declared one', async () => {
		const bomb = new Uint8Array(2_000_000) // compresses to a few KB
		const zip = await buildZip([
			{ name: 'bomb.jpg', data: bomb, method: 8, declaredSize: 100 },
			{ name: 'ok.jpg', data: JPEG },
		])
		const { files, skipped } = await unzipPhotos(zip)
		expect(files.map((file) => file.name)).toEqual(['ok.jpg'])
		expect(skipped).toEqual([{ name: 'bomb.jpg', reason: 'corrupt' }])
	})

	it('skips an entry that is smaller than it declares', async () => {
		const zip = await buildZip([
			{ name: 'short.jpg', data: JPEG, method: 8, declaredSize: 5000 },
			{ name: 'ok.jpg', data: JPEG },
		])
		const { files, skipped } = await unzipPhotos(zip)
		expect(files.map((file) => file.name)).toEqual(['ok.jpg'])
		expect(skipped).toEqual([{ name: 'short.jpg', reason: 'corrupt' }])
	})

	it('skips encrypted entries and unknown compression methods', async () => {
		const zip = await buildZip([
			{ name: 'secret.jpg', data: JPEG, flags: 1 },
			{ name: 'odd.jpg', data: JPEG, method: 12 },
			{ name: 'ok.jpg', data: JPEG },
		])
		const { files, skipped } = await unzipPhotos(zip)
		expect(files.map((file) => file.name)).toEqual(['ok.jpg'])
		expect(skipped).toEqual([
			{ name: 'secret.jpg', reason: 'encrypted' },
			{ name: 'odd.jpg', reason: 'unsupported' },
		])
	})

	it('refuses a zip over the size limit before reading it', async () => {
		const fake = {
			size: BULK_PHOTO_MAX_ZIP_BYTES + 1,
			slice() {
				throw new Error('must not be read')
			},
		} as unknown as Blob
		await expect(unzipPhotos(fake)).rejects.toMatchObject({
			code: 'zip_too_large',
		})
	})

	it('refuses more photos than a batch allows', async () => {
		const zip = await buildZip(
			Array.from({ length: BULK_PHOTO_MAX_FILES + 1 }, (_, index) => ({
				name: `dish-${index}.jpg`,
				data: JPEG,
			})),
		)
		await expect(unzipPhotos(zip)).rejects.toMatchObject({
			code: 'too_many_photos',
		})
	})

	it('refuses a batch whose declared total is over the limit', async () => {
		// 9 MB each: the 45th passes 400 MB. Sizes are declared, never inflated.
		const zip = await buildZip(
			Array.from({ length: 50 }, (_, index) => ({
				name: `dish-${index}.jpg`,
				data: JPEG,
				declaredSize: 9 * 1024 * 1024,
			})),
		)
		await expect(unzipPhotos(zip)).rejects.toMatchObject({
			code: 'batch_too_large',
		})
	})

	it('refuses something that is not a zip and a zip with no photos', async () => {
		await expect(
			unzipPhotos(new Blob([new Uint8Array(200).fill(1)])),
		).rejects.toBeInstanceOf(UnzipError)
		await expect(
			unzipPhotos(new Blob([new Uint8Array(200)])),
		).rejects.toMatchObject({ code: 'not_a_zip' })
		await expect(unzipPhotos(new Blob(['tiny']))).rejects.toMatchObject({
			code: 'not_a_zip',
		})
		const onlyText = await buildZip([{ name: 'readme.txt', data: bytes(1) }])
		await expect(unzipPhotos(onlyText)).rejects.toMatchObject({
			code: 'no_photos',
		})
	})

	it('refuses a central directory that points outside the file', async () => {
		const zip = await buildZip([{ name: 'a.jpg', data: JPEG }])
		const copy = new Uint8Array(await zip.arrayBuffer())
		// Point the directory offset past the end of the file.
		new DataView(copy.buffer).setUint32(copy.length - 6, 0x7fffffff, true)
		await expect(unzipPhotos(new Blob([copy]))).rejects.toMatchObject({
			code: 'corrupt',
		})
	})
})
