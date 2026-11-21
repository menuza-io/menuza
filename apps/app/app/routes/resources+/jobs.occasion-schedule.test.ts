import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	run: vi.fn(async () => ({
		organizations: 2,
		scheduled: 1,
		skipped: 1,
		failed: 0,
	})),
	wake: vi.fn(async () => true),
}))
vi.mock(
	'#app/utils/marketing/occasion-schedule.server.ts',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		runOccasionAutoSchedule: mocks.run,
		wakeOccasionWorkflow: mocks.wake,
	}),
)

import { action } from './jobs.occasion-schedule.ts'

function call(options: { authorized?: boolean; method?: string } = {}) {
	return action({
		request: new Request(
			'http://localhost:3001/resources/jobs/occasion-schedule',
			{
				method: options.method ?? 'POST',
				headers:
					options.authorized === false
						? {}
						: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
			},
		),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '',
	} as never) as Promise<Response>
}

describe('POST /resources/jobs/occasion-schedule (#152)', () => {
	it('needs the internal command token and only answers POST', async () => {
		await expect(call({ authorized: false })).rejects.toMatchObject({
			status: 401,
		})
		expect((await call({ method: 'GET' })).status).toBe(405)
		expect(mocks.run).not.toHaveBeenCalled()
	})

	it("runs the job, starts the next day's wake-up and reports counts only", async () => {
		const res = await call()
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			success: true,
			organizations: 2,
			scheduled: 1,
			skipped: 1,
			failed: 0,
			woken: true,
		})
		expect(mocks.wake).toHaveBeenCalledTimes(1)
		const [runAt] = mocks.wake.mock.calls[0] as unknown as [Date]
		expect(runAt.getTime()).toBeGreaterThan(Date.now())
		expect(runAt.getUTCHours()).toBe(6)
	})
})
