import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	MENU_SCHEDULE_JOB_PATH,
	MenuScheduleWorkflow,
} from './menu-schedule-workflow'

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: class {
		env: unknown
		constructor(_ctx: unknown, env: unknown) {
			this.env = env
		}
	},
}))

describe('MenuScheduleWorkflow (#149)', () => {
	const env = {
		APP_BASE_URL: 'https://app.example.com/',
		INTERNAL_COMMAND_TOKEN: 'secret-token',
	}

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it('sleeps until runAt when in the future and then triggers /resources/jobs/menu-schedules', async () => {
		const futureRunAt = new Date(Date.now() + 60_000).toISOString()
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('{}', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)

		const sleepUntil = vi.fn().mockResolvedValue(undefined)
		const stepDo = vi.fn(
			async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
		)

		const workflow = new MenuScheduleWorkflow({} as never, env)
		await workflow.run(
			{
				payload: { scheduleId: 'sched_1', runAt: futureRunAt },
				timestamp: new Date(),
				instanceId: 'inst_1',
				workflowName: 'menu-schedule',
			},
			{ sleepUntil, do: stepDo } as never,
		)

		expect(sleepUntil).toHaveBeenCalledTimes(1)
		expect(sleepUntil).toHaveBeenCalledWith(
			'wait-until-due',
			new Date(futureRunAt),
		)
		expect(stepDo).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledWith(
			`https://app.example.com${MENU_SCHEDULE_JOB_PATH}`,
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer secret-token',
				},
			},
		)
	})

	it('skips sleepUntil when runAt is already in the past', async () => {
		const pastRunAt = new Date(Date.now() - 60_000).toISOString()
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('{}', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)

		const sleepUntil = vi.fn()
		const stepDo = vi.fn(
			async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
		)

		const workflow = new MenuScheduleWorkflow({} as never, env)
		await workflow.run(
			{
				payload: { scheduleId: 'sched_2', runAt: pastRunAt },
				timestamp: new Date(),
				instanceId: 'inst_2',
				workflowName: 'menu-schedule',
			},
			{ sleepUntil, do: stepDo } as never,
		)

		expect(sleepUntil).not.toHaveBeenCalled()
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('throws when the App job route returns a non-OK status', async () => {
		const pastRunAt = new Date(Date.now() - 10_000).toISOString()
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					new Response('err', { status: 500, statusText: 'Internal Error' }),
				),
		)

		const workflow = new MenuScheduleWorkflow({} as never, env)
		await expect(
			workflow.run(
				{
					payload: { scheduleId: 'sched_3', runAt: pastRunAt },
					timestamp: new Date(),
					instanceId: 'inst_3',
					workflowName: 'menu-schedule',
				},
				{
					sleepUntil: vi.fn(),
					do: async (_n: string, _o: unknown, fn: () => Promise<unknown>) =>
						fn(),
				} as never,
			),
		).rejects.toThrow(
			'/resources/jobs/menu-schedules failed: 500 Internal Error',
		)
	})
})
