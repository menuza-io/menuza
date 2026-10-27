import {
	getPrintSize,
	PRINT_HOME_SHEET_SIZES,
	PRINT_PRODUCTS,
	PRINT_SAFE_MM,
	type PrintHomeSheet,
	type PrintSnapshot,
} from '@repo/common/print-shop'
import { renderToStaticMarkup } from 'react-dom/server'
import { PrintArtwork } from '#app/components/print/print-artwork.tsx'

/**
 * Builds the standalone HTML document a print is rendered from: the on-screen
 * proof, the home sheet (several pieces per Letter/A4 page with crop marks,
 * no bleed) and the professional file (one piece per page, trim plus bleed).
 * The same markup feeds the browser renderer, so what the operator approves is
 * what prints.
 */

export type PrintDocumentFormat = 'proof' | 'home' | 'pro'

export type PrintDocumentInput = {
	snapshot: PrintSnapshot
	format: PrintDocumentFormat
	/** Inline QR SVG per piece, same order as `snapshot.pieces`. */
	qrSvgs: Array<string | null>
	homeSheet?: PrintHomeSheet
	bleedMm?: number
	/** Proof only: how many pieces to show (a table set can be long). */
	proofLimit?: number
	/** Fallback renderer: open the browser print dialog once fonts load. */
	autoPrint?: boolean
	/** CSP nonce of the auto-print script. */
	nonce?: string
}

const HOME_MARGIN_MM = 10
const HOME_GAP_MM = 8
const CROP_MARK_MM = 4
const CROP_OFFSET_MM = 1.5
const PROOF_WIDTH_PX = 380
const MM_TO_PX = 96 / 25.4

const SCRIPT_FONTS = ['Noto Sans Arabic', 'Noto Sans SC']

