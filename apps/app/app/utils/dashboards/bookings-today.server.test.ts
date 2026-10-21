import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	inArray,
	OrganizationLocation,
	OrganizationRole,
} from '@repo/database'
import {
	RESERVATIONS_FLAG_KEYS,
	RESERVATIONS_PERMISSIONS as P,
} from '@repo/reservations'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

import { setMemberLocationScope } from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loadBookingsTodayAccess } from './bookings-today.server.ts'

const flagIds: string[] = []

async function enableReservations(organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: RESERVATIONS_FLAG_KEYS.enabled,
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

afterEach(async () => {
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

async function createLocation(organizationId: string, name: string) {
	const slug = `loc-${crypto.randomUUID().slice(0, 8)}`
	const [row] = await db
		.insert(OrganizationLocation)
		.values({ organizationId, name, slug })
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
	await db.insert(_OrganizationPermissionToRole).values(
		permissions.map((permission) => ({
			A: role!.id,
			B: `org_perm_${permission.replaceAll(':', '_')}`,
		})),
	)
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId, role!.id)
	return user
}

describe('loadBookingsTodayAccess', () => {
	it('is unavailable while reservations.enabled is off', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await createLocation(organization.id, 'Main')
		const user = await member(organization.id, [P.READ_RESERVATION])
		const access = await loadBookingsTodayAccess({
			userId: user.id,
			organizationId: organization.id,
		})
		expect(access).toEqual({ available: false, locations: [] })
	})

	it('is unavailable without the reservation read grant', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		await createLocation(organization.id, 'Main')
		const user = await member(organization.id, [P.READ_RESERVATION_GUEST])
		const access = await loadBookingsTodayAccess({
			userId: user.id,
			organizationId: organization.id,
		})
		expect(access.available).toBe(false)
		expect(access.locations).toEqual([])
	})

	it('offers the block with the locations the member may read', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const main = await createLocation(organization.id, 'Main')
		await createLocation(organization.id, 'Harbor')
		const user = await member(organization.id, [P.READ_RESERVATION])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [main] },
		})
		const access = await loadBookingsTodayAccess({
			userId: user.id,
			organizationId: organization.id,
		})
		expect(access.available).toBe(true)
		expect(access.locations).toEqual([{ id: main, name: 'Main' }])
	})

	it('shows the location name in the site language, never the raw name map', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableReservations(organization.id)
		const id = await createLocation(
			organization.id,
			JSON.stringify({ en: 'Downtown', ar: 'وسط المدينة' }),
		)
		const user = await member(organization.id, [P.READ_RESERVATION])
		const access = await loadBookingsTodayAccess({
			userId: user.id,
			organizationId: organization.id,
		})
		expect(access.locations).toEqual([{ id, name: 'Downtown' }])
	})
})
