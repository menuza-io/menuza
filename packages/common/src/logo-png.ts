/**
 * Tiny PNG reader for logo palette tests and the server. The browser samples
 * a logo with canvas and calls `suggestLogoPalette` in `site-theme.ts`.
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { type Rgb } from './site-theme.ts'

function crc32(buffer: Buffer) {
	let crc = ~0
	for (const byte of buffer) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
		}
	}
	return ~crc >>> 0
}

function chunk(type: string, data: Buffer) {
	const typeBuf = Buffer.from(type)
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length, 0)
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
	return Buffer.concat([length, typeBuf, data, crc])
}

/** A solid RGB PNG (no filter). */
export function solidPng(
	r: number,
	g: number,
	b: number,
	size = 8,
): Uint8Array {
	const raw = Buffer.alloc(size * (1 + size * 3))
	for (let y = 0; y < size; y += 1) {
		const row = y * (1 + size * 3)
		raw[row] = 0
		for (let x = 0; x < size; x += 1) {
			const i = row + 1 + x * 3
			raw[i] = r
			raw[i + 1] = g
			raw[i + 2] = b
		}
	}
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(size, 0)
	ihdr.writeUInt32BE(size, 4)
	ihdr[8] = 8
	ihdr[9] = 2
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	])
}

export function samplesFromPng(bytes: Uint8Array): Rgb[] {
	const buffer = Buffer.from(bytes)
	if (buffer.length < 8 || buffer[0] !== 137) return []
	let offset = 8
	let width = 0
	let height = 0
	let colorType = 2
	const idat: Buffer[] = []
	while (offset + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(offset)
		const type = buffer.toString('ascii', offset + 4, offset + 8)
		const data = buffer.subarray(offset + 8, offset + 8 + length)
		if (type === 'IHDR') {
			width = data.readUInt32BE(0)
			height = data.readUInt32BE(4)
			colorType = data[9] ?? 2
		} else if (type === 'IDAT') {
			idat.push(Buffer.from(data))
		} else if (type === 'IEND') {
			break
		}
		offset += 12 + length
	}
	if (!width || !height || (colorType !== 2 && colorType !== 6)) return []
	const channels = colorType === 6 ? 4 : 3
	const inflated = inflateSync(Buffer.concat(idat))
	const samples: Rgb[] = []
	const stride = width * channels
	let src = 0
	for (let y = 0; y < height; y += 1) {
		if ((inflated[src] ?? 0) !== 0) return samples
		src += 1
		for (let x = 0; x < width; x += 1) {
			const i = src + x * channels
			const alpha = channels === 4 ? (inflated[i + 3] ?? 255) : 255
			if (alpha >= 128) {
				samples.push({
					r: inflated[i] ?? 0,
					g: inflated[i + 1] ?? 0,
					b: inflated[i + 2] ?? 0,
				})
			}
		}
		src += stride
	}
	return samples
}
