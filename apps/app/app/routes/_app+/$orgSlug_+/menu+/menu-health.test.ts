import {
	db,
	MenuCheckDismissal,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemModifierGroupAssignment,
	OrganizationMenuModifierGroup,
	eq,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

import { loader as overviewLoader } from './_index.tsx'
import { loader as categoriesLoader } from './categories._index.tsx'
import { action as checksAction } from './checks.ts'
import { loader as itemsLoader } from './items._index.tsx'
import { loader as modifiersLoader } from './modifiers._index.tsx'

type Setup = Awaited<ReturnType<typeof setupTestOrgWithUser>>

const OLD = new Date('2026-01-01T00:00:00Z')

async function dish(organizationId: string, name: string, patch: object = {}) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: name }),
			description: JSON.stringify({ en: 'Tasty' }),
			imageKey: 'menu/x.jpg',
			price: 8,
			allergens: '["sesame"]',
			updatedAt: OLD,
			...patch,
		})
		.returning()
	return row!
}

async function load(
	loader: unknown,
	{ organization, cookie }: Setup,
	path: string,
) {
	const request = new Request(
		`https://app.example/${organization.slug}/menu/${path}`,
		{
			headers: { cookie },
		},
	)
	return (await (loader as (args: unknown) => Promise<any>)({
		request,
		url: new URL(request.url),
		pattern: '/:orgSlug/menu',
		params: { orgSlug: organization.slug },
		context: new RouterContextProvider(),
	})) as any
}

