import { db, eq, OrganizationMenuItem } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { menuFileContentKey, parseMenuFile } from './menu-file.ts'
import { applyMenuFile, loadMenuFile } from './menu-file.server.ts'

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

describe('menu file round trip', () => {
	let userId = ''

	beforeEach(async () => {
		snapshotStore.clear()
		const user = await insertTestUser()
		userId = user.id
	})

	afterEach(() => {
		snapshotStore.clear()
	})

	it('imports an export into an empty organization with the same menu', async () => {
		const source = await createTestOrganization(userId)
		await db.insert(OrganizationMenuItem).values({
			organizationId: source.id,
			displayName: '{"en":"Soup"}',
			price: 8,
			barcode: '1234567890128',
			calorieMin: 100,
			allergens: '["gluten"]',
			dietaryTags: '["vegan"]',
		})
		const file = await loadMenuFile(source.id, '2026-11-26T00:00:00.000Z')
		const parsed = parseMenuFile(JSON.stringify(file))
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return
		const target = await createTestOrganization(userId)
		const applied = await applyMenuFile({
			organizationId: target.id,
			userId,
			file: parsed.file,
		})
		expect(applied.snapshotId).toBeTruthy()
		expect(snapshotStore.size).toBeGreaterThan(0)
		const again = await loadMenuFile(target.id, file.exportedAt)
		expect(menuFileContentKey(again)).toBe(menuFileContentKey(file))
		const [copy] = await db
			.select({ id: OrganizationMenuItem.id })
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.organizationId, target.id))
		expect(copy?.id).not.toBe(parsed.file.items[0]?.id)
	})
})
