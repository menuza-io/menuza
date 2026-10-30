/**
 * Reads a PDF's first page size without a PDF library. It walks the real
 * page tree (trailer `/Root`, the catalog's `/Pages`, the first `/Kids`
 * entry down to a `/Type /Page`), with `/MediaBox` and `/Rotate` inherited
 * from parent nodes as the PDF spec allows, and returns the boxes in
 * millimetres as the page is shown (rotated by 90 or 270 degrees, width and
 * height swap).
 *
 * Objects packed in compressed object streams (`/Type /ObjStm`, PDF 1.5+)
 * are read too: Flate streams are inflated with a size cap. It fails closed:
 * a malformed tree, another filter, or a missing box returns null, and the
 * caller refuses the file. Every scan is linear (object offsets are indexed
 * once, and each dictionary read is capped), so a large or hostile file
 * cannot make it backtrack.
 */

import { inflateSync } from 'node:zlib'

const POINTS_PER_MM = 72 / 25.4
/** A page dictionary is small; streams after it are never read. */
const MAX_DICT_CHARS = 64 * 1024
const MAX_TREE_DEPTH = 32
/** Inflated bytes per object stream, and in all. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024
const MAX_PACKED_BYTES = 32 * 1024 * 1024
const MAX_PACKED_OBJECTS = 100_000

type Box = { widthMm: number; heightMm: number }

type ObjectIndex = Map<number, number>

type Pdf = {
	text: string
	index: ObjectIndex
	/** Objects from compressed object streams, read on the first miss. */
	packed: Map<number, string> | null
}

function indexObjects(text: string): ObjectIndex {
	const index: ObjectIndex = new Map()
	const header = /(\d+)\s+\d+\s+obj\b/g
	for (let match = header.exec(text); match; match = header.exec(text)) {
		// A later definition (an incremental update) wins.
		index.set(Number(match[1]), match.index + match[0].length)
	}
	return index
}

/** A plain object's dictionary (or value), up to its stream or `endobj`. */
function plainBody(text: string, start: number) {
	const window = text.slice(start, start + MAX_DICT_CHARS)
	const ends = [window.indexOf('endobj'), window.indexOf('stream')].filter(
		(at) => at !== -1,
	)
	return ends.length ? window.slice(0, Math.min(...ends)) : null
}

function objectBody(pdf: Pdf, id: number) {
	const start = pdf.index.get(id)
	if (start !== undefined) return plainBody(pdf.text, start)
	pdf.packed ??= readObjectStreams(pdf)
	return pdf.packed.get(id)?.slice(0, MAX_DICT_CHARS) ?? null
}

/** Unpacks every Flate-compressed object stream, within the size caps. */
function readObjectStreams(pdf: Pdf): Map<number, string> {
	const packed = new Map<number, string>()
	let budget = MAX_PACKED_BYTES
	for (const start of pdf.index.values()) {
		const dict = plainBody(pdf.text, start)
		if (!dict || dictValue(dict, 'Type') !== '/ObjStm') continue
		const filter = dictValue(dict, 'Filter')
		if (filter !== '/FlateDecode' && filter !== '[/FlateDecode]') continue
		if (dictValue(dict, 'DecodeParms')) continue
		const count = Number(dictValue(dict, 'N'))
		const first = Number(dictValue(dict, 'First'))
		if (!Number.isInteger(count) || !Number.isInteger(first)) continue
		if (count <= 0 || first < 0) continue
		const keyword = pdf.text.indexOf('stream', start + dict.length)
		if (keyword === -1) continue
		let from = keyword + 'stream'.length
		if (pdf.text[from] === '\r') from += 1
		if (pdf.text[from] === '\n') from += 1
		const length = Number(dictValue(dict, 'Length'))
		const to = Number.isInteger(length)
			? from + length
			: pdf.text.indexOf('endstream', from)
		if (to <= from || to > pdf.text.length) continue
		let decoded: string
		try {
			const bytes = inflateSync(
				Buffer.from(pdf.text.slice(from, to), 'latin1'),
				{ maxOutputLength: Math.min(MAX_STREAM_BYTES, budget) },
			)
			budget -= bytes.length
			decoded = bytes.toString('latin1')
		} catch {
			continue
		}
		const header = decoded.slice(0, first).trim().split(/\s+/).map(Number)
		const entries: Array<[number, number]> = []
		for (
			let at = 0;
			at + 1 < header.length && entries.length < count;
			at += 2
		) {
			entries.push([header[at]!, header[at + 1]!])
		}
		entries.forEach(([id, offset], position) => {
			if (packed.size >= MAX_PACKED_OBJECTS || pdf.index.has(id)) return
			const next = entries[position + 1]?.[1] ?? decoded.length - first
			if (!Number.isInteger(offset) || next < offset) return
			packed.set(id, decoded.slice(first + offset, first + next))
		})
		if (budget <= 0) break
	}
	return packed
}

