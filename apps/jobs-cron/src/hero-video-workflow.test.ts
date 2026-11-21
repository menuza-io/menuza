import { afterEach, describe, expect, it, vi } from 'vitest'
import { HERO_VIDEO_JOB_PATH, HeroVideoWorkflow } from './hero-video-workflow'

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: class {
		env: unknown
		constructor(_ctx: unknown, env: unknown) {
			this.env = env
		}
	},
}))

describe('HeroVideoWorkflow (#301)', () => {
	const env = {
		APP_BASE_URL: 'https://app.example.com/',
		INTERNAL_COMMAND_TOKEN: 'secret-token',
	}
	afterEach(() => vi.unstubAllGlobals())

	const run = (fetchMock: ReturnType<typeof vi.fn>) => {
		vi.stubGlobal('fetch', fetchMock)
		const stepDo = vi.fn(
			async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
		)
		return new HeroVideoWorkflow({} as never, env).run(
			{
				payload: { generationId: 'gen1234567890' },
				timestamp: new Date(),
				instanceId: 'i',
				workflowName: 'hero-video',
			},
			{ do: stepDo } as never,
		)
	}

	it('wakes the App with the request id only', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('{}', { status: 200 }))
		await run(fetchMock)
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe(`https://app.example.com${HERO_VIDEO_JOB_PATH}`)
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toBe('Bearer secret-token')
		expect(JSON.parse(init.body)).toEqual({ generationId: 'gen1234567890' })
	})

	it('fails the step, so it is retried, when the App refuses', async () => {
		await expect(
			run(vi.fn().mockResolvedValue(new Response('no', { status: 502 }))),
		).rejects.toThrow(/hero-video failed: 502/)
	})
})
