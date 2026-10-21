import { db, eq, Organization, StaffingOutbox } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	deprovisionTenantDatabase,
	provisionTenantDatabase,
} from '#app/utils/sites/tenant-api.server.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
	getResponseStatus,
} from '#tests/test-utils.ts'
import { action } from './_index.tsx'

vi.mock('#app/utils/sites/tenant-api.server.ts', () => ({
	provisionTenantDatabase: vi.fn(),
	deprovisionTenantDatabase: vi.fn(),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('#app/utils/staffing/regional-internal.server.ts', () => ({
	postRegionalStaffInternal: regional.post,
}))
vi.mock('#app/utils/reservations/regional-internal.server.ts', () => ({
	postRegionalReservationsInternal: vi.fn(
		async () =>
			new Response(
				JSON.stringify({
					reservations: 0,
					upcomingReservations: 0,
					guests: 0,
					waitlistEntries: 0,
					tables: 0,
					experiences: 0,
					payments: 0,
					auditEntries: 0,
				}),
				{ status: 200 },
			),
	),
}))

type Sent = { dataRegion: string; path: string; body: Record<string, unknown> }
let sent: Sent[]

const EMPTY = {
	staff: 0,
	byStatus: { invited: 0, active: 0, on_leave: 0, terminated: 0 },
	linkedLogins: 0,
	scopeAssignments: 0,
	positions: 0,
	payRecords: 0,
	notes: 0,
	auditEntries: 0,
}
const WITH_STAFF = {
	...EMPTY,
	staff: 12,
	byStatus: { invited: 0, active: 11, on_leave: 0, terminated: 1 },
	scopeAssignments: 14,
	positions: 5,
	payRecords: 14,
	notes: 3,
	auditEntries: 80,
}

function summaryReturns(body: unknown, status = 200) {
	regional.post.mockImplementation(async (args: Sent) => {
		sent.push(args)
		return new Response(JSON.stringify(body), { status })
	})
}

beforeEach(() => {
	sent = []
	regional.post.mockReset()
	summaryReturns(EMPTY)
	vi.mocked(provisionTenantDatabase).mockReset().mockResolvedValue({
		region: 'ksa',
	})
	vi.mocked(deprovisionTenantDatabase).mockReset().mockResolvedValue({
		region: 'us',
	})
})

async function setup(hasProvisionedDb = true) {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id)
	const { cookie } = await createTestSession(user.id)
	await db
		.update(Organization)
		.set({ hasProvisionedDb, sitePublished: false, dataRegion: 'us' })
		.where(eq(Organization.id, organization.id))
	const url = new URL(`http://localhost:3001/${organization.slug}/website`)
	return {
		organization,
		submit: (values: Record<string, string>) =>
			action({
				request: createAuthenticatedRequest(
					url.toString(),
					{
						method: 'POST',
						body: new URLSearchParams({
							organizationId: organization.id,
							intent: 'update-site-data-region',
							dataRegion: 'ksa',
							confirmWipe: 'true',
							...values,
						}),
					},
					cookie,
				),
				params: { orgSlug: organization.slug },
				context: new RouterContextProvider(),
				url,
				pattern: '/:orgSlug/website',
			}) as Promise<Response>,
	}
}

async function orgRow(id: string) {
	const [row] = await db
		.select()
		.from(Organization)
		.where(eq(Organization.id, id))
	return row!
}

describe('region switch: staff guard', () => {
	it('blocks the wipe until the slug is typed when the region holds staff records', async () => {
		summaryReturns(WITH_STAFF)
		const { organization, submit } = await setup()

		const response = await submit({})
		expect(getResponseStatus(response)).toBe(400)
		const body = (await response.json()) as any
		expect(body.staffConfirmationRequired).toBe(true)
		expect(body.summary).toMatchObject({ staff: 12, payRecords: 14 })
		// Counts only: nothing that names a person.
		expect(Object.keys(body.summary).sort()).toEqual(
			Object.keys(WITH_STAFF).sort(),
		)
		expect(deprovisionTenantDatabase).not.toHaveBeenCalled()
		expect(await orgRow(organization.id)).toMatchObject({
			dataRegion: 'us',
			hasProvisionedDb: true,
		})
	})

	it('rejects a wrong or empty confirmation, and accepts the slug however it is cased', async () => {
		summaryReturns(WITH_STAFF)
		const { organization, submit } = await setup()
		for (const confirmText of ['', 'yes', 'delete', `${organization.slug}x`]) {
			const response = await submit({ confirmText })
			expect(getResponseStatus(response)).toBe(400)
		}
		expect(deprovisionTenantDatabase).not.toHaveBeenCalled()

		const ok = await submit({
			confirmText: `  ${organization.slug.toUpperCase()} `,
		})
		expect(getResponseStatus(ok)).toBeLessThan(400)
		expect(deprovisionTenantDatabase).toHaveBeenCalledTimes(1)
		expect(await orgRow(organization.id)).toMatchObject({
			dataRegion: 'ksa',
			hasProvisionedDb: true,
		})
	})

	it('asks the CURRENT region, with the organization id only', async () => {
		const { organization, submit } = await setup()
		await submit({})
		expect(sent).toEqual([
			expect.objectContaining({
				dataRegion: 'us',
				path: 'summary',
				body: { orgId: organization.id },
			}),
		])
	})

	it('needs no typing when the region holds no staff data', async () => {
		const { organization, submit } = await setup()
		const response = await submit({})
		expect(getResponseStatus(response)).toBeLessThan(400)
		expect(deprovisionTenantDatabase).toHaveBeenCalledTimes(1)
		expect(await orgRow(organization.id)).toMatchObject({ dataRegion: 'ksa' })
	})

	it.each([
		['the node errors', () => summaryReturns({ error: 'x' }, 500)],
		['an older node has no such route', () => summaryReturns({}, 404)],
		['the answer is malformed', () => summaryReturns({ staff: 'many' })],
		[
			'the node is unreachable',
			() => regional.post.mockRejectedValue(new Error('ECONNREFUSED')),
		],
	])('fails closed when %s: the slug is required', async (_name, arrange) => {
		const { organization, submit } = await setup()
		arrange()
		const blocked = await submit({})
		expect(getResponseStatus(blocked)).toBe(400)
		expect(((await blocked.json()) as any).staffConfirmationRequired).toBe(true)
		expect(deprovisionTenantDatabase).not.toHaveBeenCalled()

		const confirmed = await submit({ confirmText: organization.slug })
		expect(getResponseStatus(confirmed)).toBeLessThan(400)
		expect(deprovisionTenantDatabase).toHaveBeenCalledTimes(1)
	})

	it('still needs the existing wipe confirmation, before anything is asked of a region', async () => {
		summaryReturns(WITH_STAFF)
		const { submit } = await setup()
		const response = await submit({ confirmWipe: '' })
		expect(getResponseStatus(response)).toBe(400)
		expect(regional.post).not.toHaveBeenCalled()
		expect(deprovisionTenantDatabase).not.toHaveBeenCalled()
	})

	it('does not ask a region when there is no database to wipe', async () => {
		const { organization, submit } = await setup(false)
		await submit({ confirmWipe: '' })
		expect(regional.post).not.toHaveBeenCalled()
		expect(await orgRow(organization.id)).toMatchObject({ dataRegion: 'ksa' })
	})

	it('cancels staffing events queued for the wiped region', async () => {
		summaryReturns(WITH_STAFF)
		const { organization, submit } = await setup()
		await db.insert(StaffingOutbox).values({
			organizationId: organization.id,
			kind: 'unlink_user',
			payload: { userId: 'u1' },
		})
		await submit({ confirmText: organization.slug })
		const [row] = await db
			.select()
			.from(StaffingOutbox)
			.where(eq(StaffingOutbox.organizationId, organization.id))
		expect(row).toMatchObject({ status: 'failed', lastError: 'region_changed' })
	})

	it('leaves events queued when the switch itself fails', async () => {
		summaryReturns(WITH_STAFF)
		const { organization, submit } = await setup()
		await db.insert(StaffingOutbox).values({
			organizationId: organization.id,
			kind: 'unlink_user',
			payload: { userId: 'u1' },
		})
		vi.mocked(deprovisionTenantDatabase).mockRejectedValue(new Error('down'))
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const response = await submit({ confirmText: organization.slug })
		expect(getResponseStatus(response)).toBe(500)
		const [row] = await db
			.select()
			.from(StaffingOutbox)
			.where(eq(StaffingOutbox.organizationId, organization.id))
		expect(row?.status).toBe('pending')
	})
})