function familyName(stack: string): string {
	const first = stack.split(',')[0] ?? ''
	return first.replace(/["']/g, '').trim()
}

function googleFontsHref(families: string[]): string {
	const unique = [...new Set(families.filter(Boolean))]
	const params = unique
		.map(
			(family) =>
				`family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;600;800`,
		)
		.join('&')
	return `https://fonts.googleapis.com/css2?${params}&display=block`
}

function cssString(value: string): string {
	return `'${value.replace(/[\\']/g, '\\$&').replace(/[\n\r<>]/g, '')}'`
}

/** Hex colors only reach the stylesheet (resolved from the org theme). */
function cssColor(value: string, fallback: string): string {
	return /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback
}

function mm(value: number) {
	return `${Math.round(value * 100) / 100}mm`
}

type Box = { widthMm: number; heightMm: number }

/** The flat piece: a folded tent is two panels, the top one upside down. */
function pieceBox(snapshot: PrintSnapshot): Box & { panelHeightMm: number } {
	const size = getPrintSize(snapshot.product, snapshot.sizeKey)
	if (!size) throw new Error('Unknown print size')
	const folded = PRINT_PRODUCTS[snapshot.product].folded === true
	return {
		widthMm: size.widthMm,
		heightMm: folded ? size.heightMm * 2 : size.heightMm,
		panelHeightMm: size.heightMm,
	}
}

function pieceMarkup(
	snapshot: PrintSnapshot,
	index: number,
	qrSvg: string | null,
): string {
	const piece = snapshot.pieces[index]!
	const artwork = renderToStaticMarkup(
		<PrintArtwork snapshot={snapshot} piece={piece} qrSvg={qrSvg} />,
	)
	if (!PRINT_PRODUCTS[snapshot.product].folded) return artwork
	return `<div class="tent"><div class="tent-panel tent-back">${artwork}</div><div class="tent-panel">${artwork}</div><div class="fold-line"></div></div>`
}

function cropMarks(x: number, y: number, box: Box): string {
	const marks: string[] = []
	const corners: Array<[number, number, 1 | -1, 1 | -1]> = [
		[x, y, -1, -1],
		[x + box.widthMm, y, 1, -1],
		[x, y + box.heightMm, -1, 1],
		[x + box.widthMm, y + box.heightMm, 1, 1],
	]
	for (const [cx, cy, dx, dy] of corners) {
		const hx = dx < 0 ? cx - CROP_OFFSET_MM - CROP_MARK_MM : cx + CROP_OFFSET_MM
		marks.push(
			`<div class="crop crop-h" style="left:${mm(hx)};top:${mm(cy)};width:${mm(CROP_MARK_MM)}"></div>`,
		)
		const vy = dy < 0 ? cy - CROP_OFFSET_MM - CROP_MARK_MM : cy + CROP_OFFSET_MM
		marks.push(
			`<div class="crop crop-v" style="left:${mm(cx)};top:${mm(vy)};height:${mm(CROP_MARK_MM)}"></div>`,
		)
	}
	return marks.join('')
}

function documentCss(input: {
	snapshot: PrintSnapshot
	page: Box
	piece: Box & { panelHeightMm: number }
	bleedMm: number
	format: PrintDocumentFormat
}) {
	const { snapshot, page, piece, bleedMm, format } = input
	const brand = snapshot.brand
	const size = getPrintSize(snapshot.product, snapshot.sizeKey)!
	const shortEdge = Math.min(size.widthMm, size.heightMm)
	const heading = `${cssString(familyName(brand.headingFont) || 'Inter')}, ${SCRIPT_FONTS.map(cssString).join(', ')}, sans-serif`
	const body = `${cssString(familyName(brand.bodyFont) || 'Inter')}, ${SCRIPT_FONTS.map(cssString).join(', ')}, sans-serif`
	const proofZoom =
		format === 'proof'
			? Math.min(1, PROOF_WIDTH_PX / ((piece.widthMm + 2 * bleedMm) * MM_TO_PX))
			: 1
	return `
@page { size: ${mm(page.widthMm)} ${mm(page.heightMm)}; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: ${format === 'proof' ? '#e9e9ec' : '#ffffff'}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
:root {
	--bg: ${cssColor(brand.background, '#ffffff')};
	--fg: ${cssColor(brand.foreground, '#18181b')};
	--muted: ${cssColor(brand.muted, '#71717a')};
	--primary: ${cssColor(brand.primary, '#2563eb')};
	--primary-fg: ${cssColor(brand.primaryForeground, '#ffffff')};
	--accent: ${cssColor(brand.accent, '#f4f4f5')};
	--accent-fg: ${cssColor(brand.accentForeground, '#18181b')};
	--heading: ${heading};
	--body: ${body};
	--u: ${mm(shortEdge / 100)};
	--bleed: ${mm(bleedMm)};
	--safe: ${mm(PRINT_SAFE_MM)};
}
.sheet { position: relative; width: ${mm(page.widthMm)}; height: ${mm(page.heightMm)}; overflow: hidden; break-after: page; page-break-after: always; background: #ffffff; }
.sheet:last-child { break-after: auto; page-break-after: auto; }
${
	format === 'proof'
		? `.proof { display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 24px 0; }
.proof .sheet { zoom: ${proofZoom}; box-shadow: 0 1px 4px rgba(0,0,0,.18); }
.proof .trim { position: absolute; inset: var(--bleed); outline: 1px dashed rgba(220, 38, 38, .7); pointer-events: none; z-index: 2; }
.proof .bleed-note { position: absolute; inset: 0; border: var(--bleed) solid rgba(220, 38, 38, .12); pointer-events: none; z-index: 2; }`
		: ''
}
.slot { position: absolute; }
.crop { position: absolute; background: #000000; }
.crop-h { height: 0.15mm; }
.crop-v { width: 0.15mm; }
.fit { position: absolute; top: 0; left: 0; transform-origin: top left; }
.tent { position: relative; width: 100%; height: 100%; }
.tent-panel { position: absolute; left: 0; width: 100%; height: 50%; overflow: hidden; }
.tent-panel:nth-child(2) { top: 50%; }
.tent-back { top: 0; transform: rotate(180deg); }
.fold-line { position: absolute; left: 0; right: 0; top: 50%; border-top: 0.2mm dashed rgba(0,0,0,.35); }

.piece { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: var(--body); color: var(--fg); line-height: 1.2; }
.piece .bg { position: absolute; inset: 0; background: var(--bg); }
.piece .safe { position: absolute; inset: calc(var(--bleed) + var(--safe)); display: flex; flex-direction: column; align-items: center; justify-content: space-between; text-align: center; gap: calc(var(--u) * 3); }
.brand { display: flex; align-items: center; justify-content: center; gap: calc(var(--u) * 2); max-width: 100%; }
.logo { max-height: calc(var(--u) * 12); max-width: calc(var(--u) * 40); object-fit: contain; }
.brand-name { font-family: var(--heading); font-weight: 600; font-size: calc(var(--u) * 4.2); letter-spacing: .01em; overflow-wrap: anywhere; }
.logo + .brand-name { display: none; }
.message { display: flex; flex-direction: column; gap: calc(var(--u) * 2); }
.headline { margin: 0; font-family: var(--heading); font-weight: 800; font-size: calc(var(--u) * 7.5); line-height: 1.08; text-wrap: balance; color: var(--primary); }
.body { margin: 0; font-size: calc(var(--u) * 3.6); color: var(--muted); text-wrap: pretty; }
.text-main, .text-second { display: block; }
.text-second { font-size: .72em; opacity: .85; margin-top: .3em; }
.table-label { font-family: var(--heading); font-weight: 800; font-size: calc(var(--u) * 7); padding: calc(var(--u) * 1.2) calc(var(--u) * 4); border-radius: calc(var(--u) * 2); background: var(--primary); color: var(--primary-fg); }
.table-label .text-second { font-size: .6em; }
.qr { margin: 0; display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 1.6); }
.qr-code { width: calc(var(--u) * 46); height: calc(var(--u) * 46); padding: calc(var(--u) * 2.4); background: #ffffff; border-radius: calc(var(--u) * 3); border: calc(var(--u) * 0.6) solid var(--primary); }
.qr-code svg { display: block; width: 100%; height: 100%; }
.qr-caption { font-weight: 600; font-size: calc(var(--u) * 3.6); }
.cta { margin: 0; font-size: calc(var(--u) * 3.4); font-weight: 600; }
.footer { display: flex; flex-direction: column; gap: calc(var(--u) * .6); font-size: calc(var(--u) * 2.6); color: var(--muted); }
.featured { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(var(--u) * 3); width: 100%; }
.featured-1 { grid-template-columns: minmax(0, 1fr); }
.featured-item { display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 1); }
.featured-image { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: calc(var(--u) * 2); background: var(--accent); display: block; }
.featured-name { font-weight: 600; font-size: calc(var(--u) * 3); overflow-wrap: anywhere; }
.featured-price { font-size: calc(var(--u) * 2.8); color: var(--muted); }

.family-page .headline { font-size: calc(var(--u) * 8.5); }
.family-page .body { font-size: calc(var(--u) * 3.2); }
.family-page .qr-code { width: calc(var(--u) * 26); height: calc(var(--u) * 26); }
.family-page .qr-caption { font-size: calc(var(--u) * 2.8); }
.family-page .brand-name { font-size: calc(var(--u) * 3.6); }
.family-page .logo { max-height: calc(var(--u) * 9); }

.style-bold .bg { background: var(--primary); }
.style-bold .piece, .style-bold { color: var(--primary-fg); }
.style-bold .headline { color: var(--primary-fg); font-size: calc(var(--u) * 9); }
.family-page.style-bold .headline { font-size: calc(var(--u) * 10); }
.style-bold .body, .style-bold .footer, .style-bold .featured-price { color: var(--primary-fg); opacity: .85; }
.style-bold .table-label { background: var(--primary-fg); color: var(--primary); }
.style-bold .qr-code { border-color: var(--primary-fg); }

.style-minimal .bg { background: #ffffff; }
.style-minimal .safe { align-items: flex-start; text-align: start; }
.style-minimal .brand { justify-content: flex-start; }
.style-minimal .headline { color: var(--fg); }
.style-minimal .message { border-inline-start: calc(var(--u) * 1) solid var(--primary); padding-inline-start: calc(var(--u) * 3); }
.style-minimal .qr { align-items: flex-start; }
.style-minimal .qr-code { border-color: var(--fg); border-width: calc(var(--u) * .3); }
.style-minimal .featured-item { align-items: flex-start; }
`
}

/**
 * CSP for a served print document: inline styles, Google Fonts, inlined
 * images, and at most the nonce'd auto-print script. Framable by the App only.
 */
export function printDocumentCsp(nonce?: string) {
	return [
		"default-src 'none'",
		"style-src 'unsafe-inline' https://fonts.googleapis.com",
		'font-src https://fonts.gstatic.com',
		'img-src data:',
		nonce ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'self'",
	].join('; ')
}

export function renderPrintHtml(input: PrintDocumentInput): string {
	const { snapshot, format } = input
	const piece = pieceBox(snapshot)
	const family = PRINT_PRODUCTS[snapshot.product].family
	const bleedMm = format === 'home' ? 0 : (input.bleedMm ?? 3)
	const indexes = snapshot.pieces.map((_, index) => index)
	const shown =
		format === 'proof' ? indexes.slice(0, input.proofLimit ?? 3) : indexes
	const pieceOuter: Box = {
		widthMm: piece.widthMm + 2 * bleedMm,
		heightMm: piece.heightMm + 2 * bleedMm,
	}

	let page: Box = pieceOuter
	const sheets: string[] = []

	if (format === 'home') {
		const sheet = PRINT_HOME_SHEET_SIZES[input.homeSheet ?? 'letter']
		page = sheet
		const usableW = sheet.widthMm - 2 * HOME_MARGIN_MM
		const usableH = sheet.heightMm - 2 * HOME_MARGIN_MM
		const cols = Math.floor(
			(usableW + HOME_GAP_MM) / (piece.widthMm + HOME_GAP_MM),
		)
		const rows = Math.floor(
			(usableH + HOME_GAP_MM) / (piece.heightMm + HOME_GAP_MM),
		)
		if (family === 'card' && cols >= 1 && rows >= 1) {
			const perSheet = cols * rows
			const gridW = cols * piece.widthMm + (cols - 1) * HOME_GAP_MM
			const gridH = rows * piece.heightMm + (rows - 1) * HOME_GAP_MM
			const originX = (sheet.widthMm - gridW) / 2
			const originY = (sheet.heightMm - gridH) / 2
			for (let start = 0; start < shown.length; start += perSheet) {
				const slots = shown.slice(start, start + perSheet).map((index, n) => {
					const x = originX + (n % cols) * (piece.widthMm + HOME_GAP_MM)
					const y =
						originY + Math.floor(n / cols) * (piece.heightMm + HOME_GAP_MM)
					return `<div class="slot" style="left:${mm(x)};top:${mm(y)};width:${mm(piece.widthMm)};height:${mm(piece.heightMm)}">${pieceMarkup(snapshot, index, input.qrSvgs[index] ?? null)}</div>${cropMarks(x, y, piece)}`
				})
				sheets.push(`<div class="sheet">${slots.join('')}</div>`)
			}
		} else {
			// Larger than the sheet (posters, flyers): scale one piece to fit.
			const scale = Math.min(
				usableW / piece.widthMm,
				usableH / piece.heightMm,
				1,
			)
			const w = piece.widthMm * scale
			const h = piece.heightMm * scale
			const x = (sheet.widthMm - w) / 2
			const y = (sheet.heightMm - h) / 2
			for (const index of shown) {
				sheets.push(
					`<div class="sheet"><div class="slot" style="left:${mm(x)};top:${mm(y)};width:${mm(w)};height:${mm(h)}"><div class="fit" style="width:${mm(piece.widthMm)};height:${mm(piece.heightMm)};transform:scale(${scale})">${pieceMarkup(snapshot, index, input.qrSvgs[index] ?? null)}</div></div>${cropMarks(x, y, { widthMm: w, heightMm: h })}</div>`,
				)
			}
		}
	} else {
		for (const index of shown) {
			const overlay =
				format === 'proof'
					? '<div class="bleed-note"></div><div class="trim"></div>'
					: ''
			sheets.push(
				`<div class="sheet">${pieceMarkup(snapshot, index, input.qrSvgs[index] ?? null)}${overlay}</div>`,
			)
		}
	}

	const fonts = googleFontsHref([
		familyName(snapshot.brand.headingFont),
		familyName(snapshot.brand.bodyFont),
		...SCRIPT_FONTS,
	])
	const css = documentCss({ snapshot, page, piece, bleedMm, format })
	const lang = snapshot.copy[0]?.locale ?? 'en'
	const printScript = input.autoPrint
		? `<script nonce="${escapeHtml(input.nonce ?? '')}">document.fonts.ready.then(function(){setTimeout(function(){window.print()},150)})</script>`
		: ''
	const bodyHtml =
		format === 'proof'
			? `<div class="proof">${sheets.join('')}</div>`
			: sheets.join('')
	return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(snapshot.brand.name)}</title><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${fonts}"><style>${css}</style></head><body>${bodyHtml}${printScript}</body></html>`
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

/** Page size of the professional file, for the renderer's PDF options. */
export function proPageSize(snapshot: PrintSnapshot, bleedMm: number): Box {
	const piece = pieceBox(snapshot)
	return {
		widthMm: piece.widthMm + 2 * bleedMm,
		heightMm: piece.heightMm + 2 * bleedMm,
	}
}
