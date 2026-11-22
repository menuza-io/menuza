import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	OPERATOR_ALERTS_JOB_PATH,
	OperatorAlertsWorkflow,
} from './operator-alerts-workflow'

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: class {
		env: unknown
		constructor(_ctx: unknown, env: unknown) {
			this.env = env
		}
	},
}))

describe('OperatorAlertsWorkflow (#366)', () => {
	const env = {
		APP_BASE_URL: 'https://app.example.com/',
		INTERNAL_COMMAND_TOKEN: 'secret-token',
	}
	const step = (sleepUntil: unknown) =>
		({
			sleepUntil,
			do: vi.fn(
				async (_name: string, _opts: unknown, fn: () => Promise<unknown>) =>
					fn(),
			),
		}) as never

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it('sleeps until quiet hours end, then wakes the App job', async () => {
		const runAt = new Date(Date.now() + 60_000).toISOString()
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('{}', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		const sleepUntil = vi.fn().mockResolvedValue(undefined)

		await new OperatorAlertsWorkflow({} as never, env).run(
			{
				payload: { runAt },
				timestamp: new Date(),
				instanceId: 'i',
				workflowName: 'operator-alerts',
			},
			step(sleepUntil),
		)

		expect(sleepUntil).toHaveBeenCalledWith(
			'wait-until-quiet-hours-end',
			new Date(runAt),
		)
		expect(fetchMock).toHaveBeenCalledWith(
			`https://app.example.com${OPERATOR_ALERTS_JOB_PATH}`,
			{ method: 'POST', headers: { Authorization: 'Bearer secret-token' } },
		)
	})

	it('does not sleep when the time has passed, and retries a refused call', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response('no', { status: 503, statusText: 'Down' }),
			)
		vi.stubGlobal('fetch', fetchMock)
		const sleepUntil = vi.fn()
		await expect(
			new OperatorAlertsWorkflow({} as never, env).run(
				{
					payload: { runAt: new Date(Date.now() - 60_000).toISOString() },
					timestamp: new Date(),
					instanceId: 'i',
					workflowName: 'operator-alerts',
				},
				step(sleepUntil),
			),
		).rejects.toThrow(/503/)
		expect(sleepUntil).not.toHaveBeenCalled()
	})
})
