/**
 * Zero-dependency, Cloudflare-Worker-safe XLSX reader (#73, #505, #506).
 *
 * Uses Web Standard `DecompressionStream('deflate-raw')` to read stored (method 0)
 * and deflate-compressed (method 8) ZIP entries from an `.xlsx` archive, with
 * strict entry-count and uncompressed-byte caps to prevent zip bombs.
 */

const MAX_ZIP_ENTRIES = 100
const MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024
const MAX_XLSX_ROWS = 2000
const MAX_XLSX_COLS = 40

type ZipCentralEntry = {
	name: string
	compressionMethod: number
	compressedSize: number
	uncompressedSize: number
	localHeaderOffset: number
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset]! |
			(bytes[offset + 1]! << 8) |
			(bytes[offset + 2]! << 16) |
			(bytes[offset + 3]! << 24)) >>>
		0
	)
}

function findEocdOffset(bytes: Uint8Array): number {
	const minOffset = Math.max(0, bytes.length - 65_557)
	for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
		if (
			bytes[i] === 0x50 &&
			bytes[i + 1] === 0x4b &&
			bytes[i + 2] === 0x05 &&
			bytes[i + 3] === 0x06
		) {
			return i
		}
	}
	return -1
}

function parseCentralDirectory(
	bytes: Uint8Array,
): Map<string, ZipCentralEntry> {
	const eocdOffset = findEocdOffset(bytes)
	if (eocdOffset < 0) {
		throw new Error('Invalid ZIP archive: missing EOCD')
	}
	const entryCount = readUint16LE(bytes, eocdOffset + 10)
	const centralDirSize = readUint32LE(bytes, eocdOffset + 12)
	const centralDirOffset = readUint32LE(bytes, eocdOffset + 16)

	if (entryCount > MAX_ZIP_ENTRIES) {
		throw new Error('XLSX archive contains too many entries')
	}
	if (centralDirOffset + centralDirSize > bytes.length) {
		throw new Error('Invalid ZIP archive: corrupt central directory')
	}

	const entries = new Map<string, ZipCentralEntry>()
	const decoder = new TextDecoder('utf-8')
	let offset = centralDirOffset
	let totalDeclaredUncompressed = 0

	for (let i = 0; i < entryCount; i += 1) {
		if (offset + 46 > bytes.length) {
			throw new Error('Invalid ZIP archive: truncated central directory entry')
		}
		if (readUint32LE(bytes, offset) !== 0x02014b50) {
			throw new Error('Invalid ZIP archive: bad central directory signature')
		}
		const compressionMethod = readUint16LE(bytes, offset + 10)
		const compressedSize = readUint32LE(bytes, offset + 20)
		const uncompressedSize = readUint32LE(bytes, offset + 24)
		const nameLength = readUint16LE(bytes, offset + 28)
		const extraLength = readUint16LE(bytes, offset + 30)
		const commentLength = readUint16LE(bytes, offset + 32)
		const localHeaderOffset = readUint32LE(bytes, offset + 42)

		if (offset + 46 + nameLength > bytes.length) {
			throw new Error('Invalid ZIP archive: truncated filename')
		}
		const name = decoder.decode(
			bytes.subarray(offset + 46, offset + 46 + nameLength),
		)
		totalDeclaredUncompressed += uncompressedSize
		if (
			uncompressedSize > MAX_UNCOMPRESSED_BYTES ||
			totalDeclaredUncompressed > MAX_UNCOMPRESSED_BYTES * 2
		) {
			throw new Error('XLSX archive exceeds uncompressed size limit')
		}

		entries.set(name, {
			name,
			compressionMethod,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
		})

		offset += 46 + nameLength + extraLength + commentLength
	}

	return entries
}

