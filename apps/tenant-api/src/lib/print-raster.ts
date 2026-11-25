import {
	TICKET_COLUMNS,
	TICKET_DOTS,
	type TicketBitmap,
	type TicketBlock,
	type TicketDoc,
} from '@repo/common/print-ticket'
import { hasArabic, needsPicture } from '@repo/common/print-ticket'
import { layoutBlock } from '@repo/common/print-protocols'
import { type PrinterRoutes } from '@repo/common/print-devices'

/**
 * Arabic on a printer with no Arabic font (#117): the lines that need it are
 * sent as a picture, block by block, so the tax invoice code, the other codes
 * and plain Latin lines stay native and sharp. The picture maker is an adapter:
 * tests inject one and never draw anything. The default draws SVG text with
 * `sharp` where it is installed (the Node nodes, whose image carries an Arabic
 * font); on Workers there is no image library, and the ticket prints as text
 * with the lines marked, which the App shows as a warning on the printer.
 */
export type TextRasterizer = (
	block: Extract<TicketBlock, { t: 'text' | 'row' }>,
	widthMm: 58 | 80,
) => Promise<TicketBitmap | null>

let injected: TextRasterizer | null | undefined

export function setRasterizerForTest(next: TextRasterizer | null | undefined) {
	injected = next
}

function xmlEscape(text: string) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

async function sharpRasterizer(
	block: Extract<TicketBlock, { t: 'text' | 'row' }>,
	widthMm: 58 | 80,
): Promise<TicketBitmap | null> {
	let sharp: ((input: Buffer) => unknown) | undefined
	try {
		const name = 'sharp'
		sharp = ((await import(/* @vite-ignore */ name)) as { default: typeof sharp }).default
	} catch {
		return null
	}
	if (!sharp) return null
	const width = TICKET_DOTS[widthMm]
	const columns = TICKET_COLUMNS[widthMm]
	const size = block.t === 'text' && block.large ? 40 : 26
	const lineHeight = size + 8
	const lines = layoutBlock(block, columns)
	const rtl = lines.some((line) => hasArabic(line))
	const height = lines.length * lineHeight + 6
	const weight = (block.t === 'text' || block.t === 'row') && block.bold ? 700 : 400
	const text = lines
		.map((line, index) => {
			const y = (index + 1) * lineHeight - 6
			if (block.t === 'row') {
				const right = hasArabic(block.right) || !rtl
				return `<text x="${right ? width : 0}" y="${y}" text-anchor="${right ? 'end' : 'start'}">${xmlEscape(line.trim())}</text>`
			}
			const align = block.align ?? (rtl ? 'right' : 'left')
			const x = align === 'center' ? width / 2 : align === 'right' ? width : 0
			const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
			return `<text x="${x}" y="${y}" text-anchor="${anchor}">${xmlEscape(line.trim())}</text>`
		})
		.join('')
	const invert = block.t === 'text' && block.invert
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
		`<rect width="100%" height="100%" fill="${invert ? '#000' : '#fff'}"/>` +
		`<g fill="${invert ? '#fff' : '#000'}" font-family="Noto Naskh Arabic, Noto Sans Arabic, DejaVu Sans, sans-serif" font-size="${size}" font-weight="${weight}" direction="${rtl ? 'rtl' : 'ltr'}">${text}</g></svg>`
	try {
		const pipeline = (sharp(Buffer.from(svg)) as {
			greyscale(): { raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }> } }
		}).greyscale().raw()
		const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
		const rowBytes = Math.ceil(info.width / 8)
		const out = new Uint8Array(rowBytes * info.height)
		for (let y = 0; y < info.height; y++) {
			for (let x = 0; x < info.width; x++) {
				if (data[y * info.width + x]! < 128) out[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7)
			}
		}
		let binary = ''
		for (const byte of out) binary += String.fromCharCode(byte)
		return { width: info.width, height: info.height, data: btoa(binary) }
	} catch {
		return null
	}
}

export type RasterResult = { doc: TicketDoc; rasterized: number; failed: number }

/** The document for a printer: Arabic lines become pictures when the printer has no Arabic font. */
export async function prepareForPrinter(
	doc: TicketDoc,
	printer: Pick<PrinterRoutes, 'arabicFont'>,
	widthMm: 58 | 80,
): Promise<RasterResult> {
	if (!needsPicture(doc, printer)) return { doc, rasterized: 0, failed: 0 }
	const draw = injected === undefined ? sharpRasterizer : injected
	let rasterized = 0
	let failed = 0
	const blocks: TicketBlock[] = []
	for (const block of doc.blocks) {
		const needs =
			(block.t === 'text' && hasArabic(block.text)) ||
			(block.t === 'row' && (hasArabic(block.left) || hasArabic(block.right)))
		if (!needs || !draw) {
			if (needs) failed++
			blocks.push(block)
			continue
		}
		const bitmap = await draw(block, widthMm)
		if (bitmap) {
			rasterized++
			blocks.push({ t: 'image', bitmap, align: 'left' })
		} else {
			failed++
			blocks.push(block)
		}
	}
	return { doc: { ...doc, blocks }, rasterized, failed }
}
