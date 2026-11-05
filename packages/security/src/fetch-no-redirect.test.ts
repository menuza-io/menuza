import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchNoRedirect, RedirectBlockedError } from './fetch-no-redirect.js'

afterEach(() => {
	vi.restoreAllMocks()
})

describe('fetchNoRedirect', () => {
	it('asks for redirect: manual and returns a normal response', async () => {
		const response = Response.json({ ok: true })
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)

		await expect(
			fetchNoRedirect('https://api.example.com/x', {
				headers: { Authorization: 'Bearer t' },
				redirect: 'follow',
			}),
		).resolves.toBe(response)
		// A caller cannot turn following back on.
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://api.example.com/x',
			expect.objectContaining({
				redirect: 'manual',
				headers: { Authorization: 'Bearer t' },
			}),
		)
	})

	it.each([301, 302, 303, 307, 308])(
		'refuses a %i and does not request its Location',
		async (status) => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
				new Response(null, {
					status,
					headers: { Location: 'http://169.254.169.254/latest/meta-data' },
				}),
			)

			const result = fetchNoRedirect('https://api.example.com/x')
			await expect(result).rejects.toBeInstanceOf(RedirectBlockedError)
			await expect(result).rejects.toMatchObject({ status })
			expect(fetchSpy).toHaveBeenCalledTimes(1)
		},
	)

	it('cancels the body of a refused redirect', async () => {
		let cancelled = false
		const body = new ReadableStream({
			cancel() {
				cancelled = true
			},
		})
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(body, { status: 302, headers: { Location: 'http://x/' } }),
		)

		await expect(fetchNoRedirect('https://api.example.com/x')).rejects.toThrow(
			'Redirect blocked (302)',
		)
		expect(cancelled).toBe(true)
	})

	it('passes 304 and error statuses through for the caller to judge', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		for (const status of [304, 401, 404, 500]) {
			const response = new Response(null, { status })
			fetchSpy.mockResolvedValueOnce(response)
			await expect(fetchNoRedirect('https://api.example.com/x')).resolves.toBe(
				response,
			)
		}
	})

	it('lets a network error through', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'))
		await expect(fetchNoRedirect('https://api.example.com/x')).rejects.toThrow(
			'network',
		)
	})
})
