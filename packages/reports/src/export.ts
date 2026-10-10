import {
	type ReportDefinition,
	type ReportResult,
	type ReportRunError,
	type ReportSegment,
	isListReport,
} from './dsl.ts'
import { segmentPercent, segmentTableColumns } from './format.ts'

export function slugFilename(title: string, extension: string): string {
	const slug = title
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.toLowerCase()
		.replace(/[-\s]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60)
	return `${slug || 'report'}.${extension}`
}

function csvCell(value: string): string {
	if (/[",\n\r]/.test(value)) {
		return `"${value.replaceAll('"', '""')}"`
	}
	return value
}

function csvLines(rows: string[][]): string {
	return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`
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
		...(info
			? [info.currency ? `${info.label} (${info.currency})` : info.label]
			: []),
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
		segment.label,
		...(columns.count ? [String(segment.count)] : []),
		...(info ? [csvAmount(segment.value, info.type === 'currency')] : []),
		...(columns.percent
			? [`${segmentPercent(segment, result).toFixed(1)}%`]
			: []),
	])
	return csvLines([header, ...body])
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
