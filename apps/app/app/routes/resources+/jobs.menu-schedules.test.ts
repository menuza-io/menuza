import { db, eq, MenuSchedule, OrganizationMenu } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import { action } from './jobs.menu-schedules.ts'

const snapshotStore = vi.hoisted(() => new Map<string, string>())

vi.mock('#app/utils/storage.server.ts', () => ({
	uploadMenuSnapshotJson: vi.fn(
		async (orgId: string, snapshotId: string, body: string) => {
			const key = `menu-snapshots/${orgId}/${snapshotId}.json`
			snapshotStore.set(key, body)
			return key
		},
	),
	readMenuSnapshotJson: vi.fn(async (contentKey: string) => {
		return snapshotStore.get(contentKey) ?? null
	}),
	deleteMenuSnapshotJson: vi.fn(async (contentKey: string) => {
		snapshotStore.delete(contentKey)
	}),
}))

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))

function call(init: { method?: string; authorized?: boolean } = {}) {
	const url = new URL('http://localhost:3001/resources/jobs/menu-schedules')
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
		pattern: '/resources/jobs/menu-schedules',
	}) as Promise<Response>
}

beforeEach(async () => {
	snapshotStore.clear()
	await db.delete(MenuSchedule)
})

describe('jobs.menu-schedules (#149)', () => {
	it('is POST only and requires internal command auth', async () => {
		expect((await call({ method: 'GET' })).status).toBe(405)

		const owner = await createTestUser()
		const org = await createTestOrganization(owner.id)
		const [menu] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: org.id,
				displayName: JSON.stringify({ en: 'Due Menu' }),
				availabilityStatus: 'unavailable',
			})
			.returning()
		const [schedule] = await db
			.insert(MenuSchedule)
			.values({
				organizationId: org.id,
				menuId: menu!.id,
				goLiveAt: new Date(Date.now() - 60_000),
				status: 'pending',
				createdById: owner.id,
			})
			.returning()

		let status = 0
		try {
			status = (await call({ authorized: false })).status
		} catch (error) {
			status = error instanceof Response ? error.status : 302
		}
		expect([301, 302, 303, 401, 403]).toContain(status)

		const [untouched] = await db
			.select()
			.from(MenuSchedule)
			.where(eq(MenuSchedule.id, schedule!.id))
		expect(untouched?.status).toBe('pending')
	})

	it('applies due menu schedules when authorized', async () => {
		const owner = await createTestUser()
		const org = await createTestOrganization(owner.id)
		const [liveMenu] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: org.id,
				displayName: JSON.stringify({ en: 'Breakfast' }),
				availabilityStatus: 'unavailable',
			})
			.returning()
		const [offMenu] = await db
			.insert(OrganizationMenu)
			.values({
				organizationId: org.id,
				displayName: JSON.stringify({ en: 'Dinner' }),
				availabilityStatus: 'available',
			})
			.returning()
		await db.insert(MenuSchedule).values({
			organizationId: org.id,
			menuId: liveMenu!.id,
			takeOffMenuId: offMenu!.id,
			goLiveAt: new Date(Date.now() - 10_000),
			status: 'pending',
			createdById: owner.id,
		})

		const res = await call()
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			success: boolean
			applied: number
			skipped: number
		}
		expect(body.success).toBe(true)
		expect(body.applied).toBe(1)

		const [afterLive] = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.id, liveMenu!.id))
		const [afterOff] = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.id, offMenu!.id))
		expect(afterLive?.availabilityStatus).toBe('available')
		expect(afterOff?.availabilityStatus).toBe('unavailable')
	})
})
