import { vi } from 'vitest'

/**
 * jsdom cannot decode or draw images. This stands in for the browser so an
 * uploaded test file resizes to a tiny JPEG data URL (starting with the JPEG
 * signature the server checks for).
 */
export function stubImageDecoding() {
	vi.stubGlobal(
		'createImageBitmap',
		vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })),
	)
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		fillRect: vi.fn(),
		drawImage: vi.fn(),
		fillStyle: '',
	} as unknown as CanvasRenderingContext2D)
	vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
		'data:image/jpeg;base64,/9j/4AAQ',
	)
}
