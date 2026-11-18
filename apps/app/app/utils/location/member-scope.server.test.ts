import {
	and,
	db,
	eq,
	OrganizationLocation,
	OrganizationLocationTagLink,
	UserOrganization,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import { resolveDiscountLocationIds } from '#app/utils/discounts/location-scope.server.ts'
import { resolveLoyaltyLocationIds } from '#app/utils/loyalty/access.server.ts'
import { resolveReservationsLocationIds } from '#app/utils/reservations/access.server.ts'
import {
	resolveLocationGrantIds,
	setMemberLocationScope,
} from '#app/utils/staffing/restaurant/location-scope.server.ts'
import {
	addOrganizationMember,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { resolveMemberLocationIds } from './member-scope.server.ts'
import {
	createLocationTag,
	deleteLocationTag,
	listLocationTags,
	setTagLocations,
} from './tags.server.ts'

async function createLocation(organizationId: string, name = 'Place') {
	const slug = `loc-${crypto.randomUUID().slice(0, 8)}`
	const [row] = await db
		.insert(OrganizationLocation)
		.values({ organizationId, name: `${name} ${slug}`, slug })
		.returning({ id: OrganizationLocation.id })
	return row!.id
}

async function newMember(organizationId: string) {
	const user = await createTestUser()
	await addOrganizationMember(user.id, organizationId)
	return user.id
}

async function tag(organizationId: string, name: string) {
	const created = await createLocationTag(organizationId, name)
	if (!created.ok) throw new Error(created.error)
	return created.id
}

describe('resolveMemberLocationIds with tags (#374)', () => {
	it('a member granted a tag sees exactly that tag locations, including ones added later', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const [a, b, c] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const texas = await tag(organization.id, 'Texas')
		await setTagLocations(organization.id, texas, [a, b])
		const userId = await newMember(organization.id)
		const saved = await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [], tagIds: [texas] },
		})
		expect(saved.ok).toBe(true)

		expect(await resolveMemberLocationIds(userId, organization.id)).toEqual(
			[a, b].sort(),
		)

		// A location tagged afterwards is covered with no change to the member.
		await setTagLocations(organization.id, texas, [a, b, c])
		expect(await resolveMemberLocationIds(userId, organization.id)).toEqual(
			[a, b, c].sort(),
		)

		// Untagging takes it away again; nothing else changes.
		await setTagLocations(organization.id, texas, [a])
		expect(await resolveMemberLocationIds(userId, organization.id)).toEqual([a])
	})

	it('a location created and tagged later is covered the same way', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const first = await createLocation(organization.id)
		const texas = await tag(organization.id, 'Texas')
		await setTagLocations(organization.id, texas, [first])
		const userId = await newMember(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [], tagIds: [texas] },
		})
		const later = await createLocation(organization.id)
		await db.insert(OrganizationLocationTagLink).values({
			locationId: later,
			tagId: texas,
		})
		expect(await resolveMemberLocationIds(userId, organization.id)).toEqual(
			[first, later].sort(),
		)
	})

	it('combines explicit grants with tags and never repeats an id', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const [a, b, c] = [
			await createLocation(organization.id),
			await createLocation(organization.id),
			await createLocation(organization.id),
		]
		const group = await tag(organization.id, 'Group')
		await setTagLocations(organization.id, group, [a, b])
		const userId = await newMember(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [b, c], tagIds: [group] },
		})
		expect(await resolveMemberLocationIds(userId, organization.id)).toEqual(
			[a, b, c].sort(),
		)
	})

	it('a tag never widens an "all" or an unknown scope, and an empty selection stays empty', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const group = await tag(organization.id, 'Group')
		await setTagLocations(organization.id, group, [a])

		// Admin keeps "all".
		expect(await resolveMemberLocationIds(user.id, organization.id)).toBeNull()

		const userId = await newMember(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [], tagIds: [] },
		})
		expect(await resolveMemberLocationIds(userId, organization.id)).toEqual([])

		await db
			.update(UserOrganization)
			.set({ locationScope: 'everything' })
			.where(
				and(
					eq(UserOrganization.userId, userId),
					eq(UserOrganization.organizationId, organization.id),
				),
			)
		expect(await resolveMemberLocationIds(userId, organization.id)).toEqual([])
	})

	it('ignores a tag and its locations from another organization', async () => {
		const mine = await setupTestOrgWithUser('admin')
		const theirs = await setupTestOrgWithUser('admin')
		const theirLocation = await createLocation(theirs.organization.id)
		const theirTag = await tag(theirs.organization.id, 'Theirs')
		await setTagLocations(theirs.organization.id, theirTag, [theirLocation])
		const userId = await newMember(mine.organization.id)
		await setMemberLocationScope({
			organizationId: mine.organization.id,
			userId,
			value: { scope: 'selected', locationIds: [] },
		})
		// A crafted id of another organization's tag is refused, not stored.
		const refused = await setMemberLocationScope({
			organizationId: mine.organization.id,
			userId,
			value: { scope: 'selected', locationIds: [], tagIds: [theirTag] },
		})
		expect(refused).toEqual({ ok: false, reason: 'unknown_tag' })
		expect(await resolveMemberLocationIds(userId, mine.organization.id)).toEqual(
			[],
		)
	})

	it('deleting a tag removes the access it gave', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const group = await tag(organization.id, 'Group')
		await setTagLocations(organization.id, group, [a])
		const userId = await newMember(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [], tagIds: [group] },
		})
		expect(await resolveMemberLocationIds(userId, organization.id)).toEqual([a])
		expect(await deleteLocationTag(organization.id, group)).toEqual({ ok: true })
		expect(await resolveMemberLocationIds(userId, organization.id)).toEqual([])
		expect(await listLocationTags(organization.id)).toEqual([])
	})

	it('the staffing, reservations, loyalty and discounts resolvers all give the same answer', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const a = await createLocation(organization.id)
		const b = await createLocation(organization.id)
		const group = await tag(organization.id, 'Group')
		await setTagLocations(organization.id, group, [a])
		const userId = await newMember(organization.id)
		await setMemberLocationScope({
			organizationId: organization.id,
			userId,
			value: { scope: 'selected', locationIds: [b], tagIds: [group] },
		})
		const expected = [a, b].sort()
		expect(await resolveLocationGrantIds(userId, organization.id)).toEqual(expected)
		expect(await resolveReservationsLocationIds(userId, organization.id)).toEqual(expected)
		expect(await resolveLoyaltyLocationIds(userId, organization.id)).toEqual(expected)
		expect(await resolveDiscountLocationIds(userId, organization.id)).toEqual(expected)
	})
})
