import { neutralizeCsvCell } from '@repo/staffing'
import {
	type ReportDefinition,
	type ReportResult,
	type ReportRunError,
	type ReportSegment,
	type ReportValueInfo,
	isListReport,
} from './dsl.ts'
import { segmentPercent, segmentTableColumns } from './format.ts'

/** File basename for an export: title plus basis when the run names one. */
export function reportExportBasename(
	definition: ReportDefinition,
	result: ReportResult | null,
): string {
	const parts = [definition.settings.title.trim() || 'report']
	if (result?.timeBasis === 'fulfillment') parts.push('fulfillment-time')
	if (result?.salesBasis === 'gross') parts.push('gross-sales')
	if (result?.salesBasis === 'net') parts.push('net-sales')
	return parts.join(' — ')
}

export function slugFilename(title: string, extension: string): string {
	const slug = title
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.toLowerCase()
		.replace(/[-\s]+/g, '-')
	// Runs are collapsed above, so at most one hyphen sits at either end. Strip
	// it by hand: an unanchored `/-+$/` backtracks quadratically.
	const start = slug.startsWith('-') ? 1 : 0
	const end = slug.endsWith('-') ? slug.length - 1 : slug.length
	const trimmed = slug.slice(start, Math.max(start, end)).slice(0, 60)
	return `${trimmed || 'report'}.${extension}`
}

/** A plain (possibly negative) number or percentage stays numeric. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?%?$/

export function csvCell(raw: string): string {
	// Cells hold lower-trust text (customer names, emails): one starting with
	// `=`, `+`, `-`, `@`, tab or CR would run as a formula in a spreadsheet.
	const value = PLAIN_NUMBER.test(raw) ? raw : neutralizeCsvCell(raw)
	if (/[",\n\r]/.test(value)) {
		return `"${value.replaceAll('"', '""')}"`
	}
	return value
}

export function csvLines(rows: string[][]): string {
	return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Chunked exports (#386)
// ---------------------------------------------------------------------------

/**
 * Large exports are read page by page from the region, so the browser can
 * show a percentage, an estimated time left and a Cancel button. One writer
 * serves every guest-level or row-level CSV export (order history, customer
 * list); each of them only supplies `fetchChunk`.
 */

/** Rows one export request carries. */
export const EXPORT_CHUNK_ROWS = 2_000

/** The most rows one export ever holds; past it the file is cut and says so. */
export const EXPORT_MAX_ROWS = 50_000

/** One page of an export, as the region answers it. */
export type ExportChunk = {
	/**
	 * The file's header row. The first page decides it (it can depend on the
	 * caller's grants or on the currencies in the data); later pages repeat it.
	 */
	header?: string[]
	rows: string[][]
	/** Opaque cursor of the next page; null on the last one. */
	nextCursor: string | null
	/** Rows this export will hold (after the cap). */
	total: number
	/** Rows the filters matched before the cap. */
	matching: number
	/** The cap cut the result. */
	truncated: boolean
	/** Rows appended once, after the last page (totals, the cut-off note). */
	footer?: string[][] | null
}

export type ExportProgress = {
	rowsDone: number
	rowsTotal: number
	/** 0 to 100, whole numbers; 100 only once the file is complete. */
	percent: number
	elapsedMs: number
	/** Estimated time left; null until the first page has come back. */
	etaMs: number | null
}

export function exportProgress(input: {
	rowsDone: number
	rowsTotal: number
	startedAt: number
	now: number
	complete?: boolean
}): ExportProgress {
	const rowsTotal = Math.max(0, input.rowsTotal)
	const rowsDone = Math.min(Math.max(0, input.rowsDone), rowsTotal)
	const elapsedMs = Math.max(0, input.now - input.startedAt)
	const ratio = rowsTotal === 0 ? 1 : rowsDone / rowsTotal
	const percent = input.complete ? 100 : Math.min(99, Math.floor(ratio * 100))
	const etaMs =
		input.complete || ratio >= 1
			? 0
			: rowsDone > 0
				? Math.round((elapsedMs / rowsDone) * (rowsTotal - rowsDone))
				: null
	return { rowsDone, rowsTotal, percent, elapsedMs, etaMs }
}

/** "about 12 seconds", "under a minute": the words the progress line uses. */
export function formatEta(etaMs: number | null): {
	unit: 'unknown' | 'seconds' | 'minutes'
	value: number
} {
	if (etaMs === null) return { unit: 'unknown', value: 0 }
	const seconds = Math.max(1, Math.ceil(etaMs / 1000))
	return seconds < 60
		? { unit: 'seconds', value: seconds }
		: { unit: 'minutes', value: Math.ceil(seconds / 60) }
}

export type ChunkedExportResult =
	| {
			status: 'done'
			/** The finished file, built only after the last page arrived. */
			blob: Blob
			rowCount: number
			matching: number
			truncated: boolean
	  }
	| { status: 'cancelled' }

function isAbort(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === 'AbortError'
	)
}

/** Lets the browser paint between pages, so a big export never blocks the page. */
const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r, 0))

