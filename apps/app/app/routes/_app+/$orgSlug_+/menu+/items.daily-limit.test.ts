import {
	db,
	eq,
	OrganizationLocation,
	OrganizationMenuItem,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action as editAction, loader as editLoader } from './items.$itemId.tsx'
import { action as newAction, loader as newLoader } from './items.new.tsx'

// Flags, the site cache and the dish translation are the outer boundary;
// permissions and the database are real.
const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) =>
		flags.on.has(key) ? true : null,
	),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))
vi.mock('#app/utils/menu/menu-auto-translate.server.ts', () => ({
	autoTranslateNewItem: vi.fn().mockResolvedValue(undefined),
}))

const FLAG = 'ordering.daily_dish_limits'

async function setup(role: 'admin' | 'viewer' = 'admin') {
	const { organization, cookie } = await setupTestOrgWithUser(role)
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Main Street',
			slug: `main-${Math.random().toString(36).slice(2, 8)}`,
		})
		.returning()
	return { organization, location: location!, cookie }
}

function itemBody(extra: Record<string, string> = {}) {
	return new URLSearchParams({
		displayName: JSON.stringify({ en: 'Special' }),
		price: '10',
		...extra,
	})
}

function call(
	fn: (args: never) => Promise<unknown>,
	url: string,
	cookie: string,
	params: Record<string, string>,
	body?: URLSearchParams,
) {
	const request = createAuthenticatedRequest(
		url,
		body ? { method: 'POST', body } : {},
		cookie,
	)
	return fn({ request, params, context: {} } as never)
}

async function status(run: () => Promise<unknown>) {
	try {
		return getResponseStatus(await run())
	} catch (error) {
		if (error instanceof Response) return error.status
		throw error
	}
}

const create = (
	organization: { slug: string },
	cookie: string,
	extra: Record<string, string> = {},
) =>
	call(
		newAction,
		`https://app.test/${organization.slug}/menu/items/new`,
		cookie,
		{ orgSlug: organization.slug },
		itemBody(extra),
	)

const edit = (
	organization: { slug: string },
	cookie: string,
	itemId: string,
	extra: Record<string, string> = {},
) =>
	call(
		editAction,
		`https://app.test/${organization.slug}/menu/items/${itemId}`,
		cookie,
		{ orgSlug: organization.slug, itemId },
		itemBody(extra),
	)

async function itemsOf(organizationId: string) {
	return db
		.select()
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, organizationId))
}

async function seedItem(organizationId: string, dailySaleLimit: string | null) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId,
			displayName: JSON.stringify({ en: 'Special' }),
			price: 10,
			dailySaleLimit,
		})
		.returning()
	return row!
}

beforeEach(() => {
	flags.on.clear()
	vi.mocked(purgeOrganizationSiteCache).mockClear()
})

describe('saving a dish with a daily limit (#409)', () => {
	it('stores the limit the form posted, with its setting and a location of its own', async () => {
		const { organization, location, cookie } = await setup()
		const posted = {
			limit: 20,
			showRemaining: true,
			byLocation: { [location.id]: 8 },
		}
		const result = await create(organization, cookie, {
			dailySaleLimit: JSON.stringify(posted),
		})
		expect(getResponseStatus(result)).toBe(302)
		const [row] = await itemsOf(organization.id)
		expect(JSON.parse(row!.dailySaleLimit!)).toEqual(posted)
	})

	it('stores no limit for a form that posted none, or an empty one', async () => {
		const { organization, cookie } = await setup()
		await create(organization, cookie)
		await create(organization, cookie, { dailySaleLimit: '' })
		const rows = await itemsOf(organization.id)
		expect(rows).toHaveLength(2)
		expect(rows.every((row) => row.dailySaleLimit === null)).toBe(true)
	})

	it.each([
		['a limit of 0', { limit: 0 }],
		['a limit over the largest', { limit: 10_001 }],
		['a fraction', { limit: 2.5 }],
		['a location limit of 0', { limit: 5, byLocation: { x: 0 } }],
	])('refuses %s and creates nothing', async (_name, posted) => {
		const { organization, cookie } = await setup()
		const result = await create(organization, cookie, {
			dailySaleLimit: JSON.stringify(posted),
		})
		expect(getResponseStatus(result)).toBe(400)
		expect(await itemsOf(organization.id)).toHaveLength(0)
	})

	it('refuses text that is not a limit at all', async () => {
		const { organization, cookie } = await setup()
		const result = await create(organization, cookie, {
			dailySaleLimit: '{not json',
		})
		expect(getResponseStatus(result)).toBe(400)
		expect(await itemsOf(organization.id)).toHaveLength(0)
	})

	it("refuses a limit that names another organization's location, and creates nothing", async () => {
		const { organization, cookie } = await setup()
		const stranger = await createTestUser()
		const otherOrg = await createTestOrganization(stranger.id, 'admin')
		const [foreign] = await db
			.insert(OrganizationLocation)
			.values({
				organizationId: otherOrg.id,
				name: 'Theirs',
				slug: `theirs-${Math.random().toString(36).slice(2, 8)}`,
			})
			.returning()
		const code = await status(() =>
			create(organization, cookie, {
				dailySaleLimit: JSON.stringify({
					limit: 5,
					byLocation: { [foreign!.id]: 2 },
				}),
			}),
		)
		expect(code).toBeGreaterThanOrEqual(400)
		expect(await itemsOf(organization.id)).toHaveLength(0)
	})

	it('refuses a member who cannot change the menu', async () => {
		const { organization, cookie } = await setup('viewer')
		const code = await status(() =>
			create(organization, cookie, {
				dailySaleLimit: JSON.stringify({ limit: 5 }),
			}),
		)
		expect(code).toBe(403)
		expect(await itemsOf(organization.id)).toHaveLength(0)
	})
})

