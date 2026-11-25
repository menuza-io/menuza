/**
 * The public cloud printing protocols (#117): Star CloudPRNT and Epson Server
 * Direct Print. Both are polled by the printer: it asks, the server answers
 * with a job or nothing, the printer fetches or receives the data and then
 * acknowledges. This file only encodes and decodes those exchanges and turns a
 * ticket document into each protocol's print data; the node's routes own state.
 *
 * Pure: no I/O. Nothing here calls a printer maker's host. The byte-level
 * encoders are covered by golden tests and fixtures, not by a live printer.
 */
import {
	TICKET_COLUMNS,
	TICKET_DOTS,
	type TicketBitmap,
	type TicketBlock,
	type TicketDoc,
} from './print-ticket.ts'
import { type PrintDeviceStatus } from './print-devices.ts'

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
	return out
}

export const bitmapBytes = (bitmap: TicketBitmap): Uint8Array =>
	fromBase64(bitmap.data)

/**
 * A one-colour picture for thermal paper from RGBA pixels (#263): transparent
 * counts as white, anything darker than the threshold is ink, and the picture
 * is scaled down to fit `maxWidth` and never taller than `maxHeight`.
 */
export function monochromeBitmap(
	image: { width: number; height: number; data: ArrayLike<number> },
	limits: { maxWidth: number; maxHeight: number },
	threshold = 140,
): TicketBitmap | null {
	const { width, height, data } = image
	if (width < 1 || height < 1 || data.length < width * height * 4) return null
	const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
	const outWidth = Math.max(1, Math.floor(width * scale))
	const outHeight = Math.max(1, Math.floor(height * scale))
	const rowBytes = Math.ceil(outWidth / 8)
	const out = new Uint8Array(rowBytes * outHeight)
	let ink = 0
	for (let y = 0; y < outHeight; y++) {
		const sy = Math.min(height - 1, Math.floor(y / scale))
		for (let x = 0; x < outWidth; x++) {
			const sx = Math.min(width - 1, Math.floor(x / scale))
			const at = (sy * width + sx) * 4
			const alpha = (data[at + 3] ?? 255) / 255
			const gray =
				(0.299 * (data[at] ?? 0) +
					0.587 * (data[at + 1] ?? 0) +
					0.114 * (data[at + 2] ?? 0)) *
					alpha +
				255 * (1 - alpha)
			if (gray < threshold) {
				out[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7)
				ink++
			}
		}
	}
	// A picture with no ink at all would print as blank paper.
	if (ink === 0) return null
	return { width: outWidth, height: outHeight, data: toBase64(out) }
}

// ---------------------------------------------------------------------------
// Text encoding for a printer's own Latin font
// ---------------------------------------------------------------------------

/** Plain printable bytes: accents are dropped, anything else becomes `?`. */
export function encodeLatin(text: string): Uint8Array {
	const folded = text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/€/g, 'EUR')
	const out: number[] = []
	for (const char of folded) {
		const code = char.codePointAt(0) ?? 63
		out.push(code >= 32 && code < 127 ? code : 63)
	}
	return Uint8Array.from(out)
}

function wrap(text: string, columns: number): string[] {
	const words = text.split(' ')
	const lines: string[] = []
	let current = ''
	for (const word of words) {
		let rest = word
		while (rest.length > columns) {
			if (current) {
				lines.push(current)
				current = ''
			}
			lines.push(rest.slice(0, columns))
			rest = rest.slice(columns)
		}
		const candidate = current ? `${current} ${rest}` : rest
		if (candidate.length > columns) {
			lines.push(current)
			current = rest
		} else {
			current = candidate
		}
	}
	if (current) lines.push(current)
	return lines
}

/** Lines of text for a block at a paper width, padded as the block asks. */
export function layoutBlock(block: TicketBlock, columns: number): string[] {
	switch (block.t) {
		case 'rule':
			return ['-'.repeat(columns)]
		case 'row': {
			const left = block.left
			const right = block.right
			if (!right) return wrap(left, columns)
			const room = columns - right.length - 1
			if (left.length <= room) {
				return [`${left}${' '.repeat(columns - left.length - right.length)}${right}`]
			}
			const wrapped = wrap(left, Math.max(8, room))
			const last = wrapped.pop() ?? ''
			return [
				...wrapped,
				`${last}${' '.repeat(Math.max(1, columns - last.length - right.length))}${right}`,
			]
		}
		case 'text': {
			const effective = block.large ? Math.floor(columns / 2) : columns
			const inner = block.boxed ? effective - 4 : effective
			const lines = wrap(block.text, Math.max(8, inner))
			const aligned = lines.map((line) => {
				const pad =
					block.align === 'center'
						? Math.floor((inner - line.length) / 2)
						: block.align === 'right'
							? inner - line.length
							: 0
				return `${' '.repeat(Math.max(0, pad))}${line}`
			})
			if (!block.boxed) return aligned
			const edge = `+${'-'.repeat(inner + 2)}+`
			return [
				edge,
				...aligned.map((line) => `| ${line.padEnd(inner)} |`),
				edge,
			]
		}
		default:
			return []
	}
}

