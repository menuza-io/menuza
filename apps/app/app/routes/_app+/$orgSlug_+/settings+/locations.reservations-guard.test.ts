import { db, eq, Organization, OrganizationLocation } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
	getResponseStatus,
} from '#tests/test-utils.ts'
import { action as editAction } from './locations.$locationId.tsx'
import { action as indexAction } from './locations._index.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))
vi.mock('#app/utils/phone-agent/phone-agent.server.ts', () => ({
	deleteScopeData: vi.fn(),
}))

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('#app/utils/reservations/regional-internal.server.ts', () => ({
	postRegionalReservationsInternal: regional.post,
}))

beforeEach(() => {
	regional.post.mockReset()
})

async function setup() {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id)
	const { cookie } = await createTestSession(user.id)
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true, dataRegion: 'us' })
		.where(eq(Organization.id, organization.id))
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Uptown Bistro',
			slug: 'uptown-bistro',
			timezone: 'America/New_York',
			isActive: true,
			isDefault: false,
		})
		.returning()

	return {
		organization,
		location: location!,
		cookie,
		deleteInDetail: async () => {
			const url = new URL(
				`http://localhost:3001/${organization.slug}/settings/locations/${location!.id}`,
			)
			return editAction({
				request: createAuthenticatedRequest(
					url.toString(),
					{
						method: 'POST',
						body: new URLSearchParams({ intent: 'delete-location' }),
					},
					cookie,
				),
				params: { orgSlug: organization.slug, locationId: location!.id },
				context: new RouterContextProvider(),
				url,
				pattern: '/:orgSlug/settings/locations/:locationId',
			}) as Promise<Response>
		},
		deleteInIndex: async () => {
			const url = new URL(
				`http://localhost:3001/${organization.slug}/settings/locations`,
			)
			return indexAction({
				request: createAuthenticatedRequest(
					url.toString(),
					{
						method: 'POST',
						body: new URLSearchParams({
							intent: 'delete-location',
							locationId: location!.id,
						}),
					},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: new RouterContextProvider(),
				url,
				pattern: '/:orgSlug/settings/locations',
			}) as Promise<Response>
		},
	}
}

describe('location delete guard (VAL-BOOK-031)', () => {
	it('blocks deleting a location on locations.$locationId when active future reservations exist, then allows deletion once zero remain', async () => {
		const { organization, location, deleteInDetail } = await setup()
		regional.post.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					locationId: location.id,
					futureReservations: 3,
					activeFutureReservations: 3,
					activeWaitlist: 0,
					activeHolds: 0,
					tables: 8,
					canDelete: false,
				}),
				{ status: 200 },
			),
		)

		const blocked = await deleteInDetail()
		expect(getResponseStatus(blocked)).toBe(409)
		const body = (await blocked.json()) as {
			error: string
			futureReservations: number
		}
		expect(body.futureReservations).toBe(3)
		expect(body.error).toContain('3 active future reservations')

		const [stillThere] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, location.id))
		expect(stillThere).toBeDefined()

		// Now zero future reservations remain
		regional.post.mockResolvedValue(
			new Response(
				JSON.stringify({
					locationId: location.id,
					futureReservations: 0,
					activeFutureReservations: 0,
					activeWaitlist: 0,
					activeHolds: 0,
					tables: 8,
					canDelete: true,
				}),
				{ status: 200 },
			),
		)

		const deleted = await deleteInDetail()
		expect(getResponseStatus(deleted)).toBe(302)
		const [gone] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, location.id))
		expect(gone).toBeUndefined()
		expect(regional.post).toHaveBeenCalledWith(
			expect.objectContaining({
				dataRegion: 'us',
				path: 'location-summary',
				body: { orgId: organization.id, locationId: location.id },
			}),
		)
	})

	it('also blocks deleting a location on locations._index when active future reservations exist', async () => {
		const { location, deleteInIndex } = await setup()
		regional.post.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					locationId: location.id,
					futureReservations: 1,
					activeFutureReservations: 1,
					canDelete: false,
				}),
				{ status: 200 },
			),
		)

		const blocked = await deleteInIndex()
		expect(getResponseStatus(blocked)).toBe(409)
		const body = (await blocked.json()) as {
			error: string
			futureReservations: number
		}
		expect(body.futureReservations).toBe(1)
		expect(body.error).toContain('1 active future reservation')

		const [stillThere] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, location.id))
		expect(stillThere).toBeDefined()
	})

	it('fails closed with 503 when regional tenant-api is unreachable during location delete', async () => {
		const { location, deleteInDetail } = await setup()
		regional.post.mockRejectedValueOnce(new Error('ECONNREFUSED'))

		const blocked = await deleteInDetail()
		expect(getResponseStatus(blocked)).toBe(503)
		const [stillThere] = await db
			.select()
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, location.id))
		expect(stillThere).toBeDefined()
	})
})
