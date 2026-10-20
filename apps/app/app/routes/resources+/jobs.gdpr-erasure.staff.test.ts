import {
	DataSubjectRequest,
	db,
	eq,
	Organization,
	StaffingOutbox,
	User,
	UserOrganization,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as outbox from '#app/utils/staffing/outbox.server.ts'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { action } from './jobs.gdpr-erasure.ts'

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('#app/utils/staffing/regional-internal.server.ts', () => ({
	postRegionalStaffInternal: regional.post,
}))

const enqueueControl = vi.hoisted(() => ({ fail: false }))
vi.mock('#app/utils/staffing/outbox.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof outbox>()
	return {
		...actual,
		enqueueStaffingOutbox: (
			...args: Parameters<typeof actual.enqueueStaffingOutbox>
		) => {
			if (enqueueControl.fail) throw new Error('outbox unavailable')
			return actual.enqueueStaffingOutbox(...args)
		},
	}
})

type Sent = { dataRegion: string; path: string; body: Record<string, unknown> }
let sent: Sent[]

beforeEach(() => {
	sent = []
	enqueueControl.fail = false
	regional.post.mockReset().mockImplementation(async (args: Sent) => {
		sent.push(args)
		return new Response('{}', { status: 200 })
	})
})

function run() {
	const url = new URL('http://localhost:3001/resources/jobs/gdpr-erasure')
	return action({
		request: new Request(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/gdpr-erasure',
	}) as Promise<Response>
}

async function memberOf(
	userId: string,
	options: {
		dataRegion?: 'us' | 'ksa'
		provisioned?: boolean
		active?: boolean
	},
) {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id)
	await db
		.update(Organization)
		.set({
			dataRegion: options.dataRegion ?? 'us',
			hasProvisionedDb: options.provisioned ?? true,
		})
		.where(eq(Organization.id, organization.id))
	await db.insert(UserOrganization).values({
		userId,
		organizationId: organization.id,
		organizationRoleId: 'org_role_member',
		active: options.active ?? true,
	})
	return organization.id
}

async function scheduleErasure(userId: string) {
	const [dsr] = await db
		.insert(DataSubjectRequest)
		.values({
			userId,
			type: 'erasure',
			status: 'scheduled',
			scheduledFor: new Date(Date.now() - 1000),
		})
		.returning()
	return dsr!
}

describe('GDPR erasure and regional staff records', () => {
	it('queues an erase for every provisioned organization, then deletes the account', async () => {
		const user = await createTestUser()
		const usOrg = await memberOf(user.id, { dataRegion: 'us' })
		const ksaOrg = await memberOf(user.id, { dataRegion: 'ksa' })
		const removedOrg = await memberOf(user.id, { active: false })
		const noDbOrg = await memberOf(user.id, { provisioned: false })
		const dsr = await scheduleErasure(user.id)

		const response = await run()
		expect(response.status).toBe(200)

		const rows = await db.select().from(StaffingOutbox)
		const mine = rows.filter((row) =>
			[usOrg, ksaOrg, removedOrg, noDbOrg].includes(row.organizationId),
		)
		expect(mine.map((row) => row.organizationId).sort()).toEqual(
			[usOrg, ksaOrg, removedOrg].sort(),
		)
		for (const row of mine) {
			expect(row).toMatchObject({
				kind: 'erase_user',
				status: 'done',
				payload: { userId: user.id },
			})
		}
		// Each node is told in its own region, with ids only.
		const regions = Object.fromEntries(
			sent.map((call) => [call.body.orgId, call.dataRegion]),
		)
		expect(regions[usOrg]).toBe('us')
		expect(regions[ksaOrg]).toBe('ksa')
		for (const call of sent) {
			expect(call.path).toBe('erase-user')
			expect(Object.keys(call.body).sort()).toEqual(['orgId', 'userId'])
		}
		expect(
			await db.select().from(User).where(eq(User.id, user.id)),
		).toHaveLength(0)
		const [updated] = await db
			.select()
			.from(DataSubjectRequest)
			.where(eq(DataSubjectRequest.id, dsr.id))
		expect(updated?.status).toBe('completed')
	})

	it('still deletes the account when the regional node is down; the event stays queued', async () => {
		const user = await createTestUser()
		const org = await memberOf(user.id, {})
		await scheduleErasure(user.id)
		regional.post.mockRejectedValue(new Error('ECONNREFUSED'))

		const response = await run()
		expect(response.status).toBe(200)
		expect(
			await db.select().from(User).where(eq(User.id, user.id)),
		).toHaveLength(0)
		const [row] = await db
			.select()
			.from(StaffingOutbox)
			.where(eq(StaffingOutbox.organizationId, org))
		expect(row).toMatchObject({ kind: 'erase_user', status: 'pending' })
	})

	it('does not delete the account when the erase cannot be queued', async () => {
		const user = await createTestUser()
		await memberOf(user.id, {})
		const dsr = await scheduleErasure(user.id)
		enqueueControl.fail = true

		await run()

		expect(
			await db.select().from(User).where(eq(User.id, user.id)),
		).toHaveLength(1)
		const [updated] = await db
			.select()
			.from(DataSubjectRequest)
			.where(eq(DataSubjectRequest.id, dsr.id))
		expect(updated?.status).toBe('failed')
		expect(regional.post).not.toHaveBeenCalled()
	})

	it('queues nothing for a user who belongs to no provisioned organization', async () => {
		const user = await createTestUser()
		const org = await memberOf(user.id, { provisioned: false })
		await scheduleErasure(user.id)
		await run()
		expect(
			await db
				.select()
				.from(StaffingOutbox)
				.where(eq(StaffingOutbox.organizationId, org)),
		).toHaveLength(0)
		expect(regional.post).not.toHaveBeenCalled()
	})
})
