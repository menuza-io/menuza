import {
	and,
	db,
	eq,
	MenuCheckDismissal,
	OrganizationMenu,
	OrganizationMenuCategory,
	OrganizationMenuCategoryAssignment,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { loadMenuHealth } from '#app/utils/menu/menu-health.server.ts'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))

import { action } from './checks.ts'

type Setup = Awaited<ReturnType<typeof setupTestOrgWithUser>>

async function post(
	{ organization, cookie }: Setup,
	body: unknown,
): Promise<Response> {
	const request = new Request(
		`https://app.example/${organization.slug}/menu/checks`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		},
	)
	try {
		return (await action({
			request,
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

async function dish(organizationId: string, name: string, patch: object = {}) {
	const [menu] = await db
		.insert(OrganizationMenu)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: 'Main' }),
			availabilityStatus: 'available',
		})
		.returning()
	const [category] = await db
		.insert(OrganizationMenuCategory)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: 'Mains' }),
			availabilityStatus: 'available',
		})
		.returning()
	await db.insert(OrganizationMenuCategoryAssignment).values({
		menuId: menu!.id,
		categoryId: category!.id,
	})
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: name }),
			description: JSON.stringify({ en: 'Tasty' }),
			imageKey: 'menu/x.jpg',
			price: 8,
			allergens: '["sesame"]',
			updatedAt: new Date('2026-01-01T00:00:00Z'),
			...patch,
		})
		.returning()
	await db.insert(OrganizationMenuItemCategoryAssignment).values({
		categoryId: category!.id,
		itemId: row!.id,
	})
	return row!
}

const orgOf = (setup: Setup) => ({
	id: setup.organization.id,
	siteLocales: null,
	siteDefaultLocale: null,
})

const rows = (setup: Setup, entityId: string, checkKey: string) =>
	db
		.select()
		.from(MenuCheckDismissal)
		.where(
			and(
				eq(MenuCheckDismissal.organizationId, setup.organization.id),
				eq(MenuCheckDismissal.entityId, entityId),
				eq(MenuCheckDismissal.checkKey, checkKey),
			),
		)

