import {
	db,
	eq,
	OrganizationLocation,
	OrganizationMenuOption,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { loader as groupNewLoader } from './modifiers.new.tsx'
import {
	action as editAction,
	loader as editLoader,
} from './options.$optionId.tsx'
import { action as newAction, loader as newLoader } from './options.new.tsx'

// Flags and the site cache are the outer boundary; permissions and the
// database are real.
const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) =>
		flags.on.has(key) ? true : null,
	),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))

const FLAG = 'ordering.daily_dish_limits'
const name = (value: string) => JSON.stringify({ en: value })

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

function body(extra: Record<string, string> = {}) {
	return new URLSearchParams({
		displayName: name('Dessert'),
		price: '2',
		...extra,
	})
}

function call(
	fn: (args: never) => Promise<unknown>,
	url: string,
	cookie: string,
	params: Record<string, string>,
	form?: URLSearchParams,
) {
	const request = createAuthenticatedRequest(
		url,
		form ? { method: 'POST', body: form } : {},
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
		`https://app.test/${organization.slug}/menu/options/new`,
		cookie,
		{ orgSlug: organization.slug },
		body(extra),
	)

const edit = (
	organization: { slug: string },
	cookie: string,
	optionId: string,
	extra: Record<string, string> = {},
) =>
	call(
		editAction,
		`https://app.test/${organization.slug}/menu/options/${optionId}`,
		cookie,
		{ orgSlug: organization.slug, optionId },
		body(extra),
	)

async function optionsOf(organizationId: string) {
	return db
		.select()
		.from(OrganizationMenuOption)
		.where(eq(OrganizationMenuOption.organizationId, organizationId))
}

async function seedOption(
	organizationId: string,
	dailySaleLimit: string | null,
) {
	const [row] = await db
		.insert(OrganizationMenuOption)
		.values({
			organizationId,
			displayName: name('Dessert'),
			price: 2,
			dailySaleLimit,
		})
		.returning()
	return row!
}

async function foreignLocation() {
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
	return foreign!
}

beforeEach(() => {
	flags.on.clear()
})

describe('creating an option with a daily limit (#409)', () => {
	it('stores the limit the form posted, with its setting and a location of its own', async () => {
		const { organization, location, cookie } = await setup()
		const posted = {
			limit: 12,
			showRemaining: true,
			byLocation: { [location.id]: 4 },
		}
		const result = await create(organization, cookie, {
			dailySaleLimit: JSON.stringify(posted),
		})
		expect(getResponseStatus(result)).toBe(302)
		const [row] = await optionsOf(organization.id)
		expect(JSON.parse(row!.dailySaleLimit!)).toEqual(posted)
	})

	it('stores no limit for a form that posted none, or an empty one', async () => {
		const { organization, cookie } = await setup()
		await create(organization, cookie)
		await create(organization, cookie, { dailySaleLimit: '' })
		const rows = await optionsOf(organization.id)
		expect(rows).toHaveLength(2)
		expect(rows.every((row) => row.dailySaleLimit === null)).toBe(true)
	})

	it.each([
		['a limit of 0', { limit: 0 }],
		['a limit over the largest', { limit: 10_001 }],
		['a fraction', { limit: 2.5 }],
		['a location limit of 0', { limit: 5, byLocation: { x: 0 } }],
		['no limit anywhere', { limit: null }],
	])('refuses %s and creates nothing', async (_name, posted) => {
		const { organization, cookie } = await setup()
		const result = await create(organization, cookie, {
			dailySaleLimit: JSON.stringify(posted),
		})
		expect(getResponseStatus(result)).toBe(400)
		expect(await optionsOf(organization.id)).toHaveLength(0)
	})

	it('refuses text that is not a limit at all', async () => {
		const { organization, cookie } = await setup()
		const result = await create(organization, cookie, {
			dailySaleLimit: '{not json',
		})
		expect(getResponseStatus(result)).toBe(400)
		expect(await optionsOf(organization.id)).toHaveLength(0)
	})

	it("refuses a limit that names another organization's location, and creates nothing", async () => {
		const { organization, cookie } = await setup()
		const foreign = await foreignLocation()
		const code = await status(() =>
			create(organization, cookie, {
				dailySaleLimit: JSON.stringify({
					limit: 5,
					byLocation: { [foreign.id]: 2 },
				}),
			}),
		)
		expect(code).toBeGreaterThanOrEqual(400)
		expect(await optionsOf(organization.id)).toHaveLength(0)
	})

	it('refuses a member who cannot change the menu', async () => {
		const { organization, cookie } = await setup('viewer')
		const code = await status(() =>
			create(organization, cookie, {
				dailySaleLimit: JSON.stringify({ limit: 5 }),
			}),
		)
		expect(code).toBe(403)
		expect(await optionsOf(organization.id)).toHaveLength(0)
	})
})

describe('editing the daily limit of a saved option (#409)', () => {
	it('changes it, and clears it when the form posts it empty', async () => {
		const { organization, cookie } = await setup()
		const option = await seedOption(
			organization.id,
			JSON.stringify({ limit: 12 }),
		)

		await edit(organization, cookie, option.id, {
			dailySaleLimit: JSON.stringify({ limit: 30, showRemaining: true }),
		})
		let [row] = await optionsOf(organization.id)
		expect(JSON.parse(row!.dailySaleLimit!)).toEqual({
			limit: 30,
			showRemaining: true,
		})

		await edit(organization, cookie, option.id, { dailySaleLimit: '' })
		;[row] = await optionsOf(organization.id)
		expect(row!.dailySaleLimit).toBeNull()
	})

	it('leaves a stored limit alone when the form did not post one (the feature was off)', async () => {
		const { organization, cookie } = await setup()
		const stored = JSON.stringify({ limit: 12, showRemaining: false })
		const option = await seedOption(organization.id, stored)
		const result = await edit(organization, cookie, option.id, { price: '5' })
		expect(getResponseStatus(result)).toBe(302)
		const [row] = await optionsOf(organization.id)
		expect(row!.price).toBe(5)
		expect(row!.dailySaleLimit).toBe(stored)
	})

	it('does not change the stored limit when the new one is refused', async () => {
		const { organization, cookie } = await setup()
		const stored = JSON.stringify({ limit: 12, showRemaining: false })
		const option = await seedOption(organization.id, stored)
		const result = await edit(organization, cookie, option.id, {
			dailySaleLimit: JSON.stringify({ limit: 0 }),
		})
		expect(getResponseStatus(result)).toBe(400)
		expect((await optionsOf(organization.id))[0]!.dailySaleLimit).toBe(stored)
	})

	it("refuses another organization's location and keeps the stored limit", async () => {
		const { organization, cookie } = await setup()
		const stored = JSON.stringify({ limit: 12, showRemaining: false })
		const option = await seedOption(organization.id, stored)
		const foreign = await foreignLocation()
		const code = await status(() =>
			edit(organization, cookie, option.id, {
				dailySaleLimit: JSON.stringify({
					limit: 5,
					byLocation: { [foreign.id]: 1 },
				}),
			}),
		)
		expect(code).toBeGreaterThanOrEqual(400)
		expect((await optionsOf(organization.id))[0]!.dailySaleLimit).toBe(stored)
	})

	it('refuses a member who cannot change the menu and keeps the limit', async () => {
		const { organization, cookie } = await setup('viewer')
		const stored = JSON.stringify({ limit: 12, showRemaining: false })
		const option = await seedOption(organization.id, stored)
		const code = await status(() =>
			edit(organization, cookie, option.id, { dailySaleLimit: '' }),
		)
		expect(code).toBe(403)
		expect((await optionsOf(organization.id))[0]!.dailySaleLimit).toBe(stored)
	})
})

describe('the option form loaders (#409)', () => {
	const loadEdit = (
		organization: { slug: string },
		cookie: string,
		optionId: string,
	) =>
		call(
			editLoader,
			`https://app.test/${organization.slug}/menu/options/${optionId}`,
			cookie,
			{ orgSlug: organization.slug, optionId },
		) as Promise<{
			dailyLimitsEnabled: boolean
			initialData: { dailySaleLimit: unknown }
		}>

	it('shows the card only while the feature is on, and the stored limit parsed', async () => {
		const { organization, cookie } = await setup()
		const option = await seedOption(
			organization.id,
			JSON.stringify({ limit: 12, showRemaining: true, byLocation: { a: 4 } }),
		)
		const off = await loadEdit(organization, cookie, option.id)
		expect(off.dailyLimitsEnabled).toBe(false)
		// Still read while hidden, so the form has it when it is shown again.
		expect(off.initialData.dailySaleLimit).toEqual({
			limit: 12,
			showRemaining: true,
			byLocation: { a: 4 },
		})
		flags.on.add(FLAG)
		expect(
			(await loadEdit(organization, cookie, option.id)).dailyLimitsEnabled,
		).toBe(true)
	})

	it('reads a limit it cannot parse as none instead of failing the page', async () => {
		const { organization, cookie } = await setup()
		const option = await seedOption(organization.id, '{not json')
		expect(
			(await loadEdit(organization, cookie, option.id)).initialData
				.dailySaleLimit,
		).toBeNull()
	})

	it('offers the card on a new option while the feature is on', async () => {
		const { organization, cookie } = await setup()
		const load = () =>
			call(
				newLoader,
				`https://app.test/${organization.slug}/menu/options/new`,
				cookie,
				{ orgSlug: organization.slug },
			) as Promise<{ dailyLimitsEnabled: boolean }>
		expect((await load()).dailyLimitsEnabled).toBe(false)
		flags.on.add(FLAG)
		expect((await load()).dailyLimitsEnabled).toBe(true)
	})
})

describe('the option and the modifier group form agree (#409)', () => {
	it('a limit set on the option page is what the modifier group form offers, and the reverse', async () => {
		const { organization, cookie } = await setup()
		await create(organization, cookie, {
			dailySaleLimit: JSON.stringify({ limit: 7 }),
		})
		const [option] = await optionsOf(organization.id)
		const groupLoad = (await call(
			groupNewLoader,
			`https://app.test/${organization.slug}/menu/modifiers/new`,
			cookie,
			{ orgSlug: organization.slug },
		)) as { availableOptions: Array<{ id: string; dailySaleLimit: unknown }> }
		expect(
			groupLoad.availableOptions.find((entry) => entry.id === option!.id)
				?.dailySaleLimit,
		).toEqual({ limit: 7, showRemaining: false })

		// A save of the option page that never posted the field keeps what the
		// modifier group form (or an earlier save) put there.
		await edit(organization, cookie, option!.id, { price: '3' })
		expect(
			JSON.parse((await optionsOf(organization.id))[0]!.dailySaleLimit!),
		).toEqual({
			limit: 7,
			showRemaining: false,
		})
	})
})
