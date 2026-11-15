import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { action } from './jobs.restaurant-order-refunds-reconcile.ts'

const reconcile = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('#app/utils/restaurant-orders/refunds-reconcile.server.ts', () => ({
	reconcileRestaurantOrderRefunds: reconcile.run,
}))

function call(init: { method?: string; authorized?: boolean } = {}) {
	const url = new URL(
		'http://localhost:3001/resources/jobs/restaurant-order-refunds-reconcile',
	)
	return action({
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers:
				init.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/restaurant-order-refunds-reconcile',
	}) as Promise<Response>
}

const SUMMARY = {
	organizations: 2,
	refundsChecked: 3,
	refundsExecuted: 1,
	refundsReported: 2,
	skipped: 0,
	failedOrganizations: 0,
}

beforeEach(() => {
	reconcile.run.mockReset().mockResolvedValue(SUMMARY)
})

describe('jobs.restaurant-order-refunds-reconcile', () => {
	it('is POST only and needs the internal command token', async () => {
		expect((await call({ method: 'GET' })).status).toBe(405)
		let status = 0
		try {
			status = (await call({ authorized: false })).status
		} catch (error) {
			status = error instanceof Response ? error.status : 302
		}
		expect([401, 403]).toContain(status)
		expect(reconcile.run).not.toHaveBeenCalled()
	})

	it('runs the reconcile and answers with counts only', async () => {
		const response = await call()
		expect(response.status).toBe(200)
		const body = (await response.json()) as Record<string, unknown>
		expect(body).toEqual({ success: true, ...SUMMARY })
		for (const value of Object.values(body)) {
			expect(['number', 'boolean']).toContain(typeof value)
		}
	})

	it('reports success false when an organization failed', async () => {
		reconcile.run.mockResolvedValue({ ...SUMMARY, failedOrganizations: 1 })
		expect(await (await call()).json()).toMatchObject({ success: false })
	})
})
