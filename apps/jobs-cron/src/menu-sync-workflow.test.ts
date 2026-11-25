import { afterEach, describe, expect, it, vi } from 'vitest'
import { MENU_SYNC_JOB_PATH, MenuSyncWorkflow } from './menu-sync-workflow'

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: class {
		env: unknown
		constructor(_ctx: unknown, env: unknown) {
			this.env = env
		}
	},
}))

describe('MenuSyncWorkflow (#74)', () => {
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

	it('sleeps until runAt when in the future, then wakes /resources/jobs/menu-sync', async () => {
		const runAt = new Date(Date.now() + 30_000).toISOString()
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response('{}', { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)
		const sleepUntil = vi.fn().mockResolvedValue(undefined)

		await new MenuSyncWorkflow({} as never, env).run(
			{
				payload: { runAt },
				timestamp: new Date(),
				instanceId: 'menu-sync-1',
				workflowName: 'menu-sync',
			},
			step(sleepUntil),
		)

		expect(sleepUntil).toHaveBeenCalledWith(
			'wait-until-menu-sync-due',
			new Date(runAt),
		)
		expect(fetchMock).toHaveBeenCalledWith(
			`https://app.example.com${MENU_SYNC_JOB_PATH}`,
			{ method: 'POST', headers: { Authorization: 'Bearer secret-token' } },
		)
	})

	it('drains immediately without sleeping when runAt is now/past, and surfaces 5xx for workflow retry', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response('down', { status: 503, statusText: 'Unavailable' }),
			)
		vi.stubGlobal('fetch', fetchMock)
		const sleepUntil = vi.fn()

		await expect(
			new MenuSyncWorkflow({} as never, env).run(
				{
					payload: { runAt: new Date(Date.now() - 1_000).toISOString() },
					timestamp: new Date(),
					instanceId: 'menu-sync-2',
					workflowName: 'menu-sync',
				},
				step(sleepUntil),
			),
		).rejects.toThrow(/503/)
		expect(sleepUntil).not.toHaveBeenCalled()
	})
})