async function readZipEntryText(
	bytes: Uint8Array,
	entry: ZipCentralEntry,
): Promise<string> {
	const lh = entry.localHeaderOffset
	if (lh + 30 > bytes.length || readUint32LE(bytes, lh) !== 0x04034b50) {
		throw new Error('Invalid ZIP archive: bad local file header')
	}
	const nameLength = readUint16LE(bytes, lh + 26)
	const extraLength = readUint16LE(bytes, lh + 28)
	const dataStart = lh + 30 + nameLength + extraLength
	const dataEnd = dataStart + entry.compressedSize
	if (dataEnd > bytes.length) {
		throw new Error('Invalid ZIP archive: truncated entry data')
	}
	const compressed = bytes.subarray(dataStart, dataEnd)

	if (entry.compressionMethod === 0) {
		if (compressed.byteLength > MAX_UNCOMPRESSED_BYTES) {
			throw new Error('XLSX entry exceeds size limit')
		}
		return new TextDecoder('utf-8').decode(compressed)
	}

	if (entry.compressionMethod !== 8) {
		throw new Error(
			`Unsupported XLSX compression method: ${entry.compressionMethod}`,
		)
	}

	const stream = new Blob([
		new Uint8Array(compressed) as Uint8Array<ArrayBuffer>,
	])
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
			if (total > MAX_UNCOMPRESSED_BYTES) {
				await reader.cancel().catch(() => {})
				throw new Error('XLSX decompressed entry exceeds size limit')
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	const out = new Uint8Array(total)
	let pos = 0
	for (const chunk of chunks) {
		out.set(chunk, pos)
		pos += chunk.byteLength
	}
	return new TextDecoder('utf-8').decode(out)
}

function decodeXmlEntities(input: string): string {
	return input
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&#(\d+);/g, (_m, dec: string) => {
			const code = Number(dec)
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: ''
		})
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
			const code = Number.parseInt(hex, 16)
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: ''
		})
}

function parseSharedStrings(xml: string): string[] {
	const strings: string[] = []
	const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g
	const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g
	for (const siMatch of xml.matchAll(siRegex)) {
		const inner = siMatch[1] ?? ''
		let text = ''
		for (const tMatch of inner.matchAll(tRegex)) {
			text += decodeXmlEntities(tMatch[1] ?? '')
		}
		strings.push(text)
	}
	return strings
}

function colRefToIndex(ref: string): number {
	const lettersMatch = ref.match(/^([A-Za-z]+)/)
	if (!lettersMatch?.[1]) return -1
	const letters = lettersMatch[1].toUpperCase()
	let index = 0
	for (let i = 0; i < letters.length; i += 1) {
		index = index * 26 + (letters.charCodeAt(i) - 64)
	}
	return index - 1
}

function parseXmlAttr(attrs: string, name: string): string | null {
	const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`))
	return match?.[1] ?? null
}

function parseWorksheetXml(
	xml: string,
	sharedStrings: readonly string[],
): string[][] {
	const rows: string[][] = []
	const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g
	const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g

	for (const rowMatch of xml.matchAll(rowRegex)) {
		if (rows.length >= MAX_XLSX_ROWS) break
		const rowInner = rowMatch[1] ?? ''
		const cells: string[] = []
		let fallbackCol = 0

		for (const cellMatch of rowInner.matchAll(cellRegex)) {
			const attrs = cellMatch[1] ?? ''
			const body = cellMatch[2] ?? ''
			const ref = parseXmlAttr(attrs, 'r')
			const colIndex = ref ? colRefToIndex(ref) : fallbackCol
			fallbackCol = (colIndex >= 0 ? colIndex : fallbackCol) + 1
			if (colIndex < 0 || colIndex >= MAX_XLSX_COLS) continue

			const cellType = parseXmlAttr(attrs, 't') ?? ''
			let value = ''
			if (cellType === 'inlineStr') {
				const parts: string[] = []
				for (const tMatch of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
					parts.push(decodeXmlEntities(tMatch[1] ?? ''))
				}
				value = parts.join('')
			} else {
				const vMatch = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)
				const rawV = vMatch?.[1] ? decodeXmlEntities(vMatch[1]) : ''
				if (cellType === 's') {
					const idx = Number(rawV)
					value =
						Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length
							? (sharedStrings[idx] ?? '')
							: ''
				} else {
					value = rawV
				}
			}

			while (cells.length <= colIndex) cells.push('')
			cells[colIndex] = value.trim()
		}

		if (cells.some((cell) => cell !== '')) {
			rows.push(cells)
		}
	}

	return rows
}

export function isZipMagicBytes(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		(bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
		(bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
	)
}

/**
 * Parses the first worksheet of an `.xlsx` file into a 2D array of trimmed
 * strings, compatible with `parseDelimited` output.
 */
export async function parseXlsxToRows(bytes: Uint8Array): Promise<string[][]> {
	if (!isZipMagicBytes(bytes)) {
		throw new Error('File is not a valid XLSX archive')
	}
	const entries = parseCentralDirectory(bytes)
	const worksheetNames = Array.from(entries.keys())
		.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

	const sheetName = worksheetNames[0]
	if (!sheetName) {
		throw new Error('XLSX archive does not contain a worksheet')
	}

	const sharedStringsEntry = entries.get('xl/sharedStrings.xml')
	const sharedStrings = sharedStringsEntry
		? parseSharedStrings(await readZipEntryText(bytes, sharedStringsEntry))
		: []

	const sheetXml = await readZipEntryText(bytes, entries.get(sheetName)!)
	return parseWorksheetXml(sheetXml, sharedStrings)
}
