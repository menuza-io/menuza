import { fetchNoRedirect as securityFetchNoRedirect } from '@repo/security/fetch-no-redirect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchNoRedirect as localFetchNoRedirect } from './fetch-no-redirect.ts'

afterEach(() => {
	vi.restoreAllMocks()
})

// This node keeps its own copy because it does not depend on @repo/security.
// Run the same cases on both so the copies cannot drift.
describe.each([
	['tenant-api copy', localFetchNoRedirect],
	['@repo/security', securityFetchNoRedirect],
])('fetchNoRedirect (%s)', (_name, fetchNoRedirect) => {
	it('asks for redirect: manual and returns a normal response', async () => {
		const response = Response.json({ ok: true })
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)

		await expect(
			fetchNoRedirect('https://app.example.com/x', { redirect: 'follow' }),
		).resolves.toBe(response)
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://app.example.com/x',
			expect.objectContaining({ redirect: 'manual' }),
		)
	})

	it('refuses a redirect, cancels its body and never requests the Location', async () => {
		let cancelled = false
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				new ReadableStream({
					cancel() {
						cancelled = true
					},
				}),
				{ status: 302, headers: { Location: 'http://169.254.169.254/' } },
			),
		)

		await expect(fetchNoRedirect('https://app.example.com/x')).rejects.toThrow(
			'Redirect blocked (302)',
		)
		expect(cancelled).toBe(true)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('passes 304 and error statuses through', async () => {
		for (const status of [304, 401, 500]) {
			const response = new Response(null, { status })
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response)
			await expect(fetchNoRedirect('https://app.example.com/x')).resolves.toBe(
				response,
			)
		}
	})
})
