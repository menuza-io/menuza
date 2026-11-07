import {
	DataSubjectRequest,
	db,
	eq,
	Organization,
	OrganizationInviteLink,
	User,
	UserOrganization,
	WebsitePage,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import {
	createErasureRequest,
	createExportRequest,
	ERASURE_MAX_ATTEMPTS,
	ERASURE_RETRY_DELAY_MS,
	ERASURE_STALE_PROCESSING_MS,
	EXPORT_STALE_PROCESSING_MS,
	markExportRequestFailed,
	processDueErasureRequests,
} from './gdpr.server.ts'

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('#app/utils/staffing/regional-internal.server.ts', () => ({
	postRegionalStaffInternal: regional.post,
}))

beforeEach(() => {
	regional.post
		.mockReset()
		.mockImplementation(async () => new Response('{}', { status: 200 }))
})

async function scheduleErasure(
	userId: string,
	values: Partial<typeof DataSubjectRequest.$inferInsert> = {},
) {
	const [dsr] = await db
		.insert(DataSubjectRequest)
		.values({
			userId,
			type: 'erasure',
			status: 'scheduled',
			scheduledFor: new Date(Date.now() - 1000),
			...values,
		})
		.returning()
	return dsr!
}

async function requestRow(id: string) {
	const [row] = await db
		.select()
		.from(DataSubjectRequest)
		.where(eq(DataSubjectRequest.id, id))
	return row
}

async function userExists(id: string) {
	return (await db.select().from(User).where(eq(User.id, id))).length === 1
}

async function addMember(
	organizationId: string,
	userId: string,
	role: 'admin' | 'member' = 'member',
) {
	await db.insert(UserOrganization).values({
		userId,
		organizationId,
		organizationRoleId: `org_role_${role}`,
	})
}

describe('erasure of a user who authored website pages and invite links', () => {
	it('deletes the user with nobody to take over: pages keep no author, links go', async () => {
		const leaver = await createTestUser()
		const [organization] = await db
			.insert(Organization)
			.values({ name: 'Solo Shop', slug: `solo-${leaver.id}` })
			.returning()
		// The only member, and not an admin, so nothing holds the erasure.
		await addMember(organization!.id, leaver.id)
		const [page] = await db
			.insert(WebsitePage)
			.values({
				organizationId: organization!.id,
				title: 'About',
				slug: `about-${leaver.id}`,
				createdById: leaver.id,
			})
			.returning()
		await db.insert(OrganizationInviteLink).values({
			organizationId: organization!.id,
			token: `token-${leaver.id}`,
			organizationRoleId: 'org_role_member',
			createdById: leaver.id,
		})
		const dsr = await scheduleErasure(leaver.id)

		const results = await processDueErasureRequests({ requestId: dsr.id })

		expect(results.errors).toEqual([])
		expect((await requestRow(dsr.id))?.status).toBe('completed')
		expect(await userExists(leaver.id)).toBe(false)
		const [keptPage] = await db
			.select()
			.from(WebsitePage)
			.where(eq(WebsitePage.id, page!.id))
		expect(keptPage).toMatchObject({ title: 'About', createdById: null })
		expect(
			await db
				.select()
				.from(OrganizationInviteLink)
				.where(eq(OrganizationInviteLink.organizationId, organization!.id)),
		).toHaveLength(0)
	})
})

describe('sole-admin rule', () => {
	it('re-checks at execution time and holds the request instead of orphaning the organization', async () => {
		const admin = await createTestUser()
		const other = await createTestUser()
		const organization = await createTestOrganization(admin.id)
		await addMember(organization.id, other.id, 'admin')

		// Allowed while another admin exists...
		const created = await createErasureRequest(admin.id)
		expect(created.success).toBe(true)
		// ...who then steps down before the grace period ends.
		await db
			.update(UserOrganization)
			.set({ organizationRoleId: 'org_role_member' })
			.where(eq(UserOrganization.userId, other.id))
		await db
			.update(DataSubjectRequest)
			.set({ scheduledFor: new Date(Date.now() - 1000) })
			.where(eq(DataSubjectRequest.id, created.requestId!))

		const results = await processDueErasureRequests({
			requestId: created.requestId,
		})

		expect(results.held).toBe(1)
		expect(await userExists(admin.id)).toBe(true)
		const row = await requestRow(created.requestId!)
		expect(row?.status).toBe('scheduled')
		expect(row?.failureReason).toContain('sole_admin')
		expect(row?.scheduledFor!.getTime()).toBeGreaterThan(Date.now())
	})

	it('does not count an admin with a pending erasure as the other admin', async () => {
		const first = await createTestUser()
		const second = await createTestUser()
		const organization = await createTestOrganization(first.id)
		await addMember(organization.id, second.id, 'admin')

		expect((await createErasureRequest(first.id)).success).toBe(true)
		const blocked = await createErasureRequest(second.id)
		expect(blocked.success).toBe(false)
		expect(blocked.error).toContain('sole admin')
	})

	it('lets the oldest of two leaving admins go ahead instead of holding both forever', async () => {
		const older = await createTestUser()
		const newer = await createTestUser()
		const third = await createTestUser()
		const organization = await createTestOrganization(older.id)
		await addMember(organization.id, newer.id, 'admin')
		await addMember(organization.id, third.id, 'admin')

		// Both are accepted while the third admin stays...
		const first = await createErasureRequest(older.id)
		const second = await createErasureRequest(newer.id)
		expect(first.success).toBe(true)
		expect(second.success).toBe(true)
		// ...who then steps down, leaving only the two leaving admins.
		await db
			.update(UserOrganization)
			.set({ organizationRoleId: 'org_role_member' })
			.where(eq(UserOrganization.userId, third.id))
		const due = new Date(Date.now() - 1000)
		await db
			.update(DataSubjectRequest)
			.set({ scheduledFor: due, requestedAt: new Date(Date.now() - 20_000) })
			.where(eq(DataSubjectRequest.id, first.requestId!))
		await db
			.update(DataSubjectRequest)
			.set({ scheduledFor: due, requestedAt: new Date(Date.now() - 10_000) })
			.where(eq(DataSubjectRequest.id, second.requestId!))

		// The newer request runs first and waits for the older one...
		const newerRun = await processDueErasureRequests({
			requestId: second.requestId,
		})
		expect(newerRun.held).toBe(1)
		// ...which goes ahead although the newer one is still pending.
		const olderRun = await processDueErasureRequests({
			requestId: first.requestId,
		})
		expect(olderRun.errors).toEqual([])
		expect((await requestRow(first.requestId!))?.status).toBe('completed')
		expect(await userExists(older.id)).toBe(false)

		// The remaining admin is now the sole admin: held until another joins.
		expect(await userExists(newer.id)).toBe(true)
		const held = await requestRow(second.requestId!)
		expect(held?.status).toBe('scheduled')
		expect(held?.failureReason).toBe(`sole_admin: ${organization.id}`)
	})
})

describe('erasure claims and retries', () => {
	it('executes a request only once when two runs overlap', async () => {
		const user = await createTestUser()
		const dsr = await scheduleErasure(user.id)

		const [a, b] = await Promise.all([
			processDueErasureRequests({ requestId: dsr.id }),
			processDueErasureRequests({ requestId: dsr.id }),
		])

		expect(a.processed + b.processed).toBe(1)
		expect(a.failed + b.failed).toBe(0)
	})

	it('reclaims a request left processing by a crashed run', async () => {
		const user = await createTestUser()
		const now = Date.now()
		const dsr = await scheduleErasure(user.id, {
			status: 'processing',
			processedAt: new Date(now - ERASURE_STALE_PROCESSING_MS - 1000),
		})

		const results = await processDueErasureRequests({ requestId: dsr.id })

		expect(results.processed).toBe(1)
		expect((await requestRow(dsr.id))?.status).toBe('completed')
		expect(await userExists(user.id)).toBe(false)
	})

	it('leaves a fresh processing request alone', async () => {
		const user = await createTestUser()
		const dsr = await scheduleErasure(user.id, {
			status: 'processing',
			processedAt: new Date(),
		})

		await processDueErasureRequests({ requestId: dsr.id })

		expect((await requestRow(dsr.id))?.status).toBe('processing')
		expect(await userExists(user.id)).toBe(true)
	})

	it('retries a failed request until the attempt cap', async () => {
		const user = await createTestUser()
		const old = new Date(Date.now() - ERASURE_RETRY_DELAY_MS - 1000)
		const retryable = await scheduleErasure(user.id, {
			status: 'failed',
			processedAt: old,
			metadata: JSON.stringify({ attempts: 1 }),
		})

		expect(
			(await processDueErasureRequests({ requestId: retryable.id })).processed,
		).toBe(1)
		expect((await requestRow(retryable.id))?.status).toBe('completed')

		const capped = await createTestUser()
		const exhausted = await scheduleErasure(capped.id, {
			status: 'failed',
			processedAt: old,
			metadata: JSON.stringify({ attempts: ERASURE_MAX_ATTEMPTS }),
		})
		await processDueErasureRequests({ requestId: exhausted.id })
		expect((await requestRow(exhausted.id))?.status).toBe('failed')
		expect(await userExists(capped.id)).toBe(true)
	})
})

describe('export requests', () => {
	it('a failed export does not block the next one', async () => {
		const user = await createTestUser()
		const first = await createExportRequest(user.id)
		expect(first.success).toBe(true)
		await markExportRequestFailed(first.requestId!, 'boom')
		expect((await requestRow(first.requestId!))?.status).toBe('failed')

		expect((await createExportRequest(user.id)).success).toBe(true)
	})

	it('a stale processing export does not block the next one', async () => {
		const user = await createTestUser()
		await db.insert(DataSubjectRequest).values({
			userId: user.id,
			type: 'export',
			status: 'processing',
			processedAt: new Date(Date.now() - EXPORT_STALE_PROCESSING_MS - 1000),
		})
		expect((await createExportRequest(user.id)).success).toBe(true)
		// A fresh one still blocks a duplicate.
		expect((await createExportRequest(user.id)).success).toBe(false)
	})
})
