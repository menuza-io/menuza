// The browser build draws SVG with no Node APIs (no PNG encoder), which keeps
// the Worker bundle small. The SVG renderer is all this page needs.
import { toString as qrToString } from 'qrcode/lib/browser.js'

/**
 * An inline SVG QR code for a link, drawn on the server so the page needs no
 * script. Black on white at any size: a code has to scan the same way in every
 * theme, including a dark one, so the colors are not theme tokens.
 */
export async function renderQrSvg(url: string): Promise<string | null> {
	try {
		return await qrToString(url, {
			type: 'svg',
			margin: 2,
			errorCorrectionLevel: 'M',
			color: { dark: '#000000', light: '#ffffff' },
		})
	} catch {
		return null
	}
}
