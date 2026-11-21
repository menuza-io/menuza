import { afterEach, describe, expect, it, vi } from 'vitest'
import { MENU_IMPORT_PATH, MenuImportWorkflow } from './menu-import-workflow'

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: class {
		env: unknown
		constructor(_ctx: unknown, env: unknown) {
			this.env = env
		}
	},
}))

describe('MenuImportWorkflow (#73)', () => {
	const env = {
		APP_BASE_URL: 'https://app.example.com/',
		INTERNAL_COMMAND_TOKEN: 'secret-token-value',
	}

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it('posts only importId to /resources/jobs/menu-import with bearer auth', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ success: true }), { status: 200 }),
			)
		vi.stubGlobal('fetch', fetchMock)

		const stepDo = vi.fn(
			async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
		)

		const workflow = new MenuImportWorkflow({} as never, env)
		await workflow.run(
			{
				payload: { importId: 'imp_12345678' },
				timestamp: new Date(),
				instanceId: 'menu-import-imp_12345678',
				workflowName: 'menu-import',
			},
			{ do: stepDo } as never,
		)

		expect(stepDo).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledWith(
			`https://app.example.com${MENU_IMPORT_PATH}`,
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer secret-token-value',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ importId: 'imp_12345678' }),
			},
		)
	})

	it('throws when the App job route returns non-OK so Workflow retries', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					new Response('err', { status: 500, statusText: 'Internal Error' }),
				),
		)
		const stepDo = vi.fn(
			async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
		)

		const workflow = new MenuImportWorkflow({} as never, env)
		await expect(
			workflow.run(
				{
					payload: { importId: 'imp_12345678' },
					timestamp: new Date(),
					instanceId: 'menu-import-imp_12345678',
					workflowName: 'menu-import',
				},
				{ do: stepDo } as never,
			),
		).rejects.toThrow('/resources/jobs/menu-import failed: 500')
	})
})