async function dismiss(setup: Setup, body: object) {
	const request = new Request(
		`https://app.example/${setup.organization.slug}/menu/checks`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: setup.cookie },
			body: JSON.stringify(body),
		},
	)
	try {
		return (await checksAction({
			request,
			params: { orgSlug: setup.organization.slug },
			context: new RouterContextProvider(),
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

const checkOf = (data: any, key: string) =>
	data.health.checks.find((c: { key: string }) => c.key === key)

describe('menu health loaders', () => {
	let setup: Setup
	let withPhoto: Awaited<ReturnType<typeof dish>>
	let noPhoto: Awaited<ReturnType<typeof dish>>

	beforeEach(async () => {
		setup = await setupTestOrgWithUser('admin')
		const orgId = setup.organization.id
		withPhoto = await dish(orgId, 'Hummus')
		noPhoto = await dish(orgId, 'Falafel', { imageKey: null })
		await db.insert(OrganizationMenuCategory).values([
			{ organizationId: orgId, displayName: 'Mezze' },
			{ organizationId: orgId, displayName: 'Desserts' },
		])
	})

	it('returns grade, fixCount and named records per check on the overview', async () => {
		const data = await load(overviewLoader, setup, '')
		expect(data.health.itemCount).toBe(2)
		expect(data.health.grade).toMatch(/^[ABCDF]$/)
		expect(data.health.score).toBeLessThan(100)
		// no_photo (1) + empty categories (2) + both dishes are on no published menu (2).
		expect(data.health.fixCount).toBe(5)
		expect(checkOf(data, 'dishes_guests_cannot_see')).toMatchObject({
			entityType: 'item',
			count: 2,
		})
		expect(checkOf(data, 'no_photo')).toMatchObject({
			key: 'no_photo',
			severity: 'warning',
			count: 1,
			total: 2,
			entityType: 'item',
			records: [{ id: noPhoto.id, name: 'Falafel' }],
			dismissedCount: 0,
			dismissed: [],
		})
		expect(checkOf(data, 'empty_category')).toMatchObject({
			entityType: 'category',
			count: 2,
		})
		expect(JSON.stringify(data.health)).not.toContain('fingerprint')
	})

	it('shows a dismissed record under dismissed and changes the score on the next load', async () => {
		const before = await load(overviewLoader, setup, '')
		const response = await dismiss(setup, {
			intent: 'dismiss',
			checkKey: 'no_photo',
			entityId: noPhoto.id,
		})
		expect(response.status).toBe(200)
		const after = await load(overviewLoader, setup, '')
		expect(checkOf(after, 'no_photo')).toMatchObject({
			count: 0,
			dismissedCount: 1,
			records: [],
			dismissed: [{ id: noPhoto.id, name: 'Falafel' }],
		})
		expect(after.health.fixCount).toBe(before.health.fixCount - 1)
		expect(after.health.score).toBeGreaterThan(before.health.score)
	})

	it('keeps the dismissal of a hidden dish and applies it again when shown', async () => {
		await dismiss(setup, {
			intent: 'dismiss',
			checkKey: 'no_photo',
			entityId: noPhoto.id,
		})
		const rows = () =>
			db
				.select()
				.from(MenuCheckDismissal)
				.where(eq(MenuCheckDismissal.entityId, noPhoto.id))
		expect(await rows()).toHaveLength(1)
		await db
			.update(OrganizationMenuItem)
			.set({ availabilityStatus: 'hidden' })
			.where(eq(OrganizationMenuItem.id, noPhoto.id))
		await load(overviewLoader, setup, '')
		expect(await rows()).toHaveLength(1)
		await db
			.update(OrganizationMenuItem)
			.set({ availabilityStatus: 'available' })
			.where(eq(OrganizationMenuItem.id, noPhoto.id))
		const shown = await load(overviewLoader, setup, '')
		expect(checkOf(shown, 'no_photo')).toMatchObject({
			count: 0,
			dismissedCount: 1,
		})
	})

	it('does not delete a stale dismissal that was saved again with a new fingerprint', async () => {
		const orgId = setup.organization.id
		const { deleteStaleDismissals } =
			await import('#app/utils/menu/menu-health.server.ts')
		const [row] = await db
			.insert(MenuCheckDismissal)
			.values({
				organizationId: orgId,
				entityType: 'item',
				entityId: withPhoto.id,
				checkKey: 'no_photo',
				fingerprint: 'old00000',
			})
			.returning()
		// The load saw 'old00000'; before the delete it was saved again.
		await db
			.update(MenuCheckDismissal)
			.set({ fingerprint: 'new00000' })
			.where(eq(MenuCheckDismissal.id, row!.id))
		await deleteStaleDismissals(orgId, [
			{
				entityId: withPhoto.id,
				checkKey: 'no_photo',
				fingerprint: 'old00000',
			},
		])
		expect(
			await db
				.select()
				.from(MenuCheckDismissal)
				.where(eq(MenuCheckDismissal.id, row!.id)),
		).toHaveLength(1)
		await deleteStaleDismissals(orgId, [
			{
				entityId: withPhoto.id,
				checkKey: 'no_photo',
				fingerprint: 'new00000',
			},
		])
		expect(
			await db
				.select()
				.from(MenuCheckDismissal)
				.where(eq(MenuCheckDismissal.id, row!.id)),
		).toHaveLength(0)
	})

	it('filters the items list with ?health=, leaving out a dismissed dish', async () => {
		const data = await load(itemsLoader, setup, 'items?health=no_photo')
		expect(data.healthFilter).toEqual({
			key: 'no_photo',
			itemIds: [noPhoto.id],
		})
		await dismiss(setup, {
			intent: 'dismiss',
			checkKey: 'no_photo',
			entityId: noPhoto.id,
		})
		const after = await load(itemsLoader, setup, 'items?health=no_photo')
		expect(after.healthFilter).toEqual({ key: 'no_photo', itemIds: [] })
		expect(withPhoto.id).toBeTruthy()
	})

	it('ignores unknown, category and group keys on the items list', async () => {
		for (const key of ['bogus', 'empty_category', 'empty_option_group']) {
			expect(
				(await load(itemsLoader, setup, `items?health=${key}`)).healthFilter,
			).toBeNull()
		}
	})

	it('filters the categories list to empty categories', async () => {
		const data = await load(
			categoriesLoader,
			setup,
			'categories?health=empty_category',
		)
		expect(data.healthFilter.key).toBe('empty_category')
		expect(data.healthFilter.categoryIds).toHaveLength(2)
		expect(
			(await load(categoriesLoader, setup, 'categories?health=no_photo'))
				.healthFilter,
		).toBeNull()
	})

	it('filters the modifier groups list with ?health=empty_option_group', async () => {
		const orgId = setup.organization.id
		const [empty, other] = await db
			.insert(OrganizationMenuModifierGroup)
			.values([
				{ organizationId: orgId, name: 'Sauces' },
				{ organizationId: orgId, name: 'Unattached' },
			])
			.returning()
		await db.insert(OrganizationMenuItemModifierGroupAssignment).values({
			itemId: withPhoto.id,
			modifierGroupId: empty!.id,
		})
		const data = await load(
			modifiersLoader,
			setup,
			'modifiers?health=empty_option_group',
		)
		expect(data.healthFilter).toEqual({
			key: 'empty_option_group',
			modifierGroupIds: [empty!.id],
		})
		expect(other!.id).not.toBe(empty!.id)
		expect(
			(await load(modifiersLoader, setup, 'modifiers?health=no_photo'))
				.healthFilter,
		).toBeNull()
	})
})

it('rows of another organization never affect the count', async () => {
	const a = await setupTestOrgWithUser('admin')
	const b = await setupTestOrgWithUser('admin')
	await dish(a.organization.id, 'Hummus')
	await dish(b.organization.id, 'Hummus', { imageKey: null })
	const data = await load(overviewLoader, a, '')
	expect(checkOf(data, 'no_photo').count).toBe(0)
	expect(
		await db
			.select()
			.from(MenuCheckDismissal)
			.where(eq(MenuCheckDismissal.organizationId, a.organization.id)),
	).toEqual([])
})