// ---------------------------------------------------------------------------
// Star CloudPRNT (Star Line Mode / StarPRNT core commands)
// ---------------------------------------------------------------------------

export const STAR_MEDIA_TYPE = 'application/vnd.star.starprntcore'
const ESC = 0x1b
const GS = 0x1d

class Bytes {
	private readonly parts: number[] = []
	raw(...values: number[]) {
		this.parts.push(...values)
		return this
	}
	text(value: string) {
		this.parts.push(...encodeLatin(value))
		return this
	}
	line(value: string) {
		return this.text(value).raw(0x0a)
	}
	done() {
		return Uint8Array.from(this.parts)
	}
}

const ALIGN = { left: 0, center: 1, right: 2 } as const

function starRaster(out: Bytes, bitmap: TicketBitmap) {
	const rowBytes = Math.ceil(bitmap.width / 8)
	const bytes = bitmapBytes(bitmap)
	// Enter raster mode, one `b` command per row, leave raster mode.
	out.raw(ESC, 0x2a, 0x72, 0x41)
	out.raw(ESC, 0x2a, 0x72, 0x50, 0x30, 0x00)
	for (let y = 0; y < bitmap.height; y++) {
		out.raw(0x62, rowBytes & 0xff, rowBytes >> 8)
		for (let x = 0; x < rowBytes; x++) out.raw(bytes[y * rowBytes + x] ?? 0)
	}
	out.raw(ESC, 0x2a, 0x72, 0x42)
}

function starQr(out: Bytes, data: string, size: 'fiscal' | 'small') {
	const payload = new TextEncoder().encode(data)
	const cell = size === 'fiscal' ? 6 : 3
	out.raw(ESC, GS, 0x79, 0x53, 0x30, 0x02) // model 2
	out.raw(ESC, GS, 0x79, 0x53, 0x31, 0x01) // error correction M
	out.raw(ESC, GS, 0x79, 0x53, 0x32, cell)
	out.raw(ESC, GS, 0x79, 0x44, 0x31, 0x00, payload.length & 0xff, payload.length >> 8)
	for (const byte of payload) out.raw(byte)
	out.raw(ESC, GS, 0x79, 0x50)
}

/** Star Line Mode data for one ticket document. */
export function renderStarPrnt(doc: TicketDoc): Uint8Array {
	const columns = TICKET_COLUMNS[doc.widthMm]
	const out = new Bytes().raw(ESC, 0x40) // initialize
	for (let copy = 0; copy < doc.copies; copy++) {
		for (const block of doc.blocks) {
			if (block.t === 'feed') {
				for (let i = 0; i < block.lines; i++) out.raw(0x0a)
				continue
			}
			if (block.t === 'image') {
				out.raw(ESC, GS, 0x61, ALIGN[block.align ?? 'center'])
				starRaster(out, block.bitmap)
				continue
			}
			if (block.t === 'qr') {
				out.raw(ESC, GS, 0x61, 1)
				starQr(out, block.data, block.size)
				out.raw(0x0a)
				if (block.caption) out.line(block.caption)
				continue
			}
			const align =
				block.t === 'text' && !block.boxed ? (block.align ?? 'left') : 'left'
			out.raw(ESC, GS, 0x61, ALIGN[align])
			const bold = (block.t === 'text' || block.t === 'row') && block.bold
			const large = block.t === 'text' && block.large
			const invert = block.t === 'text' && block.invert
			if (bold) out.raw(ESC, 0x45)
			if (large) out.raw(ESC, 0x69, 0x01, 0x01)
			if (invert) out.raw(ESC, 0x34)
			for (const line of layoutBlock(block, columns)) out.line(line)
			if (invert) out.raw(ESC, 0x35)
			if (large) out.raw(ESC, 0x69, 0x00, 0x00)
			if (bold) out.raw(ESC, 0x46)
		}
		if (doc.cut) out.raw(ESC, 0x64, 0x03) // feed and cut
		if (doc.drawer && copy === 0) out.raw(0x07)
	}
	return out.done()
}

// ---------------------------------------------------------------------------
// Epson ePOS-Print XML (Server Direct Print)
// ---------------------------------------------------------------------------

export const epsonEscape = (text: string) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')

