import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { Icon } from '@repo/ui/icon'
import { type RefObject, useMemo, useState } from 'react'
import {
	type ReportDefinition,
	type ReportResult,
	type ReportRunError,
} from '../dsl.ts'
import {
	type ChartExportFormat,
	buildSingleNumberSvg,
	canExportReport,
	chartExportFormats,
	composeExportSvg,
	exportKind,
	jpegToPdf,
	parseExportSize,
	reportToCsv,
	slugFilename,
} from '../export.ts'
import { formatResultHeadline } from '../format.ts'

function downloadBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement('a')
	anchor.href = url
	anchor.download = filename
	anchor.rel = 'noopener'
	document.body.appendChild(anchor)
	anchor.click()
	anchor.remove()
	URL.revokeObjectURL(url)
}

function downloadText(contents: string, filename: string, mime: string) {
	downloadBlob(new Blob([contents], { type: mime }), filename)
}

const PAINT_TAGS = new Set([
	'path',
	'rect',
	'circle',
	'ellipse',
	'polygon',
	'polyline',
	'line',
	'text',
	'tspan',
])

export function serializeChartSvg(root: HTMLElement): string {
	const svg = root.querySelector<SVGSVGElement>('svg.recharts-surface, svg')
	if (!svg) {
		throw new Error('No chart to export.')
	}

	const clone = svg.cloneNode(true) as SVGSVGElement
	const box = svg.getBoundingClientRect()
	const width = Math.max(1, Math.round(box.width))
	const height = Math.max(1, Math.round(box.height))
	clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
	clone.setAttribute('width', String(width))
	clone.setAttribute('height', String(height))
	clone.setAttribute('viewBox', `0 0 ${width} ${height}`)

	const sourceEls = [svg, ...svg.querySelectorAll('*')]
	const destEls = [clone, ...clone.querySelectorAll('*')]
	for (let index = 0; index < sourceEls.length; index += 1) {
		const source = sourceEls[index]
		const dest = destEls[index]
		if (!(source instanceof Element) || !(dest instanceof Element)) continue
		if (!PAINT_TAGS.has(source.tagName.toLowerCase())) continue
		const style = getComputedStyle(source)
		if (style.fill && style.fill !== 'none') {
			dest.setAttribute('fill', style.fill)
		}
		if (style.stroke && style.stroke !== 'none') {
			dest.setAttribute('stroke', style.stroke)
		}
		if (style.fontFamily) dest.setAttribute('font-family', style.fontFamily)
		if (style.fontSize) dest.setAttribute('font-size', style.fontSize)
		if (style.fontWeight) dest.setAttribute('font-weight', style.fontWeight)
	}

	clone
		.querySelectorAll(
			'.recharts-tooltip-cursor, .recharts-active-bar, .recharts-active-shape',
		)
		.forEach((node) => node.remove())

	const background = getComputedStyle(root).backgroundColor || '#ffffff'
	const backdrop = document.createElementNS(
		'http://www.w3.org/2000/svg',
		'rect',
	)
	backdrop.setAttribute('width', '100%')
	backdrop.setAttribute('height', '100%')
	backdrop.setAttribute('fill', background)
	clone.insertBefore(backdrop, clone.firstChild)

	return new XMLSerializer().serializeToString(clone)
}

function readThemeColors(root: HTMLElement | null) {
	const title = root?.querySelector('p')
	const value = root?.querySelector('p:last-of-type')
	return {
		background: root
			? getComputedStyle(root).backgroundColor || '#ffffff'
			: '#ffffff',
		muted: title ? getComputedStyle(title).color : '#64748b',
		foreground: value ? getComputedStyle(value).color : '#0f172a',
	}
}

function measureChartSize(root: HTMLElement | null): {
	width: number
	height: number
} {
	const box = root?.getBoundingClientRect()
	return {
		width: Math.round(box?.width || 800),
		height: Math.round(box?.height || 480),
	}
}

function chartSvg(
	definition: ReportDefinition,
	result: ReportResult,
	root: HTMLElement | null,
): string {
	if (definition.visualization.chartStyle === 'single_number') {
		const colors = readThemeColors(root)
		return buildSingleNumberSvg({
			text: formatResultHeadline(result),
			background: colors.background,
			foreground: colors.foreground,
		})
	}
	if (!root) throw new Error('No chart to export.')
	return serializeChartSvg(root)
}

async function rasterizeSvg(
	svg: string,
	width: number,
	height: number,
	type: 'image/png' | 'image/jpeg',
): Promise<Blob> {
	const image = new Image()
	const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve()
		image.onerror = () => reject(new Error('Could not render the chart image.'))
		image.src = url
	})
	const canvas = document.createElement('canvas')
	canvas.width = width
	canvas.height = height
	const context = canvas.getContext('2d')
	if (!context) throw new Error('Could not create an image canvas.')
	context.fillStyle = '#ffffff'
	context.fillRect(0, 0, width, height)
	context.drawImage(image, 0, 0, width, height)
	const blob = await new Promise<Blob | null>((resolve) => {
		canvas.toBlob(resolve, type, type === 'image/jpeg' ? 0.92 : undefined)
	})
	if (!blob) throw new Error('Could not encode the image.')
	return blob
}

function formatLabel(format: ChartExportFormat) {
	switch (format) {
		case 'png':
			return 'PNG'
		case 'svg':
			return 'SVG'
		case 'pdf':
			return 'PDF'
		case 'csv':
			return 'CSV'
	}
}

