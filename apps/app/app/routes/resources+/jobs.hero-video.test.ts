import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'
import { action } from './jobs.hero-video.ts'

const service = vi.hoisted(() => ({
	processHeroVideo: vi.fn(async () => ({ ok: true, status: 'ready' })),
	sweepHeroVideos: vi.fn(async () => ({ found: 1, driven: 1, failed: 0 })),
}))
vi.mock('#app/utils/website/hero-video/service.server.ts', () => service)

function call(
	init: { method?: string; authorized?: boolean; body?: string } = {},
) {
	const url = new URL('http://localhost:3001/resources/jobs/hero-video')
	return action({
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers:
				init.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
			body: init.body,
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/hero-video',
	}) as Promise<Response>
}

describe('jobs.hero-video (#301)', () => {
	it('is POST only and needs the internal token', async () => {
		expect((await call({ method: 'GET' })).status).toBe(405)
		await expect(call({ authorized: false })).rejects.toBeTruthy()
		expect(service.sweepHeroVideos).not.toHaveBeenCalled()
	})
	it('an empty body is the hourly sweep', async () => {
		expect(await (await call()).json()).toEqual({
			success: true,
			found: 1,
			driven: 1,
			failed: 0,
		})
	})
	it('a generation id renders that request', async () => {
		const response = await call({
			body: JSON.stringify({ generationId: 'gen1234567890' }),
		})
		expect(await response.json()).toEqual({
			success: true,
			generationId: 'gen1234567890',
			status: 'ready',
		})
		expect(service.processHeroVideo).toHaveBeenCalledWith('gen1234567890')
	})
	it('answers 503 for a passing problem, so the workflow retries', async () => {
		service.processHeroVideo.mockResolvedValueOnce({
			ok: false,
			status: 'queued',
			error: 'renderer_failed',
			retry: true,
		} as never)
		const response = await call({
			body: JSON.stringify({ generationId: 'gen1234567890' }),
		})
		expect(response.status).toBe(503)
		expect(await response.json()).toMatchObject({ success: false, retry: true })
	})
	it('refuses a malformed id or body', async () => {
		expect(
			(await call({ body: JSON.stringify({ generationId: '../x' }) })).status,
		).toBe(400)
		expect((await call({ body: '{nope' })).status).toBe(400)
	})
})
