import { db, eq } from '@repo/database'
import {
	Integration,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuChannelState,
	OrganizationMenuItem,
	OrganizationMenuPublish,
	OrganizationMenuPublished,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

const pushMenuMock = vi.hoisted(() => vi.fn())
const purgeMock = vi.hoisted(() => vi.fn())

vi.mock('@repo/integrations', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		pushMenu: pushMenuMock,
	}
})

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: purgeMock,
}))

import { publishMenu, recordChannelSync } from './publish.server.ts'

/** Inserts one row and fails the test if nothing came back. */
async function insertOne<T>(query: PromiseLike<T[]>): Promise<T> {
	const rows = await query
	const row = rows[0]
	if (!row) throw new Error('Test seed failed')
	return row
}

async function seedMenu(organizationId: string) {
	const menu = await insertOne(
		db
			.insert(OrganizationMenu)
			.values({
				organizationId,
				displayName: '{"en":"Dinner"}',
				menuType: 'online_pos_kiosk',
				hasUnpublishedChanges: true,
			})
			.returning(),
	)
	const category = await insertOne(
		db
			.insert(OrganizationMenuCategory)
			.values({ organizationId, displayName: '{"en":"Mains"}' })
			.returning(),
	)
	await db.insert(OrganizationMenuCategoryAssignment).values({
		menuId: menu.id,
		categoryId: category.id,
	})
	const item = await insertOne(
		db
			.insert(OrganizationMenuItem)
			.values({
				organizationId,
				displayName: '{"en":"Burger"}',
				price: 10,
			})
			.returning(),
	)
	return { menu, category, item }
}

async function seedChannel(organizationId: string, providerName = 'ubereats') {
	const integration = await insertOne(
		db
			.insert(Integration)
			.values({
				organizationId,
				providerName,
				providerType: 'delivery',
				config: '{}',
				isActive: true,
			})
			.returning(),
	)
	return integration
}

