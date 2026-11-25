import { ENV } from 'varlock/env'
import { describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { loader } from './pos.flags.ts'

const flag = vi.hoisted(() => vi.fn(async (): Promise<unknown> => true))
vi.mock('@repo/common/feature-flags', () => ({ getFeatureFlag: flag }))

function get(orgId: string, authorization?: string) {
	return new Request(
		`http://localhost:3001/resources/pos/flags?orgId=${encodeURIComponent(orgId)}`,
		{ headers: authorization ? { Authorization: authorization } : {} },
	)
}
const call = (request: Request) =>
	loader({ request, params: {}, context: {} } as never)

describe('GET /resources/pos/flags', () => {
	it('refuses a request without the internal token', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		expect((await call(get(organization.id))).status).toBe(401)
		expect((await call(get(organization.id, 'Bearer nope'))).status).toBe(401)
	})

	it('says whether connection history is on, only for a literal true', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const auth = `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`
		flag.mockResolvedValueOnce(true)
		const on = await call(get(organization.id, auth))
		expect(on.headers.get('Cache-Control')).toBe('private, no-store')
		expect(await on.json()).toMatchObject({ deviceHealth: true })
		for (const value of ['true', 1, null, undefined]) {
			flag.mockResolvedValueOnce(value)
			expect(await (await call(get(organization.id, auth))).json()).toMatchObject({
				deviceHealth: false,
			})
		}
		expect(flag).toHaveBeenCalledWith('pos.device_health', {
			organizationId: organization.id,
		})
	})

	it('says whether cloud printers are on (kitchen.printers), only for a literal true', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const auth = `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`
		flag.mockImplementation(async (key: string) =>
			key === 'kitchen.printers' ? true : false,
		)
		expect(await (await call(get(organization.id, auth))).json()).toEqual({
			deviceHealth: false,
			printers: true,
		})
		flag.mockImplementation(async (key: string) =>
			key === 'kitchen.printers' ? ('true' as unknown) : false,
		)
		expect(await (await call(get(organization.id, auth))).json()).toEqual({
			deviceHealth: false,
			printers: false,
		})
		flag.mockImplementation(async () => true)
	})

	it('answers 400 for a malformed id and 404 for an unknown organization', async () => {
		const auth = `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`
		expect((await call(get('../x', auth))).status).toBe(400)
		expect((await call(get('org_nonexistent_123', auth))).status).toBe(404)
	})
})
