import { db, eq, Organization, StaffingOutbox } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { action } from './jobs.staffing-outbox.ts'

const regional = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('#app/utils/staffing/regional-internal.server.ts', () => ({
	postRegionalStaffInternal: regional.post,
}))

function call(init: { method?: string; authorized?: boolean } = {}) {
	const url = new URL('http://localhost:3001/resources/jobs/staffing-outbox')
	return action({
		request: new Request(url, {
			method: init.method ?? 'POST',
			headers:
				init.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` },
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/jobs/staffing-outbox',
	}) as Promise<Response>
}

async function pendingRow() {
	const owner = await createTestUser()
	const organization = await createTestOrganization(owner.id)
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true })
		.where(eq(Organization.id, organization.id))
	const [row] = await db
		.insert(StaffingOutbox)
		.values({
			organizationId: organization.id,
			kind: 'unlink_user',
			payload: { userId: 'u1' },
			nextAttemptAt: new Date(Date.now() - 1000),
		})
		.returning()
	return row!
}

beforeEach(() => {
	regional.post
		.mockReset()
		.mockResolvedValue(new Response('{}', { status: 200 }))
})

describe('jobs.staffing-outbox', () => {
	it('is POST only and needs the internal command token', async () => {
		expect((await call({ method: 'GET' })).status).toBe(405)
		const row = await pendingRow()
		let status = 0
		try {
			status = (await call({ authorized: false })).status
		} catch (error) {
			status = error instanceof Response ? error.status : 302
		}
		expect([301, 302, 303, 401, 403]).toContain(status)
		const [untouched] = await db
			.select()
			.from(StaffingOutbox)
			.where(eq(StaffingOutbox.id, row.id))
		expect(untouched?.status).toBe('pending')
		expect(regional.post).not.toHaveBeenCalled()
	})

	it('drains due events and answers with counts only', async () => {
		const row = await pendingRow()
		const response = await call()
		expect(response.status).toBe(200)
		const body = (await response.json()) as Record<string, unknown>
		expect(body).toMatchObject({ success: true, failed: 0 })
		expect(body.done).toBeGreaterThanOrEqual(1)
		for (const value of Object.values(body)) {
			expect(['number', 'boolean']).toContain(typeof value)
		}
		const [done] = await db
			.select()
			.from(StaffingOutbox)
			.where(eq(StaffingOutbox.id, row.id))
		expect(done?.status).toBe('done')
	})

	it('reports permanent failures so the run is visibly not clean', async () => {
		const row = await pendingRow()
		regional.post.mockResolvedValue(
			new Response(JSON.stringify({ error: 'staff_not_found' }), {
				status: 404,
			}),
		)
		vi.spyOn(console, 'error').mockImplementation(() => {})
		const body = (await (await call()).json()) as Record<string, unknown>
		expect(body.success).toBe(false)
		expect(body.failed).toBeGreaterThanOrEqual(1)
		const [failed] = await db
			.select()
			.from(StaffingOutbox)
			.where(eq(StaffingOutbox.id, row.id))
		expect(failed).toMatchObject({
			status: 'failed',
			lastError: 'staff_not_found',
		})
	})
})