describe('publishMenu', () => {
	beforeEach(() => {
		pushMenuMock.mockReset()
		purgeMock.mockReset()
	})

	it('freezes a storefront snapshot, clears the dirty flag, and logs the event', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const seed = await seedMenu(organization.id)

		const result = await publishMenu({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			menuId: seed.menu.id,
			includeStorefront: true,
			integrationIds: [],
			userId: user.id,
		})

		expect(result.status).toBe('succeeded')
		expect(result.revision).toBe(1)
		expect(purgeMock).toHaveBeenCalledWith(organization.id, organization.slug)

		const [published] = await db
			.select()
			.from(OrganizationMenuPublished)
			.where(eq(OrganizationMenuPublished.menuId, seed.menu.id))
		expect(published?.revision).toBe(1)
		expect(published?.publishedByUserId).toBe(user.id)
		const snapshot = JSON.parse(published!.content) as { menu: { id: string } }
		expect(snapshot.menu.id).toBe(seed.menu.id)

		const [menu] = await db
			.select()
			.from(OrganizationMenu)
			.where(eq(OrganizationMenu.id, seed.menu.id))
		expect(menu?.hasUnpublishedChanges).toBe(false)

		const events = await db
			.select()
			.from(OrganizationMenuPublish)
			.where(eq(OrganizationMenuPublish.menuId, seed.menu.id))
		expect(events).toHaveLength(1)
		expect(events[0]?.status).toBe('succeeded')
		expect(events[0]?.revision).toBe(1)
		expect(events[0]?.actorId).toBe(user.id)
	})

	it('bumps the revision on each storefront publish', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const seed = await seedMenu(organization.id)

		const first = await publishMenu({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			menuId: seed.menu.id,
			includeStorefront: true,
			integrationIds: [],
			userId: user.id,
		})
		const second = await publishMenu({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			menuId: seed.menu.id,
			includeStorefront: true,
			integrationIds: [],
			userId: user.id,
		})

		expect(first.revision).toBe(1)
		expect(second.revision).toBe(2)
	})

	it('fans out to the selected channel and records its state', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const seed = await seedMenu(organization.id)
		const channel = await seedChannel(organization.id)
		pushMenuMock.mockResolvedValue({ mode: 'menu', pushed: 5 })

		const result = await publishMenu({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			menuId: seed.menu.id,
			includeStorefront: false,
			integrationIds: [channel.id],
			userId: user.id,
		})

		expect(pushMenuMock).toHaveBeenCalledWith(
			channel.id,
			organization.id,
			seed.menu.id,
		)
		expect(result.status).toBe('succeeded')
		expect(result.targets).toHaveLength(1)
		expect(result.targets[0]).toMatchObject({
			type: 'channel',
			status: 'success',
			pushed: 5,
		})

		const [state] = await db
			.select()
			.from(OrganizationMenuChannelState)
			.where(eq(OrganizationMenuChannelState.integrationId, channel.id))
		expect(state?.lastStatus).toBe('success')
		expect(state?.pushedCount).toBe(5)
		expect(state?.selected).toBe(true)
		expect(state?.lastSyncAt).not.toBeNull()

		// Channel-only publish must not touch the storefront snapshot.
		const publishedRows = await db
			.select()
			.from(OrganizationMenuPublished)
			.where(eq(OrganizationMenuPublished.menuId, seed.menu.id))
		expect(publishedRows).toHaveLength(0)
	})

	it('records a failed channel without aborting the publish', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const seed = await seedMenu(organization.id)
		const channel = await seedChannel(organization.id, 'doordash')
		pushMenuMock.mockRejectedValue(new Error('DoorDash is down'))

		const result = await publishMenu({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			menuId: seed.menu.id,
			includeStorefront: true,
			integrationIds: [channel.id],
			userId: user.id,
		})

		expect(result.status).toBe('partial')
		expect(
			result.targets.filter((target) => target.status === 'success'),
		).toHaveLength(1)
		const failed = result.targets.find((target) => target.type === 'channel')
		expect(failed?.status).toBe('error')
		expect(failed?.error).toBe('DoorDash is down')

		const [state] = await db
			.select()
			.from(OrganizationMenuChannelState)
			.where(eq(OrganizationMenuChannelState.integrationId, channel.id))
		expect(state?.lastStatus).toBe('error')
		expect(state?.lastError).toBe('DoorDash is down')

		const [event] = await db
			.select()
			.from(OrganizationMenuPublish)
			.where(eq(OrganizationMenuPublish.menuId, seed.menu.id))
		expect(event?.status).toBe('partial')
	})

	it('throws for a menu outside the organization', async () => {
		const { organization, user } = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		const seed = await seedMenu(other.organization.id)

		const error: unknown = await publishMenu({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			menuId: seed.menu.id,
			includeStorefront: true,
			integrationIds: [],
			userId: user.id,
		}).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(Response)
		expect((error as Response).status).toBe(404)
	})

	it('recordChannelSync upserts the latest outcome per channel', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const seed = await seedMenu(organization.id)
		const channel = await seedChannel(organization.id)

		await recordChannelSync({
			organizationId: organization.id,
			menuId: seed.menu.id,
			integrationId: channel.id,
			status: 'success',
			pushedCount: 4,
		})
		await recordChannelSync({
			organizationId: organization.id,
			menuId: seed.menu.id,
			integrationId: channel.id,
			status: 'error',
			error: 'Boom',
		})

		const states = await db
			.select()
			.from(OrganizationMenuChannelState)
			.where(eq(OrganizationMenuChannelState.integrationId, channel.id))
		expect(states).toHaveLength(1)
		expect(states[0]?.lastStatus).toBe('error')
		expect(states[0]?.lastError).toBe('Boom')
		// An errored sync has no pushed count; the count reflects the last sync.
		expect(states[0]?.pushedCount).toBe(null)
	})
})
