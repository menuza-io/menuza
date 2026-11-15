import {
	_OrganizationPermissionToRole,
	db,
	OrganizationLocation,
	OrganizationRole,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { NO_BOOKINGS_TODAY_ACCESS } from './bookings-today.ts'
import { loadHomeLocations, loadTodayAccess } from './today.server.ts'

async function createLocation(
	organizationId: string,
	name: string,
	timezone: string,
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name,
			slug: `loc-${crypto.randomUUID().slice(0, 8)}`,
			timezone,
		})
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

async function member(organizationId: string, permissions: string[]) {
	const [role] = await db
		.insert(OrganizationRole)
		.values({
			name: `Custom ${crypto.randomUUID().slice(0, 8)}`,
			description: '',
			level: 0,
			organizationId,
		})
		.returning({ id: OrganizationRole.id })
	if (permissions.length > 0) {
		await db.insert(_OrganizationPermissionToRole).values(
			permissions.map((permission) => ({
				A: role!.id,
				B: `org_perm_${permission.replaceAll(':', '_')}`,
			})),
		)
	}
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role!.id)
	return user
}

describe('loadHomeLocations', () => {
	it('lists active locations with their own time zones, scoped to the member', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const ny = await createLocation(
			organization.id,
			'New York',
			'America/New_York',
		)
		const ruh = await createLocation(organization.id, 'Riyadh', 'Asia/Riyadh')
		expect(await loadHomeLocations(user.id, organization.id)).toEqual(
			expect.arrayContaining([
				{ id: ny, name: 'New York', timeZone: 'America/New_York' },
				{ id: ruh, name: 'Riyadh', timeZone: 'Asia/Riyadh' },
			]),
		)

		const scoped = await member(organization.id, [])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: scoped.id,
			value: { scope: 'selected', locationIds: [ruh] },
		})
		expect(
			(await loadHomeLocations(scoped.id, organization.id)).map((l) => l.id),
		).toEqual([ruh])
	})
})

describe('loadTodayAccess', () => {
	it('shows the order tiles to members with report and menu access', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id, 'Main', 'America/New_York')
		const access = await loadTodayAccess({
			userId: user.id,
			organization: { ...organization, dataRegion: 'us' },
			bookingsToday: NO_BOOKINGS_TODAY_ACCESS,
			locations: await loadHomeLocations(user.id, organization.id),
		})
		expect(access).toMatchObject({
			available: true,
			orders: true,
			covers: false,
			tokenUrl: `/${organization.slug}/reports/token`,
		})
	})

	it('hides the Sales and Orders tiles without the order grant (never a zero)', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id, 'Main', 'America/New_York')
		for (const permissions of [
			[],
			// Menu access alone does not open reports.
			[ORG_PERMISSIONS.READ_MENU_ANY],
			// Report access without menu access does not cover orders.
			[ORG_PERMISSIONS.READ_ANALYTICS_ANY],
		]) {
			const viewer = await member(organization.id, permissions)
			const access = await loadTodayAccess({
				userId: viewer.id,
				organization: { ...organization, dataRegion: 'us' },
				bookingsToday: NO_BOOKINGS_TODAY_ACCESS,
				locations: await loadHomeLocations(viewer.id, organization.id),
			})
			expect(access.orders).toBe(false)
			expect(access.available).toBe(false)
		}
	})

	it('shows covers alone when only bookings are readable', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const location = await createLocation(organization.id, 'Main', 'UTC')
		const viewer = await member(organization.id, [])
		const access = await loadTodayAccess({
			userId: viewer.id,
			organization: { ...organization, dataRegion: 'us' },
			bookingsToday: {
				available: true,
				locations: [{ id: location, name: 'Main' }],
			},
			locations: await loadHomeLocations(viewer.id, organization.id),
		})
		expect(access).toMatchObject({
			available: true,
			orders: false,
			covers: true,
			coverLocationIds: [location],
			tenantApiUrl: null,
		})
	})
})
