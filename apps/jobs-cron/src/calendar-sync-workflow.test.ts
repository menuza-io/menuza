import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	CALENDAR_SYNC_JOB_PATH,
	CalendarSyncWorkflow,
} from './calendar-sync-workflow'

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: class {
		env: unknown
		constructor(_ctx: unknown, env: unknown) {
			this.env = env
		}
	},
}))

describe('CalendarSyncWorkflow (#319)', () => {
	const env = {
		APP_BASE_URL: 'https://app.example.com/',
		INTERNAL_COMMAND_TOKEN: 'secret-token',
	}
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	const run = async (runAt: string) => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('{}', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		const sleepUntil = vi.fn().mockResolvedValue(undefined)
		const stepDo = vi.fn(
			async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
		)
		await new CalendarSyncWorkflow({} as never, env).run(
			{
				payload: { sourceId: 'source123456', runAt },
				timestamp: new Date(),
				instanceId: 'i',
				workflowName: 'calendar-sync',
			},
			{ sleepUntil, do: stepDo } as never,
		)
		return { fetchMock, sleepUntil }
	}

	it('sleeps until the source is due, then asks the App to sync it with the source id only', async () => {
		const runAt = new Date(Date.now() + 6 * 3_600_000).toISOString()
		const { fetchMock, sleepUntil } = await run(runAt)
		expect(sleepUntil).toHaveBeenCalledWith('wait-until-due', new Date(runAt))
		const [url, init] = fetchMock.mock.calls[0]!
		expect(url).toBe(`https://app.example.com${CALENDAR_SYNC_JOB_PATH}`)
		expect(init.method).toBe('POST')
		expect(init.headers.Authorization).toBe('Bearer secret-token')
		expect(JSON.parse(init.body)).toEqual({ sourceId: 'source123456' })
	})

	it('does not sleep when it is already due', async () => {
		const { fetchMock, sleepUntil } = await run(
			new Date(Date.now() - 60_000).toISOString(),
		)
		expect(sleepUntil).not.toHaveBeenCalled()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('fails the step (so it is retried) when the App refuses', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('no', { status: 503 })),
		)
		const stepDo = vi.fn(
			async (_n: string, _o: unknown, fn: () => Promise<unknown>) => fn(),
		)
		await expect(
			new CalendarSyncWorkflow({} as never, env).run(
				{
					payload: {
						sourceId: 'source123456',
						runAt: new Date(0).toISOString(),
					},
					timestamp: new Date(),
					instanceId: 'i',
					workflowName: 'calendar-sync',
				},
				{ sleepUntil: vi.fn(), do: stepDo } as never,
			),
		).rejects.toThrow(/calendar-sync failed: 503/)
	})
})
