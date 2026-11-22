import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	PHOTO_QUALITY_JOB_PATH,
	PHOTO_QUALITY_MAX_BATCHES,
	PhotoQualityWorkflow,
} from './photo-quality-workflow'

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: class {
		env: unknown
		constructor(_ctx: unknown, env: unknown) {
			this.env = env
		}
	},
}))

describe('PhotoQualityWorkflow (#145)', () => {
	const env = {
		APP_BASE_URL: 'https://app.example.com/',
		INTERNAL_COMMAND_TOKEN: 'secret-token',
	}
	afterEach(() => vi.unstubAllGlobals())

	const answer = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status })

	const run = (fetchMock: ReturnType<typeof vi.fn>) => {
		vi.stubGlobal('fetch', fetchMock)
		const stepDo = vi.fn(
			async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
		)
		const stepSleep = vi.fn(
			async (_name: string, _duration: string) => undefined,
		)
		const result = new PhotoQualityWorkflow({} as never, env).run(
			{
				payload: { organizationId: 'org1234567890' },
				timestamp: new Date(),
				instanceId: 'i',
				workflowName: 'photo-quality',
			},
			{ do: stepDo, sleep: stepSleep } as never,
		)
		return { result, stepDo, stepSleep }
	}

	it('wakes the App with the organization id only, with the internal token', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(answer({ processed: 5, remaining: 0, limited: false }))
		await run(fetchMock).result
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe(`https://app.example.com${PHOTO_QUALITY_JOB_PATH}`)
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toBe('Bearer secret-token')
		expect(JSON.parse(init.body)).toEqual({ organizationId: 'org1234567890' })
		expect(init.signal).toBeInstanceOf(AbortSignal)
	})

	it('keeps going with a pause between batches until nothing remains', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				answer({ processed: 10, remaining: 20, limited: false }),
			)
			.mockResolvedValueOnce(
				answer({ processed: 10, remaining: 10, limited: false }),
			)
			.mockResolvedValueOnce(
				answer({ processed: 10, remaining: 0, limited: false }),
			)
		const { result, stepDo, stepSleep } = run(fetchMock)
		await result
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(stepDo.mock.calls.map(([name]) => name)).toEqual([
			'batch-0',
			'batch-1',
			'batch-2',
		])
		expect(stepSleep.mock.calls).toEqual([
			['pause-0', '20 seconds'],
			['pause-1', '20 seconds'],
		])
	})

	it('stops when the daily limit is reached, leaving the rest to the sweep', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(answer({ processed: 4, remaining: 30, limited: true }))
		const { result, stepSleep } = run(fetchMock)
		await result
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(stepSleep).not.toHaveBeenCalled()
	})

	it('stops when a batch makes no progress', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(answer({ processed: 0, remaining: 7, limited: false }))
		const { result, stepSleep } = run(fetchMock)
		await result
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(stepSleep).not.toHaveBeenCalled()
	})

	it('treats an unreadable answer as no progress instead of looping', async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response('not json'))
		await run(fetchMock).result
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('never runs more than the batch cap, with unique step names', async () => {
		const fetchMock = vi.fn(async () =>
			answer({ processed: 1, remaining: 999, limited: false }),
		)
		const { result, stepDo, stepSleep } = run(fetchMock)
		await result
		expect(fetchMock).toHaveBeenCalledTimes(PHOTO_QUALITY_MAX_BATCHES)
		const names = [
			...stepDo.mock.calls.map(([name]) => name),
			...stepSleep.mock.calls.map(([name]) => name),
		]
		expect(new Set(names).size).toBe(names.length)
	})

	it('retries each batch step with a backoff', async () => {
		const { result, stepDo } = run(
			vi.fn().mockResolvedValue(answer({ processed: 1, remaining: 0 })),
		)
		await result
		expect(stepDo.mock.calls[0]![1]).toEqual({
			retries: { limit: 2, delay: '60 seconds', backoff: 'exponential' },
		})
	})

	it('fails the step, so it is retried, when the App refuses', async () => {
		await expect(
			run(vi.fn().mockResolvedValue(new Response('no', { status: 502 })))
				.result,
		).rejects.toThrow(/photo-quality failed: 502/)
	})

	it('fails the step when the App cannot be reached', async () => {
		await expect(
			run(vi.fn().mockRejectedValue(new Error('network down'))).result,
		).rejects.toThrow('network down')
	})
})
