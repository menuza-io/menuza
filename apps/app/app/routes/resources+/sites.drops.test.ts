import type * as DatabaseModule from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	drizzleOperator,
	drizzleTable,
	mockDb,
	mockSelectResults,
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
		OrganizationDropPickupWindow: drizzleTable,
		OrganizationLocation: drizzleTable,
		OrganizationMediaAsset: drizzleTable,
		and: drizzleOperator,
		asc: drizzleOperator,
		desc: drizzleOperator,
		eq: drizzleOperator,
		inArray: drizzleOperator,
		ne: drizzleOperator,
	}
})

const request = new Request(
	'https://app.example/resources/sites/drops?slug=cafe',
)

const NOW = new Date('2026-10-07T12:00:00Z')

function dropRow(
	overrides: Partial<{
		id: string
		title: string
		slug: string
		description: string | null
		coverImageKey: string | null
		coverImageUrl: string | null
		status: string
		visibility: string
		ordersOpenAt: Date | null
		ordersCloseAt: Date | null
	}>,
) {
	return {
		id: overrides.slug ?? 'drop',
		title: 'Drop',
		slug: 'drop',
		description: null,
		coverImageKey: null,
		coverImageUrl: null,
		status: 'live',
		visibility: 'public',
		ordersOpenAt: null,
		ordersCloseAt: null,
		...overrides,
	}
}

describe('public drop discovery', () => {
	beforeEach(() => {
		resetMockDb()
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		findOrg.mockReset().mockResolvedValue({ id: 'cafe-id' })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('returns only published public drops, with derived phases and pickup facts', async () => {
		mockSelectResults(
			[
				dropRow({
					title: 'Weekend',
					slug: 'weekend',
					status: 'scheduled',
					coverImageKey: 'media-1',
					ordersOpenAt: new Date('2020-01-01T00:00:00Z'),
					ordersCloseAt: new Date('2026-10-09T13:15:00Z'),
				}),
				dropRow({
					title: 'Invite only',
					slug: 'invite',
					status: 'live',
					visibility: 'unlisted',
				}),
				dropRow({ title: 'Unpublished', slug: 'draft', status: 'draft' }),
			],
			[
				{
					dropId: 'weekend',
					date: '2026-10-10',
					locationName: 'Eastside Market',
					timezone: 'America/Chicago',
				},
				{
					dropId: 'weekend',
					date: '2026-10-09',
					locationName: 'Baxter Village',
					timezone: 'America/Chicago',
				},
				{
					dropId: 'weekend',
					date: '2026-10-09',
					locationName: 'Baxter Village',
					timezone: 'America/Chicago',
				},
			],
			[
				{
					id: 'media-1',
					objectKey: 'org/cafe/cover.jpg',
					updatedAt: new Date('2026-01-01T00:00:00Z'),
				},
			],
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
					coverImageUrl: `/resources/images?mediaId=media-1&v=${new Date('2026-01-01T00:00:00Z').getTime()}`,
					status: 'live',
					ordersOpenAt: '2020-01-01T00:00:00.000Z',
					ordersCloseAt: '2026-10-09T13:15:00.000Z',
					pickupDates: ['2026-10-09', '2026-10-10'],
					pickupLocationNames: ['Eastside Market', 'Baxter Village'],
					pickupTimezone: 'America/Chicago',
				},
			],
		})
	})

	it('orders live, then upcoming by open time, then ended by close time', async () => {
		mockSelectResults(
			[
				dropRow({
					slug: 'ended-old',
					status: 'closed',
					ordersCloseAt: new Date('2026-09-01T00:00:00Z'),
				}),
				dropRow({
					slug: 'upcoming-later',
					status: 'scheduled',
					ordersOpenAt: new Date('2026-10-20T00:00:00Z'),
				}),
				dropRow({
					slug: 'live-closing-later',
					status: 'live',
					ordersOpenAt: new Date('2026-10-01T00:00:00Z'),
					ordersCloseAt: new Date('2026-10-12T00:00:00Z'),
				}),
				dropRow({
					slug: 'ended-recent',
					status: 'live',
					ordersOpenAt: new Date('2026-09-20T00:00:00Z'),
					ordersCloseAt: new Date('2026-10-05T00:00:00Z'),
				}),
				dropRow({
					slug: 'upcoming-soon',
					status: 'scheduled',
					ordersOpenAt: new Date('2026-10-09T00:00:00Z'),
				}),
				dropRow({
					slug: 'live-closing-soon',
					status: 'live',
					ordersOpenAt: new Date('2026-10-01T00:00:00Z'),
					ordersCloseAt: new Date('2026-10-08T00:00:00Z'),
				}),
			],
			[],
			[],
		)
		const response = await loader({ request } as any)
		const body = (await response.json()) as {
			drops: Array<{ slug: string; status: string }>
		}
		expect(body.drops.map((drop) => drop.slug)).toEqual([
			'live-closing-soon',
			'live-closing-later',
			'upcoming-soon',
			'upcoming-later',
			'ended-recent',
			'ended-old',
		])
		expect(body.drops.map((drop) => drop.status)).toEqual([
			'live',
			'live',
			'scheduled',
			'scheduled',
			'closed',
			'closed',
		])
	})

	it('returns an empty list without pickup facts when nothing is discoverable', async () => {
		mockSelectResults([
			dropRow({ slug: 'draft', status: 'draft' }),
			dropRow({ slug: 'hidden', visibility: 'unlisted' }),
		])
		const response = await loader({ request } as any)
		expect(await response.json()).toEqual({ drops: [] })
		expect(mockDb.select).toHaveBeenCalledTimes(1)
	})

	it('rejects unpublished organizations', async () => {
		findOrg.mockResolvedValue(null)
		await expect(loader({ request } as any)).rejects.toMatchObject({
			status: 404,
		})
		expect(mockDb.select).not.toHaveBeenCalled()
	})
})
