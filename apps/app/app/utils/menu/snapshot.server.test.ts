import {
	db,
	eq,
	MenuSnapshot,
	OrganizationMenuItem,
	OrganizationMenuPosLink,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	createMenuSnapshot,
	loadMenuSnapshotContent,
	MenuSnapshotError,
	pruneMenuSnapshotsForOrganization,
	restoreMenuSnapshot,
} from './snapshot.server.ts'

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
	purgeOrganizationSiteCache: vi.fn(),
}))
vi.mock('@repo/audit', () => ({
	auditService: { log: vi.fn() },
	AuditAction: { MENU_ITEM_UPDATED: 'menu_item_updated' },
}))

async function seedMenu(organizationId: string) {
	const [item] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: '{"en":"Taco"}',
			price: 9.5,
			availabilityStatus: 'available',
		})
		.returning()
	return item!
}

describe('snapshot.server', () => {
	let organizationId = ''
	let organizationSlug = ''
	let userId = ''

	beforeEach(async () => {
		snapshotStore.clear()
		const user = await insertTestUser()
		const org = await createTestOrganization(user.id)
		organizationId = org.id
		organizationSlug = org.slug
		userId = user.id
	})

	afterEach(() => {
		snapshotStore.clear()
	})

	it('restores a deleted item with the same id and creates before_restore snapshot', async () => {
		const item = await seedMenu(organizationId)
		const snapshotId = await createMenuSnapshot({
			organizationId,
			reason: 'manual',
			userId,
		})

		await db
			.delete(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, item.id))

		const missing = await db.query.OrganizationMenuItem.findFirst({
			where: eq(OrganizationMenuItem.id, item.id),
		})
		expect(missing).toBeUndefined()

		await restoreMenuSnapshot({
			organizationId,
			organizationSlug,
			snapshotId,
			userId,
			removeAdded: false,
		})

		const restored = await db.query.OrganizationMenuItem.findFirst({
			where: eq(OrganizationMenuItem.id, item.id),
		})
		expect(restored?.price).toBe(9.5)

		const restoreSnapshots = await db
			.select()
			.from(MenuSnapshot)
			.where(eq(MenuSnapshot.organizationId, organizationId))
		expect(
			restoreSnapshots.some((row) => row.reason === 'before_restore'),
		).toBe(true)
	})

	it('refuses snapshots from another organization', async () => {
		const item = await seedMenu(organizationId)
		const snapshotId = await createMenuSnapshot({
			organizationId,
			reason: 'manual',
			userId,
		})

		const otherUser = await insertTestUser()
		const otherOrg = await createTestOrganization(otherUser.id)

		await expect(
			loadMenuSnapshotContent(snapshotId, otherOrg.id),
		).rejects.toBeInstanceOf(MenuSnapshotError)

		await expect(
			restoreMenuSnapshot({
				organizationId: otherOrg.id,
				organizationSlug: otherOrg.slug,
				snapshotId,
				userId: otherUser.id,
				removeAdded: false,
			}),
		).rejects.toMatchObject({ code: 'not_found' })

		const stillThere = await db.query.OrganizationMenuItem.findFirst({
			where: eq(OrganizationMenuItem.id, item.id),
		})
		expect(stillThere).toBeDefined()
	})

	it('prunes snapshots beyond the newest fifty and older than retention', async () => {
		await seedMenu(organizationId)
		const ids: string[] = []
		for (let i = 0; i < 55; i++) {
			ids.push(
				await createMenuSnapshot({
					organizationId,
					reason: 'manual',
					userId,
					label: `snap-${i}`,
				}),
			)
		}
		const stale = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
		await db
			.update(MenuSnapshot)
			.set({ createdAt: stale })
			.where(eq(MenuSnapshot.id, ids[0]!))

		const pruned = await pruneMenuSnapshotsForOrganization(organizationId)
		expect(pruned).toBe(1)

		const remaining = await db
			.select()
			.from(MenuSnapshot)
			.where(eq(MenuSnapshot.organizationId, organizationId))
		expect(remaining.some((row) => row.id === ids[0])).toBe(false)
		expect(remaining.length).toBe(54)
	})
})
