import { describe, expect, it } from 'vitest'
import { createTenantApiApp } from './app.ts'

describe('Zod messages in tenant-api replies', () => {
	const app = createTenantApiApp()

	it('says "Required" for a missing field, as App and Admin do', async () => {
		const reply = await app.request('/auth/send-code', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		expect(reply.status).toBe(400)
		expect(await reply.json()).toEqual({ error: 'Required' })
	})
})
