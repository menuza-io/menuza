import { create } from 'qrcode/lib/browser.js'
import { QR_QUIET_ZONE, qrPath } from './qr'

/** Reads a path of `M x y h w v1 h-w z` runs back into a grid of dark modules. */
function decode(path: string, size: number) {
	const grid = Array.from({ length: size }, () =>
		Array<boolean>(size).fill(false),
	)
	for (const match of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
		const [x, y, width] = [Number(match[1]), Number(match[2]), Number(match[3])]
		for (let i = 0; i < width; i += 1) grid[y]![x + i] = true
	}
	return grid
}

describe('qrPath', () => {
	it('draws the symbol with a quiet zone on every side', () => {
		const { size, path } = qrPath(
			'gcs1.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
		)
		const { modules } = create(
			'gcs1.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
			{
				errorCorrectionLevel: 'M',
			},
		)
		expect(size).toBe(modules.size + 2 * QR_QUIET_ZONE)
		const grid = decode(path, size)
		// Nothing is drawn in the quiet zone.
		for (let i = 0; i < size; i += 1) {
			for (let q = 0; q < QR_QUIET_ZONE; q += 1) {
				expect(grid[q]![i]).toBe(false)
				expect(grid[size - 1 - q]![i]).toBe(false)
				expect(grid[i]![q]).toBe(false)
				expect(grid[i]![size - 1 - q]).toBe(false)
			}
		}
	})

	it('reproduces every module of the encoded symbol', () => {
		const text = 'gcs1.qrTokenForTheTill_-0123456789abcdefghijklmnopq'
		const { size, path } = qrPath(text)
		const { modules } = create(text, { errorCorrectionLevel: 'M' })
		const grid = decode(path, size)
		for (let row = 0; row < modules.size; row += 1) {
			for (let col = 0; col < modules.size; col += 1) {
				expect(grid[row + QR_QUIET_ZONE]![col + QR_QUIET_ZONE]).toBe(
					Boolean(modules.get(row, col)),
				)
			}
		}
	})

	it('has the three finder patterns a scanner looks for', () => {
		const { size, path } = qrPath('gcs1.token')
		const grid = decode(path, size)
		const q = QR_QUIET_ZONE
		const last = size - q - 7
		for (const [row, col] of [
			[q, q],
			[q, last],
			[last, q],
		] as const) {
			// The 7x7 finder: a dark ring, a light ring, a dark 3x3 centre.
			expect(grid[row]![col]).toBe(true)
			expect(grid[row]![col + 6]).toBe(true)
			expect(grid[row + 6]![col]).toBe(true)
			expect(grid[row + 1]![col + 1]).toBe(false)
			expect(grid[row + 3]![col + 3]).toBe(true)
		}
	})

	it('is deterministic and depends on the text', () => {
		expect(qrPath('gcs1.same')).toEqual(qrPath('gcs1.same'))
		expect(qrPath('gcs1.one').path).not.toBe(qrPath('gcs1.two').path)
	})
})
