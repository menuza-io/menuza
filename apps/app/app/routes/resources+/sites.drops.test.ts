import type * as DatabaseModule from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	drizzleOperator,
	drizzleTable,
	mockDb,
	queryChain,
	resetMockDb,
} from '#tests/setup/drizzle-mock.ts'
import { loader } from './sites.drops.ts'

const findOrg = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/rate-limit.server.ts', () => ({
	PUBLIC_SITE_RATE_LIMIT: {},
	checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
	createRateLimitResponse: vi.fn(),
}))

vi.mock('@repo/security', () => ({
	getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}))

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	return {
		...actual,
		db: {
			...mockDb,
			query: { Organization: { findFirst: findOrg } },
		},
		Organization: drizzleTable,
		OrganizationDrop: drizzleTable,
		and: drizzleOperator,
		desc: drizzleOperator,
		eq: drizzleOperator,
		inArray: drizzleOperator,
		ne: drizzleOperator,
	}
})

const request = new Request(
	'https://app.example/resources/sites/drops?slug=cafe',
)

describe('public drop discovery', () => {
	beforeEach(() => {
		resetMockDb()
		findOrg.mockReset().mockResolvedValue({ id: 'cafe-id' })
	})

	it('returns only published public drops, with derived phases', async () => {
		mockDb.select.mockImplementation(() =>
			queryChain([
				{
					title: 'Weekend',
					slug: 'weekend',
					description: null,
					coverImageUrl: null,
					status: 'scheduled',
					visibility: 'public',
					ordersOpenAt: new Date('2020-01-01T00:00:00Z'),
					ordersCloseAt: null,
				},
				{
					title: 'Invite only',
					slug: 'invite',
					description: null,
					coverImageUrl: null,
					status: 'live',
					visibility: 'unlisted',
					ordersOpenAt: null,
					ordersCloseAt: null,
				},
				{
					title: 'Unpublished',
					slug: 'draft',
					description: null,
					coverImageUrl: null,
					status: 'draft',
					visibility: 'public',
					ordersOpenAt: null,
					ordersCloseAt: null,
				},
			]),
		)
		const response = await loader({ request } as any)
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(await response.json()).toEqual({
			drops: [
				{
					title: 'Weekend',
					slug: 'weekend',
					description: null,
					coverImageUrl: null,
					status: 'live',
				},
			],
		})
	})

	it('rejects unpublished organizations', async () => {
		findOrg.mockResolvedValue(null)
		await expect(loader({ request } as any)).rejects.toMatchObject({
			status: 404,
		})
		expect(mockDb.select).not.toHaveBeenCalled()
	})
})