/**
 * Reads an export page by page and builds the CSV in memory. Cancelling (the
 * `signal`) stops before the next request, aborts the one in flight, throws
 * away every page read so far and returns `cancelled`: the file is only ever
 * built after the last page, so no partial file exists. Any other error is
 * rethrown the same way, with nothing kept.
 */
export async function runChunkedCsvExport(options: {
	/** Used when the first page names no header of its own. */
	header?: string[]
	fetchChunk: (
		cursor: string | null,
		signal: AbortSignal,
	) => Promise<ExportChunk>
	signal?: AbortSignal
	onProgress?: (progress: ExportProgress) => void
	/** The first page: how many rows match and whether the cap cuts them. */
	onStart?: (info: { total: number; matching: number; truncated: boolean }) => void
	now?: () => number
	yieldTurn?: () => Promise<void>
}): Promise<ChunkedExportResult> {
	const now = options.now ?? Date.now
	const yieldTurn = options.yieldTurn ?? yieldToEventLoop
	const controller = new AbortController()
	const onOuterAbort = () => controller.abort()
	if (options.signal?.aborted) return { status: 'cancelled' }
	options.signal?.addEventListener('abort', onOuterAbort, { once: true })

	let parts: string[] | null = []
	const startedAt = now()
	let rowCount = 0
	let total = 0
	let matching = 0
	let truncated = false
	let cursor: string | null = null
	let first = true
	try {
		for (;;) {
			if (controller.signal.aborted) return { status: 'cancelled' }
			const chunk: ExportChunk = await options.fetchChunk(
				cursor,
				controller.signal,
			)
			if (controller.signal.aborted) return { status: 'cancelled' }
			if (first) {
				first = false
				total = chunk.total
				matching = chunk.matching
				truncated = chunk.truncated
				options.onStart?.({ total, matching, truncated })
				const header = chunk.header ?? options.header
				if (header) parts.push(csvLines([header]))
			}
			if (chunk.rows.length > 0) parts.push(csvLines(chunk.rows))
			rowCount += chunk.rows.length
			cursor = chunk.nextCursor
			const done = cursor === null
			if (done && chunk.footer && chunk.footer.length > 0) {
				parts.push(csvLines(chunk.footer))
			}
			options.onProgress?.(
				exportProgress({
					rowsDone: rowCount,
					rowsTotal: Math.max(total, rowCount),
					startedAt,
					now: now(),
					complete: done,
				}),
			)
			if (done) break
			await yieldTurn()
		}
		const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' })
		return { status: 'done', blob, rowCount, matching, truncated }
	} catch (error) {
		if (controller.signal.aborted || isAbort(error)) {
			return { status: 'cancelled' }
		}
		throw error
	} finally {
		parts = null
		options.signal?.removeEventListener('abort', onOuterAbort)
	}
}

export function reportToCsv(
	definition: ReportDefinition,
	result: ReportResult,
): string {
	if (isListReport(definition) && result.columns && result.rows) {
		return csvLines([
			result.columns.map((column) => column.label),
			...result.rows.map((row) =>
				result.columns!.map((column) => row[column.id] ?? ''),
			),
		])
	}

	const columns = segmentTableColumns(
		definition.visualization.hideCounts,
		result,
	)
	const info = columns.value
	const header = [
		'Segment',
		...(columns.count ? ['Count'] : []),
		...(info ? [valueHeader(info)] : []),
		...(columns.previous && info ? [`Previous ${info.label}`] : []),
		...(columns.change ? ['Change'] : []),
		...(columns.percent ? ['Percent'] : []),
	]
	const segments: ReportSegment[] =
		result.segments.length > 0
			? result.segments
			: [
					{
						key: 'total',
						label: definition.settings.title || 'Total',
						count: result.total,
						percent: 100,
						value: result.value,
					},
				]
	const body = segments.map((segment) => [
		segment.partial ? `${segment.label} (partial)` : segment.label,
		...(columns.count ? [String(segment.count)] : []),
		...(info ? [csvValue(segment.value, info)] : []),
		...(columns.previous && info
			? [csvValue(segment.previousValue, info)]
			: []),
		...(columns.change ? [segment.changeLabel ?? ''] : []),
		...(columns.percent
			? [`${segmentPercent(segment, result).toFixed(1)}%`]
			: []),
	])
	return csvLines([header, ...body])
}

/** The value column's header, naming the unit its plain digits are in. */
function valueHeader(info: ReportValueInfo) {
	if (info.type === 'duration') return `${info.label} (hours)`
	if (info.type === 'percent') return `${info.label} (%)`
	if (info.currency) {
		return info.perHour
			? `${info.label} (${info.currency} per hour)`
			: `${info.label} (${info.currency})`
	}
	return info.label
}

function csvValue(value: number | undefined, info: ReportValueInfo) {
	if (value === undefined) return ''
	// Durations are minutes in a result and hours in a spreadsheet.
	if (info.type === 'duration') return (value / 60).toFixed(2)
	if (info.type === 'percent') return value.toFixed(2)
	return csvAmount(value, info.type === 'currency')
}

/**
 * Plain digits a spreadsheet reads as a number. The currency code goes in
 * the column header instead of each cell.
 */
