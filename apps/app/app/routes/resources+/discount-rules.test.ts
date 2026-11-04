import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { loader } from './discount-rules.ts'

const build = vi.hoisted(() =>
	vi.fn(async () => ({ promotions: [], discountRules: [] })),
)

vi.mock('#app/utils/discounts/order-context.server.ts', () => ({
	buildPublicMenuDiscounts: build,
}))

function get(orgId: string, authorization?: string) {
	return new Request(
		`http://localhost:3001/resources/discount-rules?orgId=${encodeURIComponent(orgId)}`,
		{ headers: authorization ? { Authorization: authorization } : {} },
	)
}

async function callLoader(request: Request) {
	return loader({ request, params: {}, context: {} } as never)
}

/**
 * Till rules for any organization go to whoever holds the internal token:
 * tenant-api checks the paired device secret before it calls this route, so
 * the token is the only gate here and it must hold.
 */
describe('GET /resources/discount-rules', () => {
	it('refuses a request without the internal token, or with a wrong one', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const missing = await callLoader(get(organization.id))
		expect(missing.status).toBe(401)
		const wrong = await callLoader(get(organization.id, 'Bearer nope'))
		expect(wrong.status).toBe(401)
		const unprefixed = await callLoader(
			get(organization.id, ENV.INTERNAL_COMMAND_TOKEN),
		)
		expect(unprefixed.status).toBe(401)
		expect(build).not.toHaveBeenCalled()
	})

	it('answers the rules to the internal token, without caching them', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const res = await callLoader(
			get(organization.id, `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`),
		)
		expect(res.status).toBe(200)
		expect(res.headers.get('Cache-Control')).toBe('private, no-store')
		expect(await res.json()).toEqual({ discountRules: [] })
		expect(build).toHaveBeenCalledWith(organization.id)
	})

	it('answers 400 for a malformed id and 404 for an unknown organization', async () => {
		const auth = `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`
		expect((await callLoader(get('../x', auth))).status).toBe(400)
		expect((await callLoader(get('org_nonexistent_123', auth))).status).toBe(
			404,
		)
	})
})
