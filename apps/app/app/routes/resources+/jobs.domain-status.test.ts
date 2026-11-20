import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { describe, expect, it } from 'vitest'
import { action } from './jobs.domain-status.ts'

function args(options: { method?: string; token?: string | null }) {
	const url = new URL('http://localhost:3001/resources/jobs/domain-status')
	return {
		request: new Request(url, {
			method: options.method ?? 'POST',
			headers:
				options.token === null
					? {}
					: {
							Authorization: `Bearer ${options.token ?? ENV.INTERNAL_COMMAND_TOKEN}`,
						},
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/domain-status',
	}
}

describe('the domain status job route', () => {
	it('needs the internal command token', async () => {
		await expect(action(args({ token: null }))).rejects.toMatchObject({
			status: 401,
		})
		await expect(
			action(args({ token: 'wrong-wrong-wrong-wrong' })),
		).rejects.toMatchObject({ status: 401 })
	})

	it('only answers POST', async () => {
		const response = await action(args({ method: 'GET' }))
		expect(response.status).toBe(405)
	})

	it('runs every task and answers with counts only', async () => {
		const response = await action(args({}))
		expect(response.status).toBe(200)
		const body = (await response.json()) as Record<string, unknown>
		expect(body.success).toBe(true)
		for (const task of [
			'siteDomains',
			'nameservers',
			'registrations',
			'renewals',
			'forwarding',
			'senderDomains',
		]) {
			expect(body[task]).toBeTruthy()
		}
		expect(JSON.stringify(body)).not.toMatch(/@|\.com/u)
	})
})
