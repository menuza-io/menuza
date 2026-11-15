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
	captureMenuSnapshotContent,
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
		expect(remaining).toHaveLength(54)
	})

	it('keeps the newest twenty before_suggestion snapshots whatever their age, apart from the fifty of other reasons', async () => {
		await seedMenu(organizationId)
		const old = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)
		const suggestionIds: string[] = []
		for (let i = 0; i < 25; i++) {
			const id = await createMenuSnapshot({
				organizationId,
				reason: 'before_suggestion',
				userId,
			})
			// Oldest first, all far past the 90 day retention.
			await db
				.update(MenuSnapshot)
				.set({ createdAt: old(400 - i) })
				.where(eq(MenuSnapshot.id, id))
			suggestionIds.push(id)
		}
		const manualIds: string[] = []
		for (let i = 0; i < 50; i++) {
			const id = await createMenuSnapshot({
				organizationId,
				reason: 'manual',
				userId,
			})
			await db
				.update(MenuSnapshot)
				.set({ createdAt: old(200 - i) })
				.where(eq(MenuSnapshot.id, id))
			manualIds.push(id)
		}

		const pruned = await pruneMenuSnapshotsForOrganization(organizationId)
		expect(pruned).toBe(5)

		const remaining = await db
			.select()
			.from(MenuSnapshot)
			.where(eq(MenuSnapshot.organizationId, organizationId))
		const ids = new Set(remaining.map((row) => row.id))
		// The newest 20 suggestion snapshots stay, the oldest 5 go.
		expect(suggestionIds.slice(5).every((id) => ids.has(id))).toBe(true)
		expect(suggestionIds.slice(0, 5).some((id) => ids.has(id))).toBe(false)
		// All 50 others stay: suggestions do not eat their budget.
		expect(manualIds.every((id) => ids.has(id))).toBe(true)
		expect(remaining).toHaveLength(70)
		// The pruned ones lose their stored JSON too.
		for (const id of suggestionIds.slice(0, 5)) {
			expect([...snapshotStore.keys()].some((key) => key.endsWith(`${id}.json`))).toBe(false)
		}
	})

	it('does not let a flood of other snapshots push out suggestion snapshots', async () => {
		await seedMenu(organizationId)
		const suggestion = await createMenuSnapshot({
			organizationId,
			reason: 'before_suggestion',
			userId,
		})
		await db
			.update(MenuSnapshot)
			.set({ createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000) })
			.where(eq(MenuSnapshot.id, suggestion))
		for (let i = 0; i < 55; i++) {
			await createMenuSnapshot({ organizationId, reason: 'manual', userId })
		}
		await pruneMenuSnapshotsForOrganization(organizationId)
		const rows = await db
			.select()
			.from(MenuSnapshot)
			.where(eq(MenuSnapshot.organizationId, organizationId))
		expect(rows.some((row) => row.id === suggestion)).toBe(true)
	})

	it('stores a supplied content instead of reading the menu again', async () => {
		const item = await seedMenu(organizationId)
		const content = await captureMenuSnapshotContent(organizationId)
		await db.delete(OrganizationMenuItem).where(eq(OrganizationMenuItem.id, item.id))
		const snapshotId = await createMenuSnapshot({
			organizationId,
			reason: 'before_suggestion',
			userId,
			content,
		})
		const loaded = await loadMenuSnapshotContent(snapshotId, organizationId)
		expect(loaded.content.items.map((row) => row.id)).toEqual([item.id])
		expect(loaded.meta.itemCount).toBe(1)
	})
})
