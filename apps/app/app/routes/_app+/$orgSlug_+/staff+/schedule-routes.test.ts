import {
	_OrganizationPermissionToRole,
	ConfigFlag,
	db,
	eq,
	inArray,
	OrganizationLocation,
	Organization,
	OrganizationRole,
} from '@repo/database'
import {
	DEFAULT_SCOPE_ID,
	STAFFING_FLAG_KEYS,
	STAFFING_PERMISSIONS as P,
	type StaffingFeature,
} from '@repo/staffing'
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
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as gridLoader } from './schedule._index.tsx'
import { loader as availabilityLoader } from './schedule.availability.tsx'
import { loader as timeOffLoader } from './schedule.time-off.tsx'
import { loader as layoutLoader } from './schedule.tsx'

const flagIds: string[] = []

const locationIds: string[] = []

async function location(
	organizationId: string,
	name: string,
	address?: { country: string },
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name,
			slug: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`,
			timezone: 'America/Chicago',
			address: address ? JSON.stringify(address) : null,
		})
		.returning({ id: OrganizationLocation.id })
	locationIds.push(row!.id)
	return row!.id
}

async function setFlag(feature: StaffingFeature, organizationId: string) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({
			key: STAFFING_FLAG_KEYS[feature],
			value: true,
			level: 'organization',
			organizationId,
		})
		.returning({ id: ConfigFlag.id })
	flagIds.push(row!.id)
}

async function enableScheduling(organizationId: string) {
	await setFlag('enabled', organizationId)
	await setFlag('scheduling', organizationId)
}

async function memberWith(organizationId: string, permissions: string[]) {
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
	const { cookie } = await createTestSession(user.id)
	return { user, cookie }
}

const loaders = {
	grid: gridLoader,
	timeOff: timeOffLoader,
	availability: availabilityLoader,
} as const
type Name = keyof typeof loaders

async function call(
	name: Name,
	slug: string,
	cookie: string,
): Promise<number | { data: unknown }> {
	try {
		const data = await loaders[name]({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/staff/schedule`,
				{},
				cookie,
			),
			params: { orgSlug: slug },
			context: {},
		} as never)
		return { data }
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

const status = async (...args: Parameters<typeof call>) => {
	const result = await call(...args)
	return typeof result === 'number' ? result : 'ok'
}

const names = Object.keys(loaders) as Name[]

afterEach(async () => {
	if (locationIds.length) {
		await db
			.delete(OrganizationLocation)
			.where(inArray(OrganizationLocation.id, locationIds))
		locationIds.length = 0
	}
	if (flagIds.length) {
		await db.delete(ConfigFlag).where(inArray(ConfigFlag.id, flagIds))
		flagIds.length = 0
	}
})

describe('schedule route loaders', () => {
	it('are 404 while staffing or the scheduling flag is off', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		for (const name of names) {
			expect(await status(name, organization.slug, cookie)).toBe(404)
		}
		await setFlag('enabled', organization.id)
		for (const name of names) {
			expect(await status(name, organization.slug, cookie)).toBe(404)
		}
	})

	it('open for an admin once both flags are on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableScheduling(organization.id)
		for (const name of names) {
			expect(await status(name, organization.slug, cookie)).toBe('ok')
		}
	})

	it('are 403 for a member holding no staffing grants', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('member')
		await enableScheduling(organization.id)
		for (const name of names) {
			expect(await status(name, organization.slug, cookie)).toBe(403)
		}
	})

	it('need the roster grant too, because the grid names people from the roster', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableScheduling(organization.id)
		const onlySchedule = await memberWith(organization.id, [P.READ_SCHEDULE])
		for (const name of names) {
			expect(await status(name, organization.slug, onlySchedule.cookie)).toBe(
				403,
			)
		}
		const onlyRoster = await memberWith(organization.id, [P.READ_STAFF])
		for (const name of names) {
			expect(await status(name, organization.slug, onlyRoster.cookie)).toBe(403)
		}
		const both = await memberWith(organization.id, [
			P.READ_SCHEDULE,
			P.READ_STAFF,
		])
		for (const name of names) {
			expect(await status(name, organization.slug, both.cookie)).toBe('ok')
		}
	})

	it('keep the schedule closed while only the time clock flag is on', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await setFlag('enabled', organization.id)
		await setFlag('timeclock', organization.id)
		for (const name of names) {
			expect(await status(name, organization.slug, cookie)).toBe(404)
		}
	})

	it('do not open another organization to an admin of a different one', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		await enableScheduling(b.organization.id)
		for (const name of names) {
			expect(await status(name, b.organization.slug, a.cookie)).toBe(404)
		}
	})

	it('hand the screen only the one implicit workplace name and time zone, never staff', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableScheduling(organization.id)
		await db
			.update(Organization)
			.set({ staffingTimeZone: 'America/Chicago' })
			.where(eq(Organization.id, organization.id))
		const result = (await call('grid', organization.slug, cookie)) as {
			data: { scopes: unknown[] }
		}
		expect(result.data.scopes).toEqual([
			{
				id: DEFAULT_SCOPE_ID,
				name: organization.name,
				timeZone: 'America/Chicago',
			},
		])
		expect(Object.keys(result.data).sort()).toEqual(['orgSlug', 'scopes'])
	})

	it('limit a scoped manager to their locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableScheduling(organization.id)
		const a = await location(organization.id, 'Alpha')
		await location(organization.id, 'Beta')
		const manager = await memberWith(organization.id, [
			P.UPDATE_SCHEDULE,
			P.READ_STAFF,
		])
		await setMemberLocationScope({
			organizationId: organization.id,
			userId: manager.user.id,
			value: { scope: 'selected', locationIds: [a] },
		})
		for (const name of names) {
			const result = (await call(name, organization.slug, manager.cookie)) as {
				data: { scopes: Array<{ id: string }> }
			}
			expect(result.data.scopes.map((s) => s.id)).toEqual([a])
		}
	})

	it('give an organization with locations one scope per location, with its own time zone', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await enableScheduling(organization.id)
		const a = await location(organization.id, 'Alpha')
		const b = await location(organization.id, 'Beta')
		const result = (await call('grid', organization.slug, cookie)) as {
			data: { scopes: Array<{ id: string; timeZone: string }> }
		}
		expect(result.data.scopes.map((s) => s.id).sort()).toEqual([a, b].sort())
		expect(
			result.data.scopes.every((s) => s.timeZone === 'America/Chicago'),
		).toBe(true)
	})

	it('the layout offers tabs only to someone who can read names', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await enableScheduling(organization.id)
		const reader = await memberWith(organization.id, [P.READ_SCHEDULE])
		const withRoster = await memberWith(organization.id, [
			P.READ_SCHEDULE,
			P.READ_STAFF,
		])
		const call2 = async (cookie: string) =>
			(await layoutLoader({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${organization.slug}/staff/schedule`,
					{},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: {},
			} as never)) as { canSeeNames: boolean }
		expect((await call2(reader.cookie)).canSeeNames).toBe(false)
		expect((await call2(withRoster.cookie)).canSeeNames).toBe(true)
	})
})
