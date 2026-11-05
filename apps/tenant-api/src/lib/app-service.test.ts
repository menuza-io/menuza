import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyVarlockEnv } from './secrets.ts'
import {
	appFetchImpl,
	bindAppService,
	fetchApp,
	hasAppService,
} from './app-service.ts'

afterEach(() => {
	bindAppService(null)
	vi.restoreAllMocks()
})

describe('App service binding', () => {
	it('uses global fetch when nothing is bound', async () => {
		expect(hasAppService()).toBe(false)
		const response = Response.json({ ok: true })
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)

		await expect(fetchApp('https://app.example.com/x')).resolves.toBe(response)
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://app.example.com/x',
			expect.objectContaining({ redirect: 'manual' }),
		)
	})

	it('sends App requests over the binding, not the public URL', async () => {
		const response = Response.json({ ok: true })
		const binding = { fetch: vi.fn().mockResolvedValue(response) }
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		bindAppService(binding)

		expect(hasAppService()).toBe(true)
		await expect(
			fetchApp('https://app.example.com/resources/tenant-organization', {
				headers: { Authorization: 'Bearer t' },
			}),
		).resolves.toBe(response)
		expect(binding.fetch).toHaveBeenCalledWith(
			'https://app.example.com/resources/tenant-organization',
			expect.objectContaining({
				redirect: 'manual',
				headers: { Authorization: 'Bearer t' },
			}),
		)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('still refuses a redirect from the binding', async () => {
		bindAppService({
			fetch: vi.fn().mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: { Location: 'http://x/' },
				}),
			),
		})
		await expect(fetchApp('https://app.example.com/x')).rejects.toThrow(
			'Redirect blocked (302)',
		)
	})

	it('ignores a binding that is not a fetcher', () => {
		bindAppService({})
		expect(hasAppService()).toBe(false)
		bindAppService(undefined)
		expect(appFetchImpl()).toBe(fetch)
	})

	it('is bound whenever a Worker or Durable Object applies its env', () => {
		applyVarlockEnv({
			APP: { fetch: vi.fn() },
			APP_URL: 'https://app.example.com',
		})
		expect(hasAppService()).toBe(true)
		applyVarlockEnv({ APP_URL: 'https://app.example.com' })
		expect(hasAppService()).toBe(false)
	})
})