function csvAmount(value: number | undefined, currency: boolean) {
	if (value === undefined) return ''
	return currency ? value.toFixed(2) : String(Math.round(value * 100) / 100)
}

export function canExportReport(
	definition: ReportDefinition,
	result: ReportResult | null,
	error: ReportRunError | string | null,
): boolean {
	if (error || !result) return false
	if (definition.visualization.chartStyle === 'single_number') return true
	if (isListReport(definition)) return (result.rows?.length ?? 0) > 0
	return result.segments.length > 0
}

export function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
}

export const TITLE_BAR_HEIGHT = 56
export const EXPORT_MIN_SIZE = 200
export const EXPORT_MAX_SIZE = 4096

export const chartExportFormats = ['png', 'svg', 'pdf', 'csv'] as const
export type ChartExportFormat = (typeof chartExportFormats)[number]

export function clampExportSize(value: number): number {
	if (!Number.isFinite(value)) return EXPORT_MIN_SIZE
	return Math.min(EXPORT_MAX_SIZE, Math.max(EXPORT_MIN_SIZE, Math.round(value)))
}

export function parseExportSize(value: string): number | null {
	const parsed = Number.parseInt(value, 10)
	if (!Number.isFinite(parsed) || parsed <= 0) return null
	return clampExportSize(parsed)
}

export function composeExportSvg(options: {
	chartSvg: string
	width: number
	height: number
	title: string
	includeTitle: boolean
	background: string
	foreground: string
}): string {
	const width = clampExportSize(options.width)
	const height = clampExportSize(options.height)
	const titleBar = options.includeTitle ? TITLE_BAR_HEIGHT : 0
	const chartHeight = Math.max(1, height - titleBar)
	const inner = options.chartSvg
		.replace(/^\s*<\?xml[^>]*>/u, '')
		.replace(/^\s*<!DOCTYPE[^>]*>/u, '')
		.trim()
	const scaled = inner.replace(/<svg\b([^>]*)>/u, (_match, attrs: string) => {
		const cleaned = String(attrs)
			.replace(/\swidth="[^"]*"/gu, '')
			.replace(/\sheight="[^"]*"/gu, '')
		return `<svg${cleaned} width="${width}" height="${chartHeight}">`
	})
	const titleMarkup = options.includeTitle
		? `<text x="24" y="36" font-family="ui-sans-serif, system-ui, sans-serif" font-size="16" font-weight="600" fill="${escapeXml(options.foreground)}">${escapeXml(options.title)}</text>`
		: ''
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${escapeXml(options.background)}"/>
  ${titleMarkup}
  <g transform="translate(0 ${titleBar})">${scaled}</g>
</svg>
`
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
	const output = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.byteLength
	}
	return output
}

export function jpegToPdf(
	jpeg: Uint8Array,
	width: number,
	height: number,
): Uint8Array {
	const pageWidth = Math.max(1, Math.round(width))
	const pageHeight = Math.max(1, Math.round(height))
	const encoder = new TextEncoder()
	const chunks: Uint8Array[] = []
	const offsets = [0, 0, 0, 0, 0, 0]
	let cursor = 0

	function add(data: string | Uint8Array, objectIndex?: number) {
		const bytes = typeof data === 'string' ? encoder.encode(data) : data
		if (objectIndex) offsets[objectIndex] = cursor
		chunks.push(bytes)
		cursor += bytes.byteLength
	}

	const content = encoder.encode(
		`q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`,
	)

	add('%PDF-1.4\n')
	add('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n', 1)
	add('2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n', 2)
	add(
		`3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >> endobj\n`,
		3,
	)
	add(
		`4 0 obj << /Type /XObject /Subtype /Image /Width ${pageWidth} /Height ${pageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`,
		4,
	)
	add(jpeg)
	add('\nendstream\nendobj\n')
	add(`5 0 obj << /Length ${content.byteLength} >>\nstream\n`, 5)
	add(content)
	add('endstream\nendobj\n')

	const xrefStart = cursor
	const pad = (value: number) => value.toString().padStart(10, '0')
	let xref = 'xref\n0 6\n0000000000 65535 f \n'
	for (let index = 1; index <= 5; index += 1) {
		xref += `${pad(offsets[index] ?? 0)} 00000 n \n`
	}
	xref += `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
	add(xref)
	return concatBytes(chunks)
}

export function buildSingleNumberSvg(options: {
	/** The formatted headline, for example "1,204" or "$8,312.50". */
	text: string
	background: string
	foreground: string
}): string {
	const width = 960
	const height = 540
	// Long amounts shrink so they stay inside the canvas.
	const fontSize = Math.min(
		88,
		Math.floor((width - 96) / (0.6 * options.text.length)),
	)
	return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="${escapeXml(options.background)}"/>
  <text x="${width / 2}" y="${height / 2 + Math.round(fontSize / 3)}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="${fontSize}" font-weight="600" fill="${escapeXml(options.foreground)}">${escapeXml(options.text)}</text>
</svg>
`
}

export function exportKind(definition: ReportDefinition): 'csv' | 'image' {
	return definition.visualization.chartStyle === 'table' ? 'csv' : 'image'
}
