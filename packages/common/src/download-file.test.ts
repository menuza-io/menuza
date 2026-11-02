import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadFile } from './misc.tsx'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(response: () => Response) {
	const fetchMock = vi.fn(async () => response())
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

describe('downloadFile', () => {
	it('returns a small image as a File', async () => {
		stubFetch(
			() =>
				new Response(new Uint8Array([1, 2, 3]), {
					headers: { 'content-type': 'image/png' },
				}),
		)
		const file = await downloadFile('https://img.example/a.png')
		expect(file.size).toBe(3)
		expect(file.type).toBe('image/png')
	})

	it('rejects a declared length over the limit without retrying', async () => {
		const fetchMock = stubFetch(
			() =>
				new Response('x', {
					headers: { 'content-length': String(50 * 1024 * 1024) },
				}),
		)
		await expect(downloadFile('https://img.example/big.png')).rejects.toThrow(
			/exceeds/,
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('stops reading a body that lies about, or omits, its length', async () => {
		const chunk = new Uint8Array(1024 * 1024)
		let sent = 0
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				sent += 1
				controller.enqueue(chunk)
				if (sent > 100) controller.close()
			},
		})
		const fetchMock = stubFetch(() => new Response(body))
		await expect(
			downloadFile('https://img.example/endless.png', 0, 4 * 1024 * 1024),
		).rejects.toThrow(/exceeds/)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(sent).toBeLessThan(10)
	})
})
