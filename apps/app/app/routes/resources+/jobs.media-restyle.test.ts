import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { action } from './jobs.media-restyle.ts'

const service = vi.hoisted(() => ({
	processRestyleRun: vi.fn(async (_runId: string) => ({
		done: false,
		paused: false,
		resumeAt: null as Date | null,
		processed: 2,
	})),
	sweepRestyleRuns: vi.fn(async () => ({ swept: 1, pruned: 3 })),
}))
vi.mock('#app/utils/media/restyle/process.server.ts', () => service)

function call(
	init: { method?: string; authorized?: boolean; body?: string } = {},
) {
	const url = new URL('http://localhost:3001/resources/jobs/media-restyle')
	return action({
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers:
				init.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
			body: init.body,
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/media-restyle',
	}) as Promise<Response>
}

describe('jobs.media-restyle (#146)', () => {
	beforeEach(() => vi.clearAllMocks())

	it('is POST only and needs the internal token', async () => {
		expect((await call({ method: 'GET' })).status).toBe(405)
		await expect(call({ authorized: false })).rejects.toBeTruthy()
		await expect(
			call({
				authorized: false,
				body: JSON.stringify({ runId: 'run12345678' }),
			}),
		).rejects.toBeTruthy()
		expect(service.sweepRestyleRuns).not.toHaveBeenCalled()
		expect(service.processRestyleRun).not.toHaveBeenCalled()
	})

	it('an empty body is the sweep', async () => {
		expect(await (await call()).json()).toEqual({
			success: true,
			swept: 1,
			pruned: 3,
		})
		expect(service.processRestyleRun).not.toHaveBeenCalled()
	})

	it('a run id processes that run and answers the batch result', async () => {
		const response = await call({
			body: JSON.stringify({ runId: 'run_1234567890' }),
		})
		expect(await response.json()).toEqual({
			success: true,
			runId: 'run_1234567890',
			done: false,
			paused: false,
			resumeAt: null,
			processed: 2,
		})
		expect(service.processRestyleRun).toHaveBeenCalledWith('run_1234567890')
	})

	it('tells the workflow when to come back after the daily budget', async () => {
		service.processRestyleRun.mockResolvedValueOnce({
			done: false,
			paused: true,
			resumeAt: new Date('2026-11-22T00:00:00.000Z'),
			processed: 0,
		})
		const body = await (
			await call({ body: JSON.stringify({ runId: 'run12345678' }) })
		).json()
		expect(body).toMatchObject({
			paused: true,
			resumeAt: '2026-11-22T00:00:00.000Z',
			processed: 0,
		})
	})

	it('answers 503 for a passing problem, so the workflow retries', async () => {
		service.processRestyleRun.mockResolvedValueOnce({
			done: false,
			paused: false,
			resumeAt: null,
			processed: 0,
			retry: true,
		} as never)
		const response = await call({
			body: JSON.stringify({ runId: 'run12345678' }),
		})
		expect(response.status).toBe(503)
		expect(await response.json()).toMatchObject({ success: false, retry: true })
	})

	it('refuses a malformed id or body', async () => {
		expect(
			(await call({ body: JSON.stringify({ runId: '../x' }) })).status,
		).toBe(400)
		expect(
			(await call({ body: JSON.stringify({ runId: 'a b c d e f g h' }) }))
				.status,
		).toBe(400)
		expect((await call({ body: '{nope' })).status).toBe(400)
		expect(service.processRestyleRun).not.toHaveBeenCalled()
	})
})
