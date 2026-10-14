import {
	and,
	db,
	eq,
	OrganizationLocation,
	UserOrganization,
	UserOrganizationLocation,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'

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

import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	listMemberLocationAccess,
	listScopableLocations,
	resolveLocationGrantIds,
	setMemberLocationScope,
} from './location-scope.server.ts'

async function createLocation(organizationId: string, isActive = true) {
	const slug = `loc-${crypto.randomUUID().slice(0, 8)}`
	const [row] = await db
		.insert(OrganizationLocation)
		.values({ organizationId, name: `Location ${slug}`, slug, isActive })
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

async function member(organizationId: string) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId)
	return user.id
}

describe('resolveLocationGrantIds', () => {
	it('is every location (null) for a member nobody has restricted', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		expect(await resolveLocationGrantIds(user.id, organization.id)).toBeNull()
	})

	it('returns exactly the selected locations, sorted', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const [a, b, c] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const userId = await member(organization.id)
		const saved = await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [c, a] },
		})
		expect(saved.ok).toBe(true)
		expect(await resolveLocationGrantIds(userId, organization.id)).toEqual(
			[a, c].sort(),
		)
		expect(b).toBeTruthy()
	})

	it('treats "selected" with nothing chosen as no locations, not all', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const userId = await member(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [] },
		})
		expect(await resolveLocationGrantIds(userId, organization.id)).toEqual([])
	})

	it('fails closed for an unknown stored scope', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const userId = await member(organization.id)
		await db
			.update(UserOrganization)
			.set({ locationScope: 'everything' })
			.where(
				and(
					eq(UserOrganization.userId, userId),
					eq(UserOrganization.organizationId, organization.id),
				),
			)
		expect(await resolveLocationGrantIds(userId, organization.id)).toEqual([])
		const access = await listMemberLocationAccess(organization.id)
		expect(access.get(userId)?.scope).toBe('selected')
	})

	it('gives an inactive or unknown membership no locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const userId = await member(organization.id)
		await db
			.update(UserOrganization)
			.set({ active: false })
			.where(eq(UserOrganization.userId, userId))
		expect(await resolveLocationGrantIds(userId, organization.id)).toEqual([])
		expect(await resolveLocationGrantIds('nobody', organization.id)).toEqual([])
	})

	it('is per organization: a member scoped in one org is unrestricted in another only if that org says so', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		const locationA = await createLocation(a.organization.id)
		const user = await createTestUser()
		await addOrganizationMember(user.id, a.organization.id)
		await addOrganizationMember(user.id, b.organization.id)
		await setMemberLocationScope({
			organizationId: a.organization.id,
			userId: user.id,
			value: { scope: 'selected', locationIds: [locationA] },
		})
		expect(await resolveLocationGrantIds(user.id, a.organization.id)).toEqual([
			locationA,
		])
		expect(await resolveLocationGrantIds(user.id, b.organization.id)).toBeNull()
	})

	it('never returns a location that belongs to another organization', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		const own = await createLocation(a.organization.id)
		const foreign = await createLocation(b.organization.id)
		const userId = await member(a.organization.id)
		// A row written around the app (a bug or a hand edit) still cannot leak
		// another organization's location id into the token.
		await db.insert(UserOrganizationLocation).values([
			{ userId, organizationId: a.organization.id, locationId: own },
			{ userId, organizationId: a.organization.id, locationId: foreign },
		])
		await db
			.update(UserOrganization)
			.set({ locationScope: 'selected' })
			.where(eq(UserOrganization.userId, userId))
		expect(await resolveLocationGrantIds(userId, a.organization.id)).toEqual([
			own,
		])
		const access = await listMemberLocationAccess(a.organization.id)
		expect(access.get(userId)?.locationIds).toEqual([own])
	})

	it('drops access to a location that is deleted, leaving none rather than all', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const only = await createLocation(organization.id)
		const userId = await member(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [only] },
		})
		await db
			.delete(OrganizationLocation)
			.where(eq(OrganizationLocation.id, only))
		expect(await resolveLocationGrantIds(userId, organization.id)).toEqual([])
	})
})

describe('setMemberLocationScope', () => {
	it('replaces the previous selection and reports what it replaced', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const [a, b] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const userId = await member(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [a] },
		})
		const second = await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [b] },
		})
		expect(second).toMatchObject({
			ok: true,
			previous: { scope: 'selected', locationIds: [a] },
			next: { scope: 'selected', locationIds: [b] },
		})
		expect(await resolveLocationGrantIds(userId, organization.id)).toEqual([b])
	})

	it('going back to "all" clears the stored locations', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const userId = await member(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [a] },
		})
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'all', locationIds: [] },
		})
		expect(await resolveLocationGrantIds(userId, organization.id)).toBeNull()
		const rows = await db
			.select()
			.from(UserOrganizationLocation)
			.where(eq(UserOrganizationLocation.userId, userId))
		expect(rows).toEqual([])
	})

	it('refuses a location id from another organization and changes nothing', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		const own = await createLocation(a.organization.id)
		const foreign = await createLocation(b.organization.id)
		const userId = await member(a.organization.id)
		const result = await setMemberLocationScope({
			organizationId: a.organization.id,
			userId,
			value: { scope: 'selected', locationIds: [own, foreign] },
		})
		expect(result).toEqual({ ok: false, reason: 'unknown_location' })
		expect(await resolveLocationGrantIds(userId, a.organization.id)).toBeNull()
	})

	it('refuses an invented location id', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const userId = await member(organization.id)
		expect(
			await setMemberLocationScope({
				organizationId: organization.id,
				userId,
				value: { scope: 'selected', locationIds: ['not-a-location'] },
			}),
		).toEqual({ ok: false, reason: 'unknown_location' })
	})

	it('refuses someone who is not a member of the organization', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		expect(
			await setMemberLocationScope({
				organizationId: a.organization.id,
				userId: b.user.id,
				value: { scope: 'selected', locationIds: [] },
			}),
		).toEqual({ ok: false, reason: 'member_not_found' })
		// And b's own membership is untouched.
		expect(
			await resolveLocationGrantIds(b.user.id, b.organization.id),
		).toBeNull()
	})
})

describe('listScopableLocations', () => {
	it('lists only this organization’s active locations', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		const active = await createLocation(a.organization.id)
		await createLocation(a.organization.id, false)
		await createLocation(b.organization.id)
		const listed = await listScopableLocations(a.organization.id)
		expect(listed.map((row) => row.id)).toEqual([active])
	})
})
