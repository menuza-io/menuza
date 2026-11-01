import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { action } from './sites.cache-purge.ts'

const purge = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: purge,
}))

function post(body: unknown, authorized = true) {
	return new Request('http://localhost:3001/resources/sites/cache-purge', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(authorized
				? { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }
				: {}),
		},
		body: JSON.stringify(body),
	})
}

async function callAction(request: Request) {
	return action({ request, params: {}, context: {} } as never)
}

describe('POST /resources/sites/cache-purge', () => {
	it('returns 403 without internal auth', async () => {
		const res = await callAction(post({ organizationId: 'org_x' }, false))
		expect(res.status).toBe(403)
		expect(purge).not.toHaveBeenCalled()
	})

	it('returns 400 on invalid body and 404 on unknown org', async () => {
		const bad = await callAction(post({ organizationId: '../bad' }))
		expect(bad.status).toBe(400)

		const missing = await callAction(
			post({ organizationId: 'org_nonexistent_123' }),
		)
		expect(missing.status).toBe(404)
	})

	it('purges KV for the organization slug and custom domain', async () => {
		purge.mockClear()
		const { organization } = await setupTestOrgWithUser('admin')
		const res = await callAction(post({ organizationId: organization.id }))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		expect(purge).toHaveBeenCalledWith(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
	})
})
