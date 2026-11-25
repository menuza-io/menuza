import {
	monochromeBitmap,
} from '@repo/common/print-protocols'
import {
	TICKET_DOTS,
	type TicketBitmap,
	type TicketWidthMm,
} from '@repo/common/print-ticket'
import { RECEIPT_LOGO_MAX_HEIGHT_DOTS } from '@repo/common/receipt-extras'

/**
 * The organization logo as a one-colour picture for thermal paper (#263),
 * capped in height. The picture is a PNG (the site icon); it is decoded here
 * with the platform's own inflate, so it runs on Workers and on Node. A logo
 * that cannot be fetched or read is left off the receipt, never an error.
 *
 * The fetch is an adapter so tests never reach a host.
 */
export type LogoFetcher = (url: string) => Promise<Uint8Array | null>

const MAX_BYTES = 2 * 1024 * 1024

let fetcher: LogoFetcher = async (url) => {
	try {
		const response = await fetch(url, {
			redirect: 'error',
			signal: AbortSignal.timeout(4_000),
		})
		if (!response.ok) return null
		const bytes = new Uint8Array(await response.arrayBuffer())
		return bytes.byteLength <= MAX_BYTES ? bytes : null
	} catch {
		return null
	}
}

export function setLogoFetcherForTest(next: LogoFetcher | null) {
	fetcher = next ?? fetcher
	cache.clear()
}

const cache = new Map<string, { at: number; value: Map<number, TicketBitmap | null> }>()
const FRESH_MS = 10 * 60_000

async function inflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('deflate'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Non-interlaced 8-bit PNG to RGBA pixels. Null for anything else. */
export async function decodePng(
	bytes: Uint8Array,
): Promise<{ width: number; height: number; data: Uint8Array } | null> {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	if (bytes.length < 33 || signature.some((b, i) => bytes[i] !== b)) return null
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	let width = 0
	let height = 0
	let depth = 0
	let colorType = 0
	let interlace = 0
	let palette: Uint8Array | null = null
	let alpha: Uint8Array | null = null
	const chunks: Uint8Array[] = []
	let offset = 8
	while (offset + 8 <= bytes.length) {
		const length = view.getUint32(offset)
		const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
		const body = bytes.subarray(offset + 8, offset + 8 + length)
		if (type === 'IHDR') {
			width = view.getUint32(offset + 8)
			height = view.getUint32(offset + 12)
			depth = bytes[offset + 16]!
			colorType = bytes[offset + 17]!
			interlace = bytes[offset + 20]!
		} else if (type === 'PLTE') palette = body
		else if (type === 'tRNS') alpha = body
		else if (type === 'IDAT') chunks.push(body)
		else if (type === 'IEND') break
		offset += 12 + length
	}
	if (!width || !height || depth !== 8 || interlace !== 0) return null
	if (width * height > 4_000_000) return null
	const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
	if (!channels || (colorType === 3 && !palette)) return null
	const total = chunks.reduce((sum, c) => sum + c.length, 0)
	const joined = new Uint8Array(total)
	let at = 0
	for (const chunk of chunks) {
		joined.set(chunk, at)
		at += chunk.length
	}
	let raw: Uint8Array
	try {
		raw = await inflate(joined)
	} catch {
		return null
	}
	const stride = width * channels
	if (raw.length < (stride + 1) * height) return null
	const pixels = new Uint8Array(stride * height)
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)]!
		for (let x = 0; x < stride; x++) {
			const value = raw[y * (stride + 1) + 1 + x]!
			const left = x >= channels ? pixels[y * stride + x - channels]! : 0
			const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0
			const upLeft =
				y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels]! : 0
			let out: number
			switch (filter) {
				case 0:
					out = value
					break
				case 1:
					out = value + left
					break
				case 2:
					out = value + up
					break
				case 3:
					out = value + ((left + up) >> 1)
					break
				case 4: {
					const p = left + up - upLeft
					const pa = Math.abs(p - left)
					const pb = Math.abs(p - up)
					const pc = Math.abs(p - upLeft)
					out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
					break
				}
				default:
					return null
			}
			pixels[y * stride + x] = out & 0xff
		}
	}
	const rgba = new Uint8Array(width * height * 4)
	for (let i = 0; i < width * height; i++) {
		let r: number, g: number, b: number, a = 255
		if (colorType === 6) {
			;[r, g, b, a] = [pixels[i * 4]!, pixels[i * 4 + 1]!, pixels[i * 4 + 2]!, pixels[i * 4 + 3]!]
		} else if (colorType === 2) {
			;[r, g, b] = [pixels[i * 3]!, pixels[i * 3 + 1]!, pixels[i * 3 + 2]!]
		} else if (colorType === 0) {
			r = g = b = pixels[i]!
		} else if (colorType === 4) {
			r = g = b = pixels[i * 2]!
			a = pixels[i * 2 + 1]!
		} else {
			const index = pixels[i]!
			r = palette![index * 3]!
			g = palette![index * 3 + 1]!
			b = palette![index * 3 + 2]!
			a = alpha?.[index] ?? 255
		}
		rgba.set([r, g, b, a], i * 4)
	}
	return { width, height, data: rgba }
}

/** The logo for a paper width, or null when there is none to print. */
export async function logoBitmapFor(
	url: string | null | undefined,
	widthMm: TicketWidthMm,
): Promise<TicketBitmap | null> {
	if (!url) return null
	const now = Date.now()
	const hit = cache.get(url)
	if (hit && now - hit.at < FRESH_MS && hit.value.has(widthMm)) {
		return hit.value.get(widthMm) ?? null
	}
	const bytes = await fetcher(url)
	const image = bytes ? await decodePng(bytes) : null
	const bitmap = image
		? monochromeBitmap(image, {
				maxWidth: Math.floor(TICKET_DOTS[widthMm] / 2),
				maxHeight: RECEIPT_LOGO_MAX_HEIGHT_DOTS,
			})
		: null
	const entry = hit && now - hit.at < FRESH_MS ? hit : { at: now, value: new Map() }
	entry.value.set(widthMm, bitmap)
	if (cache.size > 100) cache.clear()
	cache.set(url, entry)
	return bitmap
}
