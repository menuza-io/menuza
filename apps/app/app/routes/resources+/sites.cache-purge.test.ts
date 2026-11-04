import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	action,
	SITE_CACHE_PURGE_MAX_BODY_BYTES,
	SITE_CACHE_PURGE_RATE_LIMIT,
	SITE_MENUS_PURGE_RATE_LIMIT,
} from './sites.cache-purge.ts'

const kv = vi.hoisted(() => ({
	purge: vi.fn(async () => {}),
	bump: vi.fn(async () => true),
}))

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: kv.purge,
	bumpMenuCacheGeneration: kv.bump,
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
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
}

async function callAction(request: Request) {
	return action({ request, params: {}, context: {} } as never)
}

beforeEach(() => {
	kv.purge.mockClear()
	kv.bump.mockClear()
})

describe('POST /resources/sites/cache-purge', () => {
	it('returns 401 without internal auth', async () => {
		const res = await callAction(post({ organizationId: 'org_x' }, false))
		expect(res.status).toBe(401)
		const wrong = await callAction(
			new Request('http://localhost:3001/resources/sites/cache-purge', {
				method: 'POST',
				headers: { Authorization: 'Bearer not-the-token' },
				body: JSON.stringify({ scope: 'all-menus' }),
			}),
		)
		expect(wrong.status).toBe(401)
		expect(kv.purge).not.toHaveBeenCalled()
		expect(kv.bump).not.toHaveBeenCalled()
	})

	it('returns 400 on invalid body and 404 on unknown org', async () => {
		const bad = await callAction(post({ organizationId: '../bad' }))
		expect(bad.status).toBe(400)

		const both = await callAction(
			post({ organizationId: 'org_x', scope: 'all-menus' }),
		)
		expect(both.status).toBe(400)

		const notJson = await callAction(post('{nope'))
		expect(notJson.status).toBe(400)

		const missing = await callAction(
			post({ organizationId: 'org_nonexistent_123' }),
		)
		expect(missing.status).toBe(404)
	})

	it('refuses a body over the size cap before reading it as JSON', async () => {
		const res = await callAction(
			post({
				organizationId: 'org_x',
				padding: 'x'.repeat(SITE_CACHE_PURGE_MAX_BODY_BYTES),
			}),
		)
		expect(res.status).toBe(413)
		expect(kv.purge).not.toHaveBeenCalled()
	})

	it('purges KV for the organization slug and custom domain', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const res = await callAction(post({ organizationId: organization.id }))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		expect(kv.purge).toHaveBeenCalledWith(
			organization.id,
			organization.slug,
			organization.customDomain,
		)
	})

	it('rate limits purges per organization', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		for (let i = 0; i < SITE_CACHE_PURGE_RATE_LIMIT.maxRequests; i += 1) {
			const ok = await callAction(post({ organizationId: organization.id }))
			expect(ok.status).toBe(200)
		}
		const limited = await callAction(post({ organizationId: organization.id }))
		expect(limited.status).toBe(429)
		expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
		expect(kv.purge).toHaveBeenCalledTimes(
			SITE_CACHE_PURGE_RATE_LIMIT.maxRequests,
		)

		// Another organization has its own budget.
		const other = await setupTestOrgWithUser('admin')
		const res = await callAction(
			post({ organizationId: other.organization.id }),
		)
		expect(res.status).toBe(200)
	})

	it('starts a new menu generation for every organization, rate limited', async () => {
		const res = await callAction(post({ scope: 'all-menus' }))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ ok: true })
		expect(kv.bump).toHaveBeenCalledTimes(1)
		expect(kv.purge).not.toHaveBeenCalled()

		for (let i = 1; i < SITE_MENUS_PURGE_RATE_LIMIT.maxRequests; i += 1) {
			await callAction(post({ scope: 'all-menus' }))
		}
		const limited = await callAction(post({ scope: 'all-menus' }))
		expect(limited.status).toBe(429)
		expect(kv.bump).toHaveBeenCalledTimes(
			SITE_MENUS_PURGE_RATE_LIMIT.maxRequests,
		)
	})
})