describe('POST /:orgSlug/menu/checks', () => {
	it('dismiss lowers fixCount on the next load and restore brings it back', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const item = await dish(setup.organization.id, 'Falafel', {
			imageKey: null,
		})
		const org = orgOf(setup)
		const before = await loadMenuHealth(org)
		expect(before.fixCount).toBe(1)

		const dismissed = await post(setup, {
			intent: 'dismiss',
			checkKey: 'no_photo',
			entityId: item.id,
		})
		expect(dismissed.status).toBe(200)
		expect(await dismissed.json()).toEqual({ ok: true })
		const during = await loadMenuHealth(org)
		expect(during.fixCount).toBe(0)
		expect(during.score).toBeGreaterThan(before.score)
		expect(
			during.checks.find((c) => c.key === 'no_photo')?.dismissedIds,
		).toEqual([item.id])
		const [row] = await rows(setup, item.id, 'no_photo')
		expect(row).toMatchObject({
			entityType: 'item',
			reason: 'on_purpose',
			createdById: setup.user.id,
		})

		const restored = await post(setup, {
			intent: 'restore',
			checkKey: 'no_photo',
			entityId: item.id,
		})
		expect(restored.status).toBe(200)
		const after = await loadMenuHealth(org)
		expect(after.fixCount).toBe(1)
		expect(after.score).toBe(before.score)
		expect(await rows(setup, item.id, 'no_photo')).toHaveLength(0)
	})

	it('restoring something never dismissed is 404', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const item = await dish(setup.organization.id, 'Falafel', {
			imageKey: null,
		})
		const response = await post(setup, {
			intent: 'restore',
			checkKey: 'no_photo',
			entityId: item.id,
		})
		expect(response.status).toBe(404)
	})

	it('dismissing a passing record is 400 not_failing', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const item = await dish(setup.organization.id, 'Hummus')
		const response = await post(setup, {
			intent: 'dismiss',
			checkKey: 'no_photo',
			entityId: item.id,
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ ok: false, error: 'not_failing' })
		expect(await rows(setup, item.id, 'no_photo')).toHaveLength(0)
	})

	it('unknown and other-organization records are 404', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		const theirs = await dish(other.organization.id, 'Falafel', {
			imageKey: null,
		})
		for (const entityId of ['does-not-exist', theirs.id]) {
			const response = await post(setup, {
				intent: 'dismiss',
				checkKey: 'no_photo',
				entityId,
			})
			expect(response.status).toBe(404)
			expect(await response.json()).toEqual({ ok: false, error: 'not_found' })
		}
		expect(await rows(other, theirs.id, 'no_photo')).toHaveLength(0)
		expect(await rows(setup, theirs.id, 'no_photo')).toHaveLength(0)
	})

	it('a group check with a dish id is 404 (wrong entity type)', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const item = await dish(setup.organization.id, 'Falafel')
		const response = await post(setup, {
			intent: 'dismiss',
			checkKey: 'empty_option_group',
			entityId: item.id,
		})
		expect(response.status).toBe(404)
	})

	it('card: keys and bad bodies are 400 invalid_input', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const item = await dish(setup.organization.id, 'Falafel', {
			imageKey: null,
		})
		for (const body of [
			{ intent: 'dismiss', checkKey: 'card:x', entityId: item.id },
			{ intent: 'dismiss', checkKey: 'bogus', entityId: item.id },
			{ intent: 'dismiss', checkKey: 'no_photo', entityId: '' },
			{
				intent: 'dismiss',
				checkKey: 'no_photo',
				entityId: item.id,
				reason: 'x',
			},
			{ intent: 'nope', checkKey: 'no_photo', entityId: item.id },
			'not json',
		]) {
			const response = await post(setup, body)
			expect(response.status).toBe(400)
			expect(await response.json()).toEqual({
				ok: false,
				error: 'invalid_input',
			})
		}
		expect(await rows(setup, item.id, 'card:x')).toHaveLength(0)
	})

	it('a viewer cannot dismiss or restore', async () => {
		const setup = await setupTestOrgWithUser('viewer')
		const item = await dish(setup.organization.id, 'Falafel', {
			imageKey: null,
		})
		for (const intent of ['dismiss', 'restore']) {
			const response = await post(setup, {
				intent,
				checkKey: 'no_photo',
				entityId: item.id,
			})
			expect(response.status).toBe(403)
		}
		expect(await rows(setup, item.id, 'no_photo')).toHaveLength(0)
	})

	it('renaming an ALL-CAPS dish to another ALL-CAPS name revives the check', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const item = await dish(setup.organization.id, 'BBQ WINGS')
		const org = orgOf(setup)
		expect((await loadMenuHealth(org)).fixCount).toBe(1)
		const response = await post(setup, {
			intent: 'dismiss',
			checkKey: 'name_all_caps',
			entityId: item.id,
		})
		expect(response.status).toBe(200)
		expect((await loadMenuHealth(org)).fixCount).toBe(0)
		expect(await rows(setup, item.id, 'name_all_caps')).toHaveLength(1)

		await db
			.update(OrganizationMenuItem)
			.set({ displayName: JSON.stringify({ en: 'BBQ RIBS' }) })
			.where(eq(OrganizationMenuItem.id, item.id))
		const revived = await loadMenuHealth(org)
		expect(revived.fixCount).toBe(1)
		expect(revived.staleDismissals).toEqual([
			expect.objectContaining({ entityId: item.id, checkKey: 'name_all_caps' }),
		])
		// The next load has already deleted the stale row.
		expect(await rows(setup, item.id, 'name_all_caps')).toHaveLength(0)
		expect((await loadMenuHealth(org)).staleDismissals).toEqual([])
	})

	it('fixing the problem drops the dismissal, and it does not come back with it', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const item = await dish(setup.organization.id, 'Falafel', {
			imageKey: null,
		})
		const org = orgOf(setup)
		await post(setup, {
			intent: 'dismiss',
			checkKey: 'no_photo',
			entityId: item.id,
		})
		await db
			.update(OrganizationMenuItem)
			.set({ imageKey: 'menu/f.jpg' })
			.where(eq(OrganizationMenuItem.id, item.id))
		await loadMenuHealth(org)
		expect(await rows(setup, item.id, 'no_photo')).toHaveLength(0)
		await db
			.update(OrganizationMenuItem)
			.set({ imageKey: null })
			.where(eq(OrganizationMenuItem.id, item.id))
		expect((await loadMenuHealth(org)).fixCount).toBe(1)
	})

	it('dismissing twice keeps one row', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const item = await dish(setup.organization.id, 'Falafel', {
			imageKey: null,
		})
		for (const reason of ['on_purpose', 'not_applicable']) {
			const response = await post(setup, {
				intent: 'dismiss',
				checkKey: 'no_photo',
				entityId: item.id,
				reason,
			})
			expect(response.status).toBe(200)
		}
		const found = await rows(setup, item.id, 'no_photo')
		expect(found).toHaveLength(1)
		expect(found[0]!.reason).toBe('not_applicable')
	})

	it('load leaves card: rows alone', async () => {
		const setup = await setupTestOrgWithUser('admin')
		const item = await dish(setup.organization.id, 'Hummus')
		await db.insert(MenuCheckDismissal).values({
			organizationId: setup.organization.id,
			entityType: 'item',
			entityId: item.id,
			checkKey: 'card:translation',
			reason: 'on_purpose',
			fingerprint: 'x',
			createdById: setup.user.id,
		} as never)
		await loadMenuHealth(orgOf(setup))
		expect(await rows(setup, item.id, 'card:translation')).toHaveLength(1)
	})
})
