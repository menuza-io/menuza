import { ENV } from 'varlock/env'

/**
 * Turns a print document into a PDF with Cloudflare Browser Rendering (the
 * REST `/pdf` endpoint: headless Chrome, so Arabic shaping, RTL and the org's
 * web fonts render exactly as in the proof). Output is RGB; the page size is
 * the document's own `@page` size, trim plus bleed for professional files.
 *
 * Without credentials (local dev) there is no renderer: callers serve the
 * print-ready page instead and the browser's print dialog saves the PDF.
 */

/** Read live (the Worker mirrors bindings into `process.env`), then varlock. */
function rendererEnv(
	name:
		| 'PRINT_BROWSER_ACCOUNT_ID'
		| 'PRINT_BROWSER_API_TOKEN'
		| 'PRINT_RENDER_LIMIT_PER_HOUR',
): string {
	const live = typeof process !== 'undefined' ? process.env?.[name] : undefined
	return String(live ?? (ENV as Record<string, unknown>)[name] ?? '').trim()
}

export type PdfRenderResult =
	| { ok: true; bytes: Uint8Array<ArrayBuffer> }
	| { ok: false; reason: 'not_configured' | 'failed'; status?: number }

export function isPdfRendererConfigured(): boolean {
	return Boolean(
		rendererEnv('PRINT_BROWSER_ACCOUNT_ID') &&
		rendererEnv('PRINT_BROWSER_API_TOKEN'),
	)
}

/** The document without its web fonts (system fonts render instead). */
export function withoutRemoteFonts(html: string): string {
	return html.replace(
		/<link rel="(?:preconnect|stylesheet)" href="https:\/\/fonts\.(?:googleapis|gstatic)\.com[^"]*"[^>]*>/g,
		'',
	)
}

/**
 * Renders the document; if that fails for a reason other than the account
 * (a font host that is down or slow makes `networkidle0` time out), renders
 * once more without web fonts, so a font outage does not fail the order.
 */
export async function renderPdf(html: string): Promise<PdfRenderResult> {
	const first = await renderOnce(html, { waitUntil: 'networkidle0' })
	if (first.ok || first.reason === 'not_configured') return first
	if (first.status === 401 || first.status === 403 || first.status === 429) {
		return first
	}
	console.warn('Print PDF render retried without web fonts')
	return renderOnce(withoutRemoteFonts(html), { waitUntil: 'load' })
}

async function renderOnce(
	html: string,
	options: { waitUntil: 'networkidle0' | 'load' },
): Promise<PdfRenderResult> {
	const accountId = rendererEnv('PRINT_BROWSER_ACCOUNT_ID')
	const token = rendererEnv('PRINT_BROWSER_API_TOKEN')
	if (!accountId || !token) return { ok: false, reason: 'not_configured' }

	try {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-rendering/pdf`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					html,
					// Fonts come from Google Fonts; wait until they are in.
					gotoOptions: { waitUntil: options.waitUntil, timeout: 45_000 },
					pdfOptions: {
						printBackground: true,
						preferCSSPageSize: true,
						margin: { top: '0', right: '0', bottom: '0', left: '0' },
					},
				}),
				signal: AbortSignal.timeout(60_000),
			},
		)
		const type = response.headers.get('content-type') ?? ''
		if (!response.ok || !type.includes('application/pdf')) {
			console.error(`Print PDF render failed with status ${response.status}`)
			return { ok: false, reason: 'failed', status: response.status }
		}
		const bytes = new Uint8Array(await response.arrayBuffer())
		// A PDF starts with "%PDF"; anything else is an error body.
		if (
			bytes.length < 4 ||
			String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF'
		) {
			return { ok: false, reason: 'failed' }
		}
		return { ok: true, bytes }
	} catch (error) {
		console.error(
			'Print PDF render failed:',
			error instanceof Error ? error.message : error,
		)
		return { ok: false, reason: 'failed' }
	}
}

export function renderLimitPerHour(): number {
	const raw = Number(rendererEnv('PRINT_RENDER_LIMIT_PER_HOUR') || undefined)
	return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 30
}
