import {
	and,
	ConfigFlag,
	db,
	eq,
	GbpListingIssue,
	GbpLocationSync,
	GbpSyncEvent,
	Integration,
	OrganizationLocation,
	UserOrganization,
	UserOrganizationLocation,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import { loadAttention } from '#app/utils/dashboards/attention.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './locations_.$locationId.google.ts'

async function enableFlag(organizationId: string, key: string) {
	await db.insert(ConfigFlag).values({
		key,
		level: 'organization',
		organizationId,
		value: true,
	})
}

async function seedTwoLocations(organizationId: string) {
	const [locA, locB] = await db
		.insert(OrganizationLocation)
		.values([
			{
				organizationId,
				name: 'Location A',
				slug: `loc-a-${crypto.randomUUID().slice(0, 6)}`,
				timezone: 'America/New_York',
				isActive: true,
				isDefault: true,
			},
			{
				organizationId,
				name: 'Location B',
				slug: `loc-b-${crypto.randomUUID().slice(0, 6)}`,
				timezone: 'America/New_York',
				isActive: true,
				isDefault: false,
			},
		])
		.returning()
	return { locA: locA!, locB: locB! }
}

async function linkLocation(organizationId: string, locationId: string) {
	const [integration] = await db
		.insert(Integration)
		.values({
			organizationId,
			organizationLocationId: locationId,
			providerName: 'google-business-profile',
			providerType: 'reviews',
			isActive: true,
			config: JSON.stringify({
				googleAccountName: 'accounts/1',
				googleLocationName: `locations/${locationId}`,
			}),
		})
		.returning()
	const [sync] = await db
		.insert(GbpLocationSync)
		.values({
			organizationId,
			organizationLocationId: locationId,
			integrationId: integration!.id,
			googleLocationName: `locations/${locationId}`,
			syncEnabled: true,
			fieldsSynced: JSON.stringify(['name', 'hours', 'phone']),
			state: 'ok',
			verificationState: 'verified',
		})
		.returning()
	return { integration: integration!, sync: sync! }
}

describe('locations_.$locationId.google route & GBP attention detectors', () => {
	it('returns { enabled: false } when gbp.sync flag is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const { locA } = await seedTwoLocations(organization.id)

		const request = createAuthenticatedRequest(
			`https://app.test/${organization.slug}/settings/locations/${locA.id}/google`,
			{ method: 'GET' },
			cookie,
		)
		const response = await loader({
			request,
			params: { orgSlug: organization.slug, locationId: locA.id },
			context: {},
		} as never)
		expect(response.status).toBe(200)
		const body = (await response.json()) as { enabled: boolean }
		expect(body.enabled).toBe(false)
	})

	it('returns 403 when a member scoped to location A accesses location B', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const { locA, locB } = await seedTwoLocations(organization.id)
		await enableFlag(organization.id, 'gbp.sync')

		const scopedUser = await createTestUser()
		await addOrganizationMember(
			scopedUser.id,
			organization.id,
			'org_role_admin',
		)
		await db
			.update(UserOrganization)
			.set({ locationScope: 'selected' })
			.where(
				and(
					eq(UserOrganization.userId, scopedUser.id),
					eq(UserOrganization.organizationId, organization.id),
				),
			)
		await db.insert(UserOrganizationLocation).values({
			userId: scopedUser.id,
			organizationId: organization.id,
			locationId: locA.id,
		})
		const { cookie } = await createTestSession(scopedUser.id)

		const request = createAuthenticatedRequest(
			`https://app.test/${organization.slug}/settings/locations/${locB.id}/google`,
			{ method: 'GET' },
			cookie,
		)
		let status = 200
		try {
			const res = await loader({
				request,
				params: { orgSlug: organization.slug, locationId: locB.id },
				context: {},
			} as never)
			status = getResponseStatus(res)
		} catch (thrown) {
			status = getResponseStatus(thrown)
		}
		expect(status).toBe(403)
	})

	it('loads linked sync state + issues and cleanly unlinks without FK violation', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const { locA } = await seedTwoLocations(organization.id)
		await enableFlag(organization.id, 'gbp.sync')
		const { sync } = await linkLocation(organization.id, locA.id)
		await db.insert(GbpListingIssue).values({
			syncId: sync.id,
			organizationId: organization.id,
			organizationLocationId: locA.id,
			field: 'phone',
			menuzaValue: JSON.stringify('+12125550100'),
			googleValue: JSON.stringify('+12125550199'),
			status: 'open',
		})

		const getReq = createAuthenticatedRequest(
			`https://app.test/${organization.slug}/settings/locations/${locA.id}/google`,
			{ method: 'GET' },
			cookie,
		)
		const getRes = await loader({
			request: getReq,
			params: { orgSlug: organization.slug, locationId: locA.id },
			context: {},
		} as never)
		expect(getRes.status).toBe(200)
		const data = (await getRes.json()) as {
			enabled: boolean
			linked: boolean
			issues: Array<{ field: string }>
		}
		expect(data.enabled).toBe(true)
		expect(data.linked).toBe(true)
		expect(data.issues).toHaveLength(1)
		expect(data.issues[0]?.field).toBe('phone')

		const postReq = createAuthenticatedRequest(
			`https://app.test/${organization.slug}/settings/locations/${locA.id}/google`,
			{
				method: 'POST',
				body: new URLSearchParams({ intent: 'unlink-google' }),
			},
			cookie,
		)
		const postRes = await action({
			request: postReq,
			params: { orgSlug: organization.slug, locationId: locA.id },
			context: {},
		} as never)
		expect(postRes.status).toBe(200)

		const remainingSync = await db
			.select()
			.from(GbpLocationSync)
			.where(eq(GbpLocationSync.organizationLocationId, locA.id))
		expect(remainingSync).toHaveLength(0)

		const unlinkEvents = await db
			.select()
			.from(GbpSyncEvent)
			.where(
				and(
					eq(GbpSyncEvent.organizationLocationId, locA.id),
					eq(GbpSyncEvent.kind, 'unlink'),
				),
			)
		expect(unlinkEvents).toHaveLength(1)
		expect(unlinkEvents[0]?.syncId).toBeNull()
	})

	it('emits google_listing_status (urgent) and google_listing_issue (todo) attention items when gbp.sync is on', async () => {
		const { organization, user, cookie } = await setupTestOrgWithUser('admin')
		const { locA } = await seedTwoLocations(organization.id)
		const { sync } = await linkLocation(organization.id, locA.id)
		await db
			.update(GbpLocationSync)
			.set({ state: 'suspended' })
			.where(eq(GbpLocationSync.id, sync.id))
		await db.insert(GbpListingIssue).values({
			syncId: sync.id,
			organizationId: organization.id,
			organizationLocationId: locA.id,
			field: 'hours',
			menuzaValue: JSON.stringify('9-5'),
			googleValue: JSON.stringify('10-6'),
			status: 'open',
		})

		const req = createAuthenticatedRequest(
			`https://app.test/${organization.slug}`,
			{ method: 'GET' },
			cookie,
		)

		// Flag off -> neither detector emits
		const before = await loadAttention({
			userId: user.id,
			organization: { id: organization.id },
			request: req,
		})
		expect(
			before.items.filter(
				(i) =>
					i.kind === 'google_listing_status' ||
					i.kind === 'google_listing_issue',
			),
		).toHaveLength(0)

		// Flag on -> both detectors emit with ?tab=google links
		await enableFlag(organization.id, 'gbp.sync')
		const after = await loadAttention({
			userId: user.id,
			organization: { id: organization.id },
			request: req,
		})
		const statusItem = after.items.find(
			(i) => i.kind === 'google_listing_status',
		)
		const issueItem = after.items.find((i) => i.kind === 'google_listing_issue')
		expect(statusItem).toMatchObject({
			urgency: 'urgent',
			href: `/settings/locations/${locA.id}?tab=google`,
		})
		expect(issueItem).toMatchObject({
			urgency: 'todo',
			count: 1,
			href: `/settings/locations/${locA.id}?tab=google`,
		})
	})
})
