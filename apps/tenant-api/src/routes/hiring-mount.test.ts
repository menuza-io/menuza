import { describe, expect, it } from 'vitest'
import { createTenantApiApp } from '../app.ts'

describe('hiring routes in the shared app', () => {
	const app = createTenantApiApp()

	it('mounts the public application route (and refuses an anonymous call with no Origin)', async () => {
		const reply = await app.request('/careers/apply', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		expect(reply.status).toBe(404)
		expect(await reply.json()).toEqual({ error: 'not_found' })
	})

	it('has no public read route for applicants', async () => {
		for (const path of ['/careers/applications', '/careers/apply']) {
			const reply = await app.request(path, { method: 'GET' })
			expect(reply.status).toBe(404)
		}
	})

	it('mounts the operator pipeline behind a token', async () => {
		const reply = await app.request('/operator/hiring/applications')
		expect(reply.status).toBe(401)
	})
})