/** ePOS-Print XML for one ticket document. */
export function renderEpsonXml(doc: TicketDoc): string {
	const columns = TICKET_COLUMNS[doc.widthMm]
	const parts: string[] = []
	for (let copy = 0; copy < doc.copies; copy++) {
		for (const block of doc.blocks) {
			if (block.t === 'feed') {
				parts.push(`<feed line="${Math.max(1, Math.min(10, block.lines))}"/>`)
			} else if (block.t === 'image') {
				parts.push(
					`<image width="${block.bitmap.width}" height="${block.bitmap.height}" color="color_1" mode="mono">${block.bitmap.data}</image>`,
				)
			} else if (block.t === 'qr') {
				parts.push(
					`<text align="center"/><symbol type="qrcode_model_2" level="level_m" width="${block.size === 'fiscal' ? 6 : 3}" height="0" size="0">${epsonEscape(block.data)}</symbol><feed line="1"/>`,
				)
				if (block.caption) {
					parts.push(`<text align="center">${epsonEscape(block.caption)}&#10;</text>`)
				}
			} else {
				const bold = (block.t === 'text' || block.t === 'row') && block.bold
				const large = block.t === 'text' && block.large
				const invert = block.t === 'text' && block.invert
				const align =
					block.t === 'text' && !block.boxed ? (block.align ?? 'left') : 'left'
				const attrs = [
					`align="${align}"`,
					bold ? 'em="true"' : '',
					large ? 'width="2" height="2"' : '',
					invert ? 'reverse="true"' : '',
				]
					.filter(Boolean)
					.join(' ')
				const lines = layoutBlock(block, columns).map((line) =>
					epsonEscape(line),
				)
				parts.push(`<text ${attrs}>${lines.join('&#10;')}&#10;</text>`)
				if (large) parts.push('<text width="1" height="1"/>')
			}
		}
		if (doc.cut) parts.push('<feed line="3"/><cut type="feed"/>')
		if (doc.drawer && copy === 0) {
			parts.push('<pulse drawer="drawer_1" time="pulse_100"/>')
		}
	}
	return `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">${parts.join('')}</epos-print>`
}

/** What the Epson printer expects when it asks for work. */
export function epsonPrintRequest(input: {
	jobId: string
	deviceId?: string
	timeoutMs?: number
	eposXml: string
}): string {
	return (
		`<?xml version="1.0" encoding="utf-8"?>` +
		`<PrintRequestInfo><ePOSPrint><Parameter>` +
		`<devid>${epsonEscape(input.deviceId ?? 'local_printer')}</devid>` +
		`<timeout>${input.timeoutMs ?? 10_000}</timeout>` +
		`<printjobid>${epsonEscape(input.jobId)}</printjobid>` +
		`</Parameter><PrintData>${input.eposXml}</PrintData></ePOSPrint></PrintRequestInfo>`
	)
}

// ---------------------------------------------------------------------------
// Poll and acknowledgement exchanges
// ---------------------------------------------------------------------------

export type PrinterReport = {
	status: PrintDeviceStatus
	/** The raw status text, kept short for support. Technical only. */
	detail: string | null
}

const clip = (value: unknown, max = 80): string | null =>
	typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) || null : null

/** Maps the free text of a status code to what an operator can act on. */
export function statusFromText(text: string | null | undefined): PrintDeviceStatus {
	const value = (text ?? '').toLowerCase()
	if (!value) return 'unknown'
	if (/paper|ptr_end|receipt.?end/.test(value)) return 'out_of_paper'
	if (/cover|lid/.test(value)) return 'cover_open'
	if (/^\s*(200|ok|success|true)\b/.test(value) || value === '2') return 'ok'
	if (/^\s*2\d\d\b/.test(value)) return 'ok'
	return 'error'
}

/** Star CloudPRNT poll body (JSON): the printer's own status report. */
export function parseStarPoll(body: unknown): PrinterReport {
	if (!body || typeof body !== 'object') return { status: 'unknown', detail: null }
	const record = body as Record<string, unknown>
	const text = clip(record.statusCode) ?? clip(record.status)
	return { status: statusFromText(text), detail: text }
}

/** The answer to a Star poll: a job is ready or it is not. */
export function starPollResponse(job: { id: string } | null) {
	return job
		? { jobReady: true, mediaTypes: [STAR_MEDIA_TYPE], jobToken: job.id }
		: { jobReady: false }
}

/** True when a Star acknowledgement (`code`) says the job printed. */
export function starAckOk(code: string | null | undefined): boolean {
	const value = (code ?? '').trim().toLowerCase()
	if (!value) return false
	return /^(ok|200|2\d\d)\b/.test(value)
}

export type EpsonRequest =
	| { kind: 'get'; deviceName: string | null; report: PrinterReport }
	| {
			kind: 'result'
			jobId: string | null
			success: boolean
			report: PrinterReport
	  }

/** Epson SDP bodies are form encoded: `ConnectionType=GetRequest|SetResponse`. */
export function parseEpsonForm(params: URLSearchParams): EpsonRequest | null {
	const type = params.get('ConnectionType')
	if (type === 'GetRequest') {
		return {
			kind: 'get',
			deviceName: clip(params.get('Name') ?? params.get('ID'), 60),
			report: { status: 'ok', detail: null },
		}
	}
	if (type === 'SetResponse') {
		const xml = params.get('ResponseFile') ?? ''
		const success = /success\s*=\s*"true"/i.test(xml)
		const code = /code\s*=\s*"([^"]*)"/i.exec(xml)?.[1] ?? ''
		const jobId = /<printjobid>([^<]{1,80})<\/printjobid>/i.exec(xml)?.[1] ?? null
		return {
			kind: 'result',
			jobId: jobId?.trim() ?? null,
			success,
			report: {
				status: success ? 'ok' : statusFromText(code || 'error'),
				detail: clip(code, 60),
			},
		}
	}
	return null
}
export { TICKET_DOTS }
