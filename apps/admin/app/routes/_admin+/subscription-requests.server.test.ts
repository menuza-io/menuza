/**
 * #379, Admin: every cancel or downgrade request with its reason, and marking
 * one handled. Reading or handling a request changes nothing about the
 * subscription.
 */
import { randomUUID } from 'node:crypto'
import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	SubscriptionChangeRequest,
	User,
} from '@repo/database'
import { afterEach, describe, expect, it } from 'vitest'
import {
	listChangeRequests,
	markChangeRequestHandled,
} from './subscription-requests.server.ts'

const orgIds: string[] = []
afterEach(async () => {
	for (const id of orgIds.splice(0)) {
		await db.delete(Organization).where(eq(Organization.id, id))
	}
})

async function makeUser(label: string) {
	const id = randomUUID()
	const [user] = await db
		.insert(User)
		.values({
			username: `${label}-${id.slice(0, 8)}`,
			email: `${label}-${id}@example.com`,
			name: `${label} person`,
		})
		.returning()
	return user!
}

async function makeOrgWithRequest(
	over: Partial<typeof SubscriptionChangeRequest.$inferInsert> = {},
) {
	const owner = await makeUser('owner')
	const [organization] = await db
		.insert(Organization)
		.values({
			name: 'Cafe',
			slug: `cafe-${randomUUID().slice(0, 8)}`,
			subscriptionStatus: 'active',
			planName: 'Plus',
		})
		.returning()
	orgIds.push(organization!.id)
	const [request] = await db
		.insert(SubscriptionChangeRequest)
		.values({
			organizationId: organization!.id,
			requestedById: owner.id,
			kind: 'cancel_organization',
			reason: 'too_expensive',
			subReason: 'price_too_high',
			note: 'Slow winter',
			effectiveAt: new Date('2026-12-14T00:00:00Z'),
			...over,
		})
		.returning()
	return { organization: organization!, owner, request: request! }
}

describe('Admin sees every cancel or downgrade request (#379)', () => {
	it('lists the request with its reason, sub-reason, note and cutoff', async () => {
		const { organization, request } = await makeOrgWithRequest()
		const rows = await listChangeRequests({ status: 'requested' })
		const row = rows.find((candidate) => candidate.id === request.id)
		expect(row).toMatchObject({
			organization: { id: organization.id, name: 'Cafe' },
			kindLabel: 'Cancel the organization',
			reasonLabel: 'Too expensive',
			subReasonLabel: 'The price is too high for us',
			note: 'Slow winter',
			effectiveAt: '2026-12-14T00:00:00.000Z',
			status: 'requested',
			requestedBy: 'owner person',
		})
	})

	it('names the locations of a location cancellation', async () => {
		const { organization, request } = await makeOrgWithRequest({
			kind: 'cancel_locations',
		})
		const [location] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: organization.id,
				name: 'Olaya',
				slug: `olaya-${randomUUID().slice(0, 8)}`,
			})
			.returning()
		await db
			.update(SubscriptionChangeRequest)
			.set({ locationIds: JSON.stringify([location!.id]) })
			.where(eq(SubscriptionChangeRequest.id, request.id))
		const [row] = await listChangeRequests({ organizationId: organization.id })
		expect(row?.locations).toEqual(['Olaya'])
	})

	it('filters by status and by organization', async () => {
		const open = await makeOrgWithRequest()
		const withdrawn = await makeOrgWithRequest({ status: 'withdrawn' })
		const ids = (await listChangeRequests({ status: 'requested' })).map(
			(row) => row.id,
		)
		expect(ids).toContain(open.request.id)
		expect(ids).not.toContain(withdrawn.request.id)
		const mine = await listChangeRequests({
			organizationId: withdrawn.organization.id,
		})
		expect(mine.map((row) => row.id)).toEqual([withdrawn.request.id])
	})

	it('marks an open request handled once, and changes nothing about the subscription', async () => {
		const { organization, request } = await makeOrgWithRequest()
		const admin = await makeUser('admin')
		expect(
			await markChangeRequestHandled({
				adminUserId: admin.id,
				requestId: request.id,
			}),
		).toEqual({ ok: true })
		const [row] = await db
			.select()
			.from(SubscriptionChangeRequest)
			.where(eq(SubscriptionChangeRequest.id, request.id))
		expect(row).toMatchObject({ status: 'handled', handledById: admin.id })
		expect(row?.handledAt).toBeInstanceOf(Date)
		expect(
			await markChangeRequestHandled({
				adminUserId: admin.id,
				requestId: request.id,
			}),
		).toEqual({ ok: false })
		const [org] = await db
			.select({
				status: Organization.subscriptionStatus,
				plan: Organization.planName,
			})
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org).toEqual({ status: 'active', plan: 'Plus' })
	})
})
