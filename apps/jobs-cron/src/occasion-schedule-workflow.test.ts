import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	OCCASION_SCHEDULE_JOB_PATH,
	OccasionScheduleWorkflow,
} from './occasion-schedule-workflow'

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: class {
		env: unknown
		constructor(_ctx: unknown, env: unknown) {
			this.env = env
		}
	},
}))

describe('OccasionScheduleWorkflow (#152)', () => {
	const env = {
		APP_BASE_URL: 'https://app.example.com/',
		INTERNAL_COMMAND_TOKEN: 'secret-token',
	}
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	const run = async (runAt: string, response = new Response('{}')) => {
		const fetchMock = vi.fn().mockResolvedValue(response)
		vi.stubGlobal('fetch', fetchMock)
		const sleepUntil = vi.fn().mockResolvedValue(undefined)
		const stepDo = vi.fn(
			async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
		)
		await new OccasionScheduleWorkflow({} as never, env).run(
			{
				payload: { runAt },
				timestamp: new Date(),
				instanceId: 'i',
				workflowName: 'occasion-schedule',
			},
			{ sleepUntil, do: stepDo } as never,
		)
		return { fetchMock, sleepUntil }
	}

	it('sleeps until the daily wake-up, then calls the App job with nothing about anyone', async () => {
		const runAt = new Date(Date.now() + 10 * 3_600_000).toISOString()
		const { fetchMock, sleepUntil } = await run(runAt)
		expect(sleepUntil).toHaveBeenCalledWith('wait-until-due', new Date(runAt))
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe(`https://app.example.com${OCCASION_SCHEDULE_JOB_PATH}`)
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toBe('Bearer secret-token')
		expect(JSON.parse(init.body)).toEqual({})
	})

	it('does not sleep when it is already due', async () => {
		const { sleepUntil, fetchMock } = await run(
			new Date(Date.now() - 60_000).toISOString(),
		)
		expect(sleepUntil).not.toHaveBeenCalled()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('fails the step (so it is retried) when the App refuses', async () => {
		await expect(
			run(
				new Date(Date.now() - 1000).toISOString(),
				new Response('no', { status: 503 }),
			),
		).rejects.toThrow(/occasion-schedule failed: 503/)
	})
})