function dialogTitle(reportTitle: string, format: ChartExportFormat) {
	if (format === 'pdf') return `Export ${reportTitle} to a PDF`
	if (format === 'csv') return `Export ${reportTitle} to CSV`
	if (format === 'svg') return `Export ${reportTitle} to an SVG`
	return `Export ${reportTitle} to an image`
}

export function ReportExportMenu({
	definition,
	result,
	error,
	chartRef,
}: {
	definition: ReportDefinition
	result: ReportResult | null
	error: ReportRunError | string | null
	chartRef: RefObject<HTMLDivElement | null>
}) {
	const [open, setOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [format, setFormat] = useState<ChartExportFormat>('png')
	const [includeTitle, setIncludeTitle] = useState(true)
	const [width, setWidth] = useState('800')
	const [height, setHeight] = useState('480')
	const [exportError, setExportError] = useState<string | null>(null)
	const enabled = canExportReport(definition, result, error) && !busy
	const kind = exportKind(definition)
	const title = definition.settings.title || 'report'
	const parsedWidth = parseExportSize(width)
	const parsedHeight = parseExportSize(height)
	const showLayoutOptions = format !== 'csv'
	const canSubmit =
		enabled &&
		Boolean(result) &&
		(format === 'csv' || (parsedWidth !== null && parsedHeight !== null))

	const fileTypes = useMemo(
		() => (kind === 'csv' ? (['csv'] as const) : chartExportFormats),
		[kind],
	)

	function exportCsv() {
		if (!result) return
		downloadText(
			`\uFEFF${reportToCsv(definition, result)}`,
			slugFilename(title, 'csv'),
			'text/csv;charset=utf-8',
		)
	}

	function openDialog() {
		if (kind === 'csv') {
			exportCsv()
			return
		}
		const size = measureChartSize(chartRef.current)
		setWidth(String(size.width))
		setHeight(String(size.height))
		setFormat('png')
		setIncludeTitle(true)
		setExportError(null)
		setOpen(true)
	}

	async function handleExport() {
		if (!result) return
		if (format === 'csv') {
			exportCsv()
			setOpen(false)
			return
		}
		if (parsedWidth === null || parsedHeight === null) return
		setBusy(true)
		setExportError(null)
		try {
			const colors = readThemeColors(chartRef.current)
			const composed = composeExportSvg({
				chartSvg: chartSvg(definition, result, chartRef.current),
				width: parsedWidth,
				height: parsedHeight,
				title,
				includeTitle,
				background: colors.background,
				foreground: colors.foreground,
			})
			if (format === 'svg') {
				downloadText(
					composed,
					slugFilename(title, 'svg'),
					'image/svg+xml;charset=utf-8',
				)
			} else if (format === 'png') {
				const blob = await rasterizeSvg(
					composed,
					parsedWidth,
					parsedHeight,
					'image/png',
				)
				downloadBlob(blob, slugFilename(title, 'png'))
			} else {
				const jpeg = await rasterizeSvg(
					composed,
					parsedWidth,
					parsedHeight,
					'image/jpeg',
				)
				const bytes = new Uint8Array(await jpeg.arrayBuffer())
				const pdf = jpegToPdf(bytes, parsedWidth, parsedHeight)
				downloadBlob(
					new Blob([pdf.buffer as ArrayBuffer], {
						type: 'application/pdf',
					}),
					slugFilename(title, 'pdf'),
				)
			}
			setOpen(false)
		} catch (caught) {
			setExportError(
				caught instanceof Error
					? caught.message
					: 'Could not export this report.',
			)
		} finally {
			setBusy(false)
		}
	}

	return (
		<>
			<Button variant="outline" disabled={!enabled} onClick={openDialog}>
				<Icon name="download" data-icon="inline-start" />
				Export
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{dialogTitle(title, format)}</DialogTitle>
						<DialogDescription className="sr-only">
							Choose a file type, whether to include the report title, and the
							export size.
						</DialogDescription>
					</DialogHeader>
					<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-4">
						<Label htmlFor="export-file-type">File Type</Label>
						<Select
							value={format}
							onValueChange={(value) => {
								if (!value) return
								setFormat(value as ChartExportFormat)
							}}
						>
							<SelectTrigger id="export-file-type" className="w-36">
								<SelectValue>{formatLabel(format)}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{fileTypes.map((item) => (
									<SelectItem key={item} value={item}>
										{formatLabel(item)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>

						{showLayoutOptions ? (
							<>
								<Label htmlFor="export-include-title">Include title</Label>
								<Switch
									id="export-include-title"
									checked={includeTitle}
									onCheckedChange={(checked) =>
										setIncludeTitle(checked === true)
									}
								/>
								<Label htmlFor="export-width">Size (px)</Label>
								<div className="flex items-center gap-1.5">
									<Input
										id="export-width"
										inputMode="numeric"
										className="w-20"
										value={width}
										aria-label="Width in pixels"
										onChange={(event) => setWidth(event.target.value)}
									/>
									<span className="text-muted-foreground text-sm">×</span>
									<Input
										id="export-height"
										inputMode="numeric"
										className="w-20"
										value={height}
										aria-label="Height in pixels"
										onChange={(event) => setHeight(event.target.value)}
									/>
								</div>
							</>
						) : null}
					</div>
					{exportError ? (
						<p className="text-destructive text-sm">{exportError}</p>
					) : null}
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>
							Cancel
						</Button>
						<Button
							onClick={() => void handleExport()}
							disabled={!canSubmit || busy}
						>
							{busy ? 'Exporting…' : 'Export'}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	)
}
