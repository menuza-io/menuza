import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	bindAppService,
	hasAppService,
	postToApp,
} from './app-service.server.ts'

afterEach(() => {
	bindAppService(null)
})

describe('postToApp', () => {
	it('uses global fetch to APP_URL when nothing is bound, without following redirects', async () => {
		const response = Response.json({ ok: true })
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)

		const result = await postToApp(
			'/resources/x',
			{ a: 1 },
			{ timeoutMs: 1000 },
		)

		expect(result).toEqual({ status: 'answered', response })
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringMatching(/^https?:\/\/[^/]+\/resources\/x$/),
			expect.objectContaining({
				method: 'POST',
				redirect: 'manual',
				body: JSON.stringify({ a: 1 }),
				signal: expect.any(AbortSignal),
			}),
		)
		const init = fetchSpy.mock.calls[0]![1]!
		expect(new Headers(init.headers).get('Authorization')).toMatch(/^Bearer .+/)
	})

	it('sends the request over the APP service binding, not the public URL', async () => {
		const response = Response.json({ ok: true })
		const binding = { fetch: vi.fn().mockResolvedValue(response) }
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		bindAppService(binding)

		expect(hasAppService()).toBe(true)
		const result = await postToApp('/resources/x', {}, { timeoutMs: 1000 })

		expect(result).toEqual({ status: 'answered', response })
		expect(binding.fetch).toHaveBeenCalledWith(
			expect.stringMatching(/\/resources\/x$/),
			expect.objectContaining({ redirect: 'manual' }),
		)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('hands a redirect back instead of following it', async () => {
		const redirect = new Response(null, {
			status: 302,
			headers: { Location: 'https://elsewhere.example/' },
		})
		bindAppService({ fetch: vi.fn().mockResolvedValue(redirect) })

		const result = await postToApp('/resources/x', {}, { timeoutMs: 1000 })

		expect(result.status).toBe('answered')
		expect(result.status === 'answered' && result.response.ok).toBe(false)
	})

	it('reports an App that does not answer', async () => {
		bindAppService({
			fetch: vi.fn().mockRejectedValue(new DOMException('', 'TimeoutError')),
		})

		await expect(
			postToApp('/resources/x', {}, { timeoutMs: 1000 }),
		).resolves.toEqual({ status: 'unreachable' })
	})

	it('ignores a binding that is not a fetcher', () => {
		bindAppService({})
		expect(hasAppService()).toBe(false)
		bindAppService(undefined)
		expect(hasAppService()).toBe(false)
	})
})
