/**
 * Uncompressed ZIP (store method). Enough for a site backup of JSON and files.
 */

function crc32(data: Uint8Array) {
	let crc = ~0
	for (const byte of data) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
		}
	}
	return ~crc >>> 0
}

function dosTime(date: Date) {
	const time =
		(date.getHours() << 11) |
		(date.getMinutes() << 5) |
		(date.getSeconds() >> 1)
	const day =
		((date.getFullYear() - 1980) << 9) |
		((date.getMonth() + 1) << 5) |
		date.getDate()
	return { time, day }
}

export function zipStore(
	files: Array<{ name: string; data: Uint8Array }>,
	now = new Date(),
): Uint8Array {
	const { time, day } = dosTime(now)
	const locals: Uint8Array[] = []
	const centrals: Uint8Array[] = []
	let offset = 0
	for (const file of files) {
		const name = new TextEncoder().encode(file.name)
		const crc = crc32(file.data)
		const local = new Uint8Array(30 + name.length + file.data.length)
		const view = new DataView(local.buffer)
		view.setUint32(0, 0x04034b50, true)
		view.setUint16(4, 20, true)
		view.setUint16(8, 0, true)
		view.setUint16(10, time, true)
		view.setUint16(12, day, true)
		view.setUint32(14, crc, true)
		view.setUint32(18, file.data.length, true)
		view.setUint32(22, file.data.length, true)
		view.setUint16(26, name.length, true)
		local.set(name, 30)
		local.set(file.data, 30 + name.length)
		locals.push(local)
		const central = new Uint8Array(46 + name.length)
		const centralView = new DataView(central.buffer)
		centralView.setUint32(0, 0x02014b50, true)
		centralView.setUint16(4, 20, true)
		centralView.setUint16(6, 20, true)
		centralView.setUint16(12, time, true)
		centralView.setUint16(14, day, true)
		centralView.setUint32(16, crc, true)
		centralView.setUint32(20, file.data.length, true)
		centralView.setUint32(24, file.data.length, true)
		centralView.setUint16(28, name.length, true)
		centralView.setUint32(42, offset, true)
		central.set(name, 46)
		centrals.push(central)
		offset += local.length
	}
	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
	const end = new Uint8Array(22)
	const endView = new DataView(end.buffer)
	endView.setUint32(0, 0x06054b50, true)
	endView.setUint16(8, files.length, true)
	endView.setUint16(10, files.length, true)
	endView.setUint32(12, centralSize, true)
	endView.setUint32(16, offset, true)
	const total = offset + centralSize + end.length
	const out = new Uint8Array(total)
	let cursor = 0
	for (const part of [...locals, ...centrals, end]) {
		out.set(part, cursor)
		cursor += part.length
	}
	return out
}

export function unzipStore(bytes: Uint8Array): Map<string, Uint8Array> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const files = new Map<string, Uint8Array>()
	let offset = 0
	while (offset + 30 <= bytes.length) {
		const signature = view.getUint32(offset, true)
		if (signature !== 0x04034b50) break
		const compressed = view.getUint32(offset + 18, true)
		const nameLength = view.getUint16(offset + 26, true)
		const extra = view.getUint16(offset + 28, true)
		const name = new TextDecoder().decode(
			bytes.subarray(offset + 30, offset + 30 + nameLength),
		)
		const start = offset + 30 + nameLength + extra
		files.set(name, bytes.subarray(start, start + compressed))
		offset = start + compressed
	}
	return files
}
