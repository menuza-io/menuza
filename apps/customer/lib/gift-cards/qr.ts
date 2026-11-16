import { create } from 'qrcode/lib/browser.js'

/** Quiet zone around the symbol, in modules (the QR specification asks for four). */
export const QR_QUIET_ZONE = 4

export type QrPath = {
	/** Side of the square view box, quiet zone included. */
	readonly size: number
	/** One SVG path: a rectangle per horizontal run of dark modules. */
	readonly path: string
}

/**
 * A QR code for `text` as one SVG path in module units (one unit per module),
 * so it scales to any size without a bitmap. Medium error correction: a
 * token is short, and the screen may be scuffed or at an angle.
 */
export function qrPath(text: string): QrPath {
	const { modules } = create(text, { errorCorrectionLevel: 'M' })
	const side = modules.size
	let path = ''
	for (let row = 0; row < side; row += 1) {
		let col = 0
		while (col < side) {
			if (!modules.get(row, col)) {
				col += 1
				continue
			}
			let end = col
			while (end < side && modules.get(row, end)) end += 1
			path += `M${col + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${end - col}v1h-${end - col}z`
			col = end
		}
	}
	return { size: side + 2 * QR_QUIET_ZONE, path }
}
