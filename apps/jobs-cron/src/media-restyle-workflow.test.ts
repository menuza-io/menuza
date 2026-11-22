import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	MEDIA_RESTYLE_JOB_PATH,
	MEDIA_RESTYLE_MAX_BATCHES,
	MediaRestyleWorkflow,
} from './media-restyle-workflow'

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: class {
		env: unknown
		constructor(_ctx: unknown, env: unknown) {
			this.env = env
		}
	},
}))

describe('MediaRestyleWorkflow (#146)', () => {
	const env = {
		APP_BASE_URL: 'https://app.example.com/',
		INTERNAL_COMMAND_TOKEN: 'secret-token',
	}
	const NOW = new Date('2026-11-21T10:00:00.000Z')
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(NOW)
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	const answer = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status })
	const progress = (processed = 3) =>
		answer({ done: false, paused: false, resumeAt: null, processed })

	const run = (fetchMock: ReturnType<typeof vi.fn>) => {
		vi.stubGlobal('fetch', fetchMock)
		const stepDo = vi.fn(
			async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
		)
		const stepSleep = vi.fn(async () => undefined)
		const stepSleepUntil = vi.fn(async () => undefined)
		const result = new MediaRestyleWorkflow({} as never, env).run(
			{
				payload: { runId: 'run1234567890' },
				timestamp: new Date(),
				instanceId: 'i',
				workflowName: 'media-restyle',
			},
			{ do: stepDo, sleep: stepSleep, sleepUntil: stepSleepUntil } as never,
		)
		return { result, stepDo, stepSleep, stepSleepUntil }
	}

	it('wakes the App with the run id only, with the internal token', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				answer({ done: true, paused: false, resumeAt: null, processed: 2 }),
			)
		await run(fetchMock).result
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe(`https://app.example.com${MEDIA_RESTYLE_JOB_PATH}`)
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toBe('Bearer secret-token')
		expect(JSON.parse(init.body)).toEqual({ runId: 'run1234567890' })
		expect(init.signal).toBeInstanceOf(AbortSignal)
	})

	it('keeps asking until the run is done', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(progress())
			.mockResolvedValueOnce(progress())
			.mockResolvedValueOnce(
				answer({ done: true, paused: false, resumeAt: null, processed: 1 }),
			)
		const { result, stepDo, stepSleep } = run(fetchMock)
		await result
		expect(stepDo.mock.calls.map(([name]) => name)).toEqual([
			'batch-0',
			'batch-1',
			'batch-2',
		])
		expect(stepSleep).not.toHaveBeenCalled()
	})

	it('sleeps until the time the App gives when the daily budget is reached', async () => {
		const resumeAt = new Date(NOW.getTime() + 8 * 3_600_000).toISOString()
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				answer({ done: false, paused: true, resumeAt, processed: 4 }),
			)
			.mockResolvedValueOnce(
				answer({ done: true, paused: false, resumeAt: null, processed: 4 }),
			)
		const { result, stepSleepUntil, stepSleep } = run(fetchMock)
		await result
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(stepSleepUntil).toHaveBeenCalledTimes(1)
		expect(stepSleepUntil.mock.calls[0]).toEqual([
			'resume-0',
			new Date(resumeAt),
		])
		expect(stepSleep).not.toHaveBeenCalled()
	})

	it.each([
		['no time', null],
		['an unreadable time', 'tomorrow-ish'],
		['a time already past', new Date(NOW.getTime() - 60_000).toISOString()],
	])('sleeps an hour when paused with %s', async (_label, resumeAt) => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				answer({ done: false, paused: true, resumeAt, processed: 0 }),
			)
			.mockResolvedValueOnce(
				answer({ done: true, paused: false, resumeAt: null, processed: 1 }),
			)
		const { result, stepSleepUntil, stepSleep } = run(fetchMock)
		await result
		expect(stepSleepUntil).not.toHaveBeenCalled()
		expect(stepSleep.mock.calls).toEqual([['resume-0', '1 hour']])
	})

	it('does not count a paused batch as idle, however often the run pauses', async () => {
		const resumeAt = new Date(NOW.getTime() + 3_600_000).toISOString()
		const paused = () =>
			answer({ done: false, paused: true, resumeAt, processed: 0 })
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(paused())
			.mockResolvedValueOnce(paused())
			.mockResolvedValueOnce(paused())
			.mockResolvedValueOnce(paused())
			.mockResolvedValueOnce(
				answer({ done: true, paused: false, resumeAt: null, processed: 1 }),
			)
		await run(fetchMock).result
		expect(fetchMock).toHaveBeenCalledTimes(5)
	})

	it('stops after three batches in a row that make no progress', async () => {
		const fetchMock = vi.fn(async () => progress(0))
		await run(fetchMock).result
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	it('does not stop when progress comes between idle batches', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(progress(0))
			.mockResolvedValueOnce(progress(0))
			.mockResolvedValueOnce(progress(2))
			.mockResolvedValueOnce(progress(0))
			.mockResolvedValueOnce(progress(0))
			.mockResolvedValueOnce(progress(0))
		await run(fetchMock).result
		expect(fetchMock).toHaveBeenCalledTimes(6)
	})

	it('never runs more than the batch cap, with unique step names', async () => {
		const fetchMock = vi.fn(async () => progress(1))
		const { result, stepDo } = run(fetchMock)
		await result
		expect(fetchMock).toHaveBeenCalledTimes(MEDIA_RESTYLE_MAX_BATCHES)
		const names = stepDo.mock.calls.map(([name]) => name)
		expect(new Set(names).size).toBe(names.length)
	})

	it('retries each batch step with a backoff', async () => {
		const { result, stepDo } = run(
			vi
				.fn()
				.mockResolvedValue(
					answer({ done: true, paused: false, resumeAt: null, processed: 0 }),
				),
		)
		await result
		expect(stepDo.mock.calls[0]![1]).toEqual({
			retries: { limit: 2, delay: '60 seconds', backoff: 'exponential' },
		})
	})

	it('fails the step, so it is retried, when the App refuses', async () => {
		await expect(
			run(vi.fn().mockResolvedValue(new Response('no', { status: 503 })))
				.result,
		).rejects.toThrow(/media-restyle failed: 503/)
	})

	it('fails the step when the App cannot be reached', async () => {
		await expect(
			run(vi.fn().mockRejectedValue(new Error('network down'))).result,
		).rejects.toThrow('network down')
	})
})
