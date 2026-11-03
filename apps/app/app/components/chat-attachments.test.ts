// @vitest-environment jsdom

import {
	fileToAttachment,
	keepRecentImages,
	IMAGE_HISTORY_MESSAGES,
	OMITTED_IMAGE_TEXT,
} from '@repo/ai/chat-attachments'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

const file = (type = 'image/png', size = 4) =>
	new File([new Uint8Array(size)], 'photo', { type })

const canvasCalls: string[] = []

function stubCanvas(urlFor: (quality: number) => string) {
	canvasCalls.length = 0
	vi.stubGlobal(
		'createImageBitmap',
		vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })),
	)
	const toDataURL = vi.fn((_type: string, quality: number) => urlFor(quality))
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		fillRect: vi.fn(() => canvasCalls.push('fillRect')),
		drawImage: vi.fn(() => canvasCalls.push('drawImage')),
		set fillStyle(value: string) {
			canvasCalls.push(`fillStyle:${value}`)
		},
	} as unknown as CanvasRenderingContext2D)
	vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
		toDataURL as never,
	)
	return toDataURL
}

describe('fileToAttachment', () => {
	it('re-encodes a large photo as a JPEG on a white background', async () => {
		const toDataURL = stubCanvas(() => 'data:image/jpeg;base64,AAAA')
		const attachment = await fileToAttachment(file('image/png'))
		expect(attachment?.mediaType).toBe('image/jpeg')
		expect(attachment?.url).toBe('data:image/jpeg;base64,AAAA')
		expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85)
		// Transparent pixels would turn black in a JPEG, so white goes down first.
		expect(canvasCalls).toEqual(['fillStyle:#ffffff', 'fillRect', 'drawImage'])
	})

	it('asks the browser to apply the photo orientation', async () => {
		stubCanvas(() => 'data:image/jpeg;base64,AAAA')
		await fileToAttachment(file('image/jpeg'))
		expect(createImageBitmap).toHaveBeenCalledWith(expect.any(File), {
			imageOrientation: 'from-image',
		})
	})

	it('attaches nothing, rather than the original bytes, when the browser cannot decode', async () => {
		// The original would carry its EXIF metadata, GPS location included.
		vi.stubGlobal('createImageBitmap', undefined)
		expect(await fileToAttachment(file('image/jpeg'))).toBeNull()
	})

	it('retries smaller until the result fits under the server cap', async () => {
		const toDataURL = stubCanvas((quality) =>
			quality > 0.6
				? `data:image/jpeg;base64,${'A'.repeat(2_500_000)}`
				: 'data:image/jpeg;base64,AAAA',
		)
		const attachment = await fileToAttachment(file('image/jpeg'))
		expect(attachment?.url).toBe('data:image/jpeg;base64,AAAA')
		expect(toDataURL.mock.calls.length).toBeGreaterThan(1)
	})

	it('gives up on an image that never fits', async () => {
		stubCanvas(() => `data:image/jpeg;base64,${'A'.repeat(2_500_000)}`)
		expect(await fileToAttachment(file('image/jpeg'))).toBeNull()
	})

	it('refuses other file types and oversized sources', async () => {
		expect(await fileToAttachment(file('application/pdf'))).toBeNull()
		expect(
			await fileToAttachment(file('image/png', 10 * 1024 * 1024 + 1)),
		).toBeNull()
	})
})

describe('keepRecentImages', () => {
	const image = { type: 'file' }
	const text = { type: 'text' }

	it('keeps images only on the most recent messages that have them', () => {
		const messages = [
			{ id: 'a', parts: [image, text] },
			{ id: 'b', parts: [image, text] },
			{ id: 'c', parts: [text] },
			{ id: 'd', parts: [image, text] },
		]
		const result = keepRecentImages(messages)
		expect(IMAGE_HISTORY_MESSAGES).toBe(2)
		expect(result.map((m) => m.parts.length)).toEqual([1, 2, 1, 2])
	})

	it('keeps an image-only turn as a placeholder, so its reply keeps its question', () => {
		const messages = [
			{ id: 'a', parts: [image] },
			{ id: 'b', parts: [image, text] },
		]
		const stripped = keepRecentImages(messages, 0)
		expect(stripped.map((m) => m.id)).toEqual(['a', 'b'])
		expect(stripped[0]?.parts).toEqual([
			{ type: 'text', text: OMITTED_IMAGE_TEXT },
		])
		expect(stripped[1]?.parts).toEqual([text])
	})

	it('does not change a conversation without images', () => {
		const messages = [{ id: 'a', parts: [text] }]
		expect(keepRecentImages(messages)).toEqual(messages)
	})
})
