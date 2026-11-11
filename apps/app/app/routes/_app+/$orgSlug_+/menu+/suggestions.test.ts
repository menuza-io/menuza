import {
	ConfigFlag,
	db,
	eq,
	Organization,
	OrganizationMenuCategory,
	OrganizationMenuItem,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENU_SUGGESTIONS_RATE_LIMIT } from '#app/utils/menu/menu-suggestions.server.ts'
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

const mocks = vi.hoisted(() => ({
	generateContent: vi.fn(),
	purge: vi.fn(async () => true),
}))

vi.mock('@repo/ai/server', () => ({ generateContent: mocks.generateContent }))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: mocks.purge,
}))

import { action } from './suggestions.ts'

type Setup = Awaited<ReturnType<typeof setupTestOrgWithUser>>

async function setup(role: 'admin' | 'viewer' = 'admin'): Promise<Setup> {
	const result = await setupTestOrgWithUser(role)
	await db
		.update(Organization)
		.set({ siteLocales: '["en","ar"]', siteDefaultLocale: 'en' })
		.where(eq(Organization.id, result.organization.id))
	return result
}

async function post(
	{ organization, cookie }: Setup,
	body: unknown,
): Promise<Response> {
	const request = new Request(
		`https://app.example/${organization.slug}/menu/suggestions`,
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

async function dish(organizationId: string, patch: object = {}) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: '{"en":"Falafel"}',
			...patch,
		})
		.returning()
	return row!
}

async function readItem(id: string) {
	const [row] = await db
		.select()
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.id, id))
	return row!
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.generateContent.mockResolvedValue('{"descriptions":[]}')
})

const flagOrgs: string[] = []
afterEach(async () => {
	for (const id of flagOrgs.splice(0)) {
		await db.delete(ConfigFlag).where(eq(ConfigFlag.organizationId, id))
	}
})

describe('menu review suggestions permissions', () => {
	it('refuses members without menu write access before reading the body', async () => {
		const viewer = await setup('viewer')
		const item = await dish(viewer.organization.id)

		for (const body of [
			{ intent: 'generate' },
			{
				intent: 'set-text',
				reason: 'translation',
				itemId: item.id,
				changes: [{ field: 'displayName', locale: 'ar', value: 'فلافل' }],
			},
			{ intent: 'set-auto-translate', enabled: true },
		]) {
			const response = await post(viewer, body)
			expect(response.status).toBe(403)
		}
		expect(mocks.generateContent).not.toHaveBeenCalled()
		expect((await readItem(item.id)).displayName).toBe('{"en":"Falafel"}')
	})

	it('cannot touch another organization’s dish', async () => {
		const admin = await setup()
		const other = await setup()
		const theirs = await dish(other.organization.id)
		const response = await post(admin, {
			intent: 'set-text',
			reason: 'translation',
			itemId: theirs.id,
			changes: [{ field: 'displayName', locale: 'ar', value: 'فلافل' }],
		})
		expect(response.status).toBe(404)
		expect((await readItem(theirs.id)).displayName).toBe('{"en":"Falafel"}')
	})

	it('rate limits AI batches per organization', async () => {
		const admin = await setup()
		await dish(admin.organization.id)
		const original = MENU_SUGGESTIONS_RATE_LIMIT.maxRequests
		MENU_SUGGESTIONS_RATE_LIMIT.maxRequests = 1
		try {
			expect((await post(admin, { intent: 'generate' })).status).toBe(200)
			const limited = await post(admin, { intent: 'generate' })
			expect(limited.status).toBe(429)
			expect(await limited.json()).toEqual({
				ok: false,
				error: 'rate_limited',
			})
		} finally {
			MENU_SUGGESTIONS_RATE_LIMIT.maxRequests = original
		}
	})
})