describe('editing the daily limit of a saved dish (#409)', () => {
	it('changes it, and clears it when the form posts it empty', async () => {
		const { organization, cookie } = await setup()
		const item = await seedItem(organization.id, JSON.stringify({ limit: 20 }))

		await edit(organization, cookie, item.id, {
			dailySaleLimit: JSON.stringify({ limit: 30, showRemaining: true }),
		})
		let [row] = await itemsOf(organization.id)
		expect(JSON.parse(row!.dailySaleLimit!)).toEqual({
			limit: 30,
			showRemaining: true,
		})

		await edit(organization, cookie, item.id, { dailySaleLimit: '' })
		;[row] = await itemsOf(organization.id)
		expect(row!.dailySaleLimit).toBeNull()
	})

	it('leaves a stored limit alone when the form did not post one (the feature was off)', async () => {
		const { organization, cookie } = await setup()
		const stored = JSON.stringify({ limit: 20, showRemaining: false })
		const item = await seedItem(organization.id, stored)
		const result = await edit(organization, cookie, item.id)
		expect(getResponseStatus(result)).toBe(302)
		const [row] = await itemsOf(organization.id)
		expect(row!.dailySaleLimit).toBe(stored)
	})

	it('does not change the stored limit when the new one is refused', async () => {
		const { organization, cookie } = await setup()
		const stored = JSON.stringify({ limit: 20, showRemaining: false })
		const item = await seedItem(organization.id, stored)
		const result = await edit(organization, cookie, item.id, {
			dailySaleLimit: JSON.stringify({ limit: 0 }),
		})
		expect(getResponseStatus(result)).toBe(400)
		const [row] = await itemsOf(organization.id)
		expect(row!.dailySaleLimit).toBe(stored)
	})
})

describe('the dish form loaders (#409)', () => {
	it('shows the card only while the feature is on, and the stored limit parsed', async () => {
		const { organization, cookie } = await setup()
		const item = await seedItem(
			organization.id,
			JSON.stringify({ limit: 20, showRemaining: true, byLocation: { a: 4 } }),
		)
		const load = () =>
			call(
				editLoader,
				`https://app.test/${organization.slug}/menu/items/${item.id}`,
				cookie,
				{ orgSlug: organization.slug, itemId: item.id },
			) as Promise<{
				dailyLimitsEnabled: boolean
				item: { dailySaleLimit: unknown }
			}>

		const off = await load()
		expect(off.dailyLimitsEnabled).toBe(false)
		// The stored limit is still read, so a form that shows it again has it.
		expect(off.item.dailySaleLimit).toEqual({
			limit: 20,
			showRemaining: true,
			byLocation: { a: 4 },
		})

		flags.on.add(FLAG)
		expect((await load()).dailyLimitsEnabled).toBe(true)
	})

	it('reads a limit it cannot parse as none instead of failing the page', async () => {
		const { organization, cookie } = await setup()
		const item = await seedItem(organization.id, '{not json')
		const loaded = (await call(
			editLoader,
			`https://app.test/${organization.slug}/menu/items/${item.id}`,
			cookie,
			{ orgSlug: organization.slug, itemId: item.id },
		)) as { item: { dailySaleLimit: unknown } }
		expect(loaded.item.dailySaleLimit).toBeNull()
	})

	it('offers the card on a new dish while the feature is on', async () => {
		const { organization, cookie } = await setup()
		flags.on.add(FLAG)
		const loaded = (await call(
			newLoader,
			`https://app.test/${organization.slug}/menu/items/new`,
			cookie,
			{ orgSlug: organization.slug },
		)) as { dailyLimitsEnabled: boolean }
		expect(loaded.dailyLimitsEnabled).toBe(true)
	})
})