const NAME = /^[^\s/<>[\]()]+/
const VALUE = /^\s*(\d+\s+\d+\s+R|\[[^\]]*\]|\/[^\s/<>[\]()]+|-?[\d.]+)/

/**
 * The value of `/Key` in a dictionary at its own level (nested dictionaries
 * skipped), as raw text: a number, a name, an array or an `N G R` reference.
 * Keys and values alternate, so a name used as a value is never taken for a
 * key.
 */
function dictValue(dict: string, key: string): string | null {
	let depth = 0
	for (let at = 0; at < dict.length; at += 1) {
		if (dict.startsWith('<<', at)) {
			depth += 1
			at += 1
			continue
		}
		if (dict.startsWith('>>', at)) {
			depth -= 1
			at += 1
			continue
		}
		if (depth !== 1 || dict[at] !== '/') continue
		const name = dict.slice(at + 1, at + 200).match(NAME)?.[0]
		if (!name) continue
		const after = at + 1 + name.length
		const value = dict.slice(after, after + 4096).match(VALUE)
		if (name === key) return value ? value[1]!.trim() : null
		// Skip a simple value; a nested dictionary is skipped by depth.
		if (value) at = after + value[0].length - 1
		else at = after - 1
	}
	return null
}

function refId(value: string | null): number | null {
	const match = value?.match(/^(\d+)\s+\d+\s+R$/)
	return match ? Number(match[1]) : null
}

/** A value, following one indirect reference. */
function resolve(pdf: Pdf, value: string | null) {
	const id = refId(value)
	if (id === null) return value
	return objectBody(pdf, id)?.trim() ?? null
}

function toBox(value: string | null): Box | null {
	const numbers = value
		?.match(/^\[\s*([^\]]*)\]$/)?.[1]
		?.trim()
		.split(/\s+/)
	if (!numbers || numbers.length !== 4) return null
	const [x0, y0, x1, y1] = numbers.map(Number) as [
		number,
		number,
		number,
		number,
	]
	const width = Math.abs(x1 - x0) / POINTS_PER_MM
	const height = Math.abs(y1 - y0) / POINTS_PER_MM
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null
	if (!width || !height) return null
	return { widthMm: width, heightMm: height }
}

function rootId(text: string): number | null {
	// Classic trailers and cross-reference streams both carry `/Root N G R`
	// in a plain dictionary; the last one describes the current file.
	let last: number | null = null
	for (const match of text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)) {
		last = Number(match[1])
	}
	return last
}

export function readPdfPageSize(bytes: Uint8Array): {
	media: Box
	trim: Box | null
	rotate: number
} | null {
	if (
		bytes.length < 5 ||
		new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-'
	) {
		return null
	}
	// One character per byte, so offsets stay meaningful and stream bytes
	// survive the round trip (TextDecoder's 'latin1' is windows-1252, which
	// would remap 0x80-0x9F).
	const text = Buffer.from(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).toString('latin1')
	const pdf: Pdf = { text, index: indexObjects(text), packed: null }
	const root = rootId(text)
	const catalog = root === null ? null : objectBody(pdf, root)
	let nodeId = catalog ? refId(dictValue(catalog, 'Pages')) : null

	let mediaValue: string | null = null
	let rotateValue: string | null = null
	const visited = new Set<number>()
	for (let depth = 0; nodeId !== null && depth < MAX_TREE_DEPTH; depth += 1) {
		if (visited.has(nodeId)) return null
		visited.add(nodeId)
		const node = objectBody(pdf, nodeId)
		if (!node) return null
		// Inheritable: the nearest node that sets them wins.
		mediaValue = resolve(pdf, dictValue(node, 'MediaBox')) ?? mediaValue
		rotateValue = resolve(pdf, dictValue(node, 'Rotate')) ?? rotateValue
		const type = dictValue(node, 'Type')
		if (type === '/Page') {
			const media = toBox(mediaValue)
			if (!media) return null
			const rotate = ((Number(rotateValue ?? 0) % 360) + 360) % 360
			const turned = rotate === 90 || rotate === 270
			const shown = (box: Box): Box =>
				turned ? { widthMm: box.heightMm, heightMm: box.widthMm } : box
			const trim = toBox(resolve(pdf, dictValue(node, 'TrimBox')))
			return { media: shown(media), trim: trim ? shown(trim) : null, rotate }
		}
		if (type !== '/Pages') return null
		const kids = resolve(pdf, dictValue(node, 'Kids'))
		nodeId = refId(kids?.match(/^\[\s*(\d+\s+\d+\s+R)/)?.[1] ?? null)
	}
	return null
}