describe('menu review suggestions writes', () => {
	it('accepts a translation, cleans it and undoes it', async () => {
		const admin = await setup()
		const item = await dish(admin.organization.id)
		const response = await post(admin, {
			intent: 'set-text',
			reason: 'translation',
			itemId: item.id,
			changes: [{ field: 'displayName', locale: 'ar', value: '<b>فلافل</b>' }],
		})
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			results: Array<{ previous: unknown[] }>
		}
		expect(JSON.parse((await readItem(item.id)).displayName)).toEqual({
			en: 'Falafel',
			ar: 'فلافل',
		})
		expect(mocks.purge).toHaveBeenCalled()

		const undo = await post(admin, {
			intent: 'set-text',
			reason: 'undo',
			itemId: item.id,
			changes: body.results[0]!.previous,
		})
		expect(undo.status).toBe(200)
		expect(JSON.parse((await readItem(item.id)).displayName)).toEqual({
			en: 'Falafel',
		})
	})

	it('keeps each kind to its own languages', async () => {
		const admin = await setup()
		const item = await dish(admin.organization.id)
		const overwriteSource = await post(admin, {
			intent: 'set-text',
			reason: 'translation',
			itemId: item.id,
			changes: [{ field: 'displayName', locale: 'en', value: 'Hacked' }],
		})
		expect(overwriteSource.status).toBe(400)
		const translatedDescription = await post(admin, {
			intent: 'set-text',
			reason: 'description',
			itemId: item.id,
			changes: [{ field: 'description', locale: 'ar', value: 'وصف' }],
		})
		expect(translatedDescription.status).toBe(400)
		const empty = await post(admin, {
			intent: 'set-text',
			reason: 'description',
			itemId: item.id,
			changes: [{ field: 'description', locale: 'en', value: '<br>' }],
		})
		expect(empty.status).toBe(400)
		expect(await readItem(item.id)).toMatchObject({
			displayName: '{"en":"Falafel"}',
			description: null,
		})
		expect((await post(admin, 'not json')).status).toBe(400)
	})

	it('accepts all translations at once and undoes them together', async () => {
		const admin = await setup()
		const a = await dish(admin.organization.id, { displayName: '{"en":"Tea"}' })
		const b = await dish(admin.organization.id, {
			displayName: '{"en":"Soup"}',
		})
		const response = await post(admin, {
			intent: 'set-text-bulk',
			reason: 'translation',
			entries: [
				{
					itemId: a.id,
					changes: [{ field: 'displayName', locale: 'ar', value: 'شاي' }],
				},
				{
					itemId: b.id,
					changes: [{ field: 'displayName', locale: 'ar', value: 'شوربة' }],
				},
			],
		})
		expect(response.status).toBe(200)
		const { results } = (await response.json()) as {
			results: Array<{ itemId: string; previous: unknown[] }>
		}
		expect(JSON.parse((await readItem(b.id)).displayName)).toEqual({
			en: 'Soup',
			ar: 'شوربة',
		})
		await post(admin, {
			intent: 'set-text-bulk',
			reason: 'undo',
			entries: results.map((result) => ({
				itemId: result.itemId,
				changes: result.previous,
			})),
		})
		expect((await readItem(a.id)).displayName).toBe('{"en":"Tea"}')
		expect((await readItem(b.id)).displayName).toBe('{"en":"Soup"}')
	})

	it('makes a long-unavailable dish available and undo puts it back as it was', async () => {
		const admin = await setup()
		const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
		const item = await dish(admin.organization.id, {
			availabilityStatus: 'unavailable',
			updatedAt: old,
		})
		const hideWithWrongTarget = await post(admin, {
			intent: 'set-item-availability',
			reason: 'hide',
			itemId: item.id,
			availability: { availabilityStatus: 'available' },
		})
		expect(hideWithWrongTarget.status).toBe(400)

		const response = await post(admin, {
			intent: 'set-item-availability',
			reason: 'make_available',
			itemId: item.id,
			availability: { availabilityStatus: 'available' },
		})
		const { previous } = (await response.json()) as {
			previous: {
				availabilityStatus: string
				unavailableUntil: string | null
				updatedAt: string
			}
		}
		expect((await readItem(item.id)).availabilityStatus).toBe('available')

		await post(admin, {
			intent: 'set-item-availability',
			reason: 'undo',
			itemId: item.id,
			availability: {
				availabilityStatus: previous.availabilityStatus,
				unavailableUntil: previous.unavailableUntil,
			},
			restoreUpdatedAt: previous.updatedAt,
		})
		const restored = await readItem(item.id)
		expect(restored.availabilityStatus).toBe('unavailable')
		expect(restored.updatedAt.getTime()).toBe(old.getTime())
	})

	it('hides an empty category and undo shows it again', async () => {
		const admin = await setup()
		const [category] = await db
			.insert(OrganizationMenuCategory)
			.values({
				organizationId: admin.organization.id,
				displayName: '{"en":"Specials"}',
			})
			.returning()
		const response = await post(admin, {
			intent: 'set-category-availability',
			reason: 'hide',
			categoryId: category!.id,
			availability: { availabilityStatus: 'hidden' },
		})
		const { previous } = (await response.json()) as {
			previous: { availabilityStatus: string }
		}
		const read = async () =>
			(
				await db
					.select({ status: OrganizationMenuCategory.availabilityStatus })
					.from(OrganizationMenuCategory)
					.where(eq(OrganizationMenuCategory.id, category!.id))
			)[0]?.status
		expect(await read()).toBe('hidden')
		await post(admin, {
			intent: 'set-category-availability',
			reason: 'undo',
			categoryId: category!.id,
			availability: previous,
		})
		expect(await read()).toBe('available')
	})

	it('stores the auto-translate toggle on the organization', async () => {
		const admin = await setup()
		flagOrgs.push(admin.organization.id)
		const response = await post(admin, {
			intent: 'set-auto-translate',
			enabled: true,
		})
		expect(await response.json()).toEqual({ ok: true, enabled: true })
		const [flag] = await db
			.select({ value: ConfigFlag.value, level: ConfigFlag.level })
			.from(ConfigFlag)
			.where(eq(ConfigFlag.organizationId, admin.organization.id))
		expect(flag).toEqual({ value: true, level: 'organization' })
	})
})
