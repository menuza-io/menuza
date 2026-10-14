import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as dsar from '#app/utils/staffing/dsar.server.ts'
import {
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { loader } from './download-user-data.tsx'

const staff = vi.hoisted(() => ({ collect: vi.fn() }))
vi.mock('#app/utils/staffing/dsar.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof dsar>()
	return { ...actual, collectStaffExportsForUser: staff.collect }
})

beforeEach(() => {
	staff.collect.mockReset().mockResolvedValue([])
})

async function download() {
	const user = await createTestUser()
	const { cookie } = await createTestSession(user.id)
	const url = new URL('http://localhost:3001/resources/download-user-data')
	const response = (await loader({
		request: createAuthenticatedRequest(url.toString(), {}, cookie),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/download-user-data',
	} as any)) as Response
	return { user, response }
}

describe('download-user-data and regional staff records', () => {
	it('adds the staff-record section to the export file', async () => {
		staff.collect.mockResolvedValue([
			{
				organizationId: 'org_1',
				organizationName: 'Joe’s Diner',
				status: 'regional_delivery_required',
				note: 'Ask the organization administrators.',
			},
		])
		const { user, response } = await download()
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toContain('no-store')
		const body = (await response.json()) as Record<string, any>
		expect(staff.collect).toHaveBeenCalledWith(user.id)
		expect(body.userId).toBe(user.id)
		expect(body.staffRecords).toEqual([
			expect.objectContaining({
				organizationId: 'org_1',
				status: 'regional_delivery_required',
			}),
		])
	})

	it('always carries the section, empty when there is nothing to attach', async () => {
		const { response } = await download()
		const body = (await response.json()) as Record<string, any>
		expect(body.staffRecords).toEqual([])
	})
})
