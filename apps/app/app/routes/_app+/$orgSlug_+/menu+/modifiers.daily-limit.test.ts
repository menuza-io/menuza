import { ModifierGroupInputSchema } from '@repo/common/menu-types'
import {
	db,
	eq,
	OrganizationLocation,
	OrganizationMenuModifierGroup,
	OrganizationMenuOption,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createModifierGroup } from '#app/utils/menu/modifier-groups.server.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	action as editAction,
	loader as editLoader,
} from './modifiers.$modifierGroupId.tsx'
import { action as newAction, loader as newLoader } from './modifiers.new.tsx'

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

function parsed(options: unknown[]) {
	return ModifierGroupInputSchema.parse({
		name: name('Side'),
		selectionType: 'multiple',
		options,
	})
}

async function optionRow(id: string) {
	const [row] = await db
		.select()
		.from(OrganizationMenuOption)
		.where(eq(OrganizationMenuOption.id, id))
	return row!
}

async function optionsNamed(organizationId: string, displayName: string) {
	const rows = await db
		.select()
		.from(OrganizationMenuOption)
		.where(eq(OrganizationMenuOption.organizationId, organizationId))
	return rows.filter((row) => row.displayName === displayName)
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

function form(options: unknown[]) {
	return new URLSearchParams({
		name: name('Side'),
		selectionType: 'multiple',
		minSelections: '0',
		options: JSON.stringify(options),
		assignedItemIds: '[]',
	})
}

beforeEach(() => {
	flags.on.clear()
})

describe('the daily limit of a new modifier option (#409)', () => {
	it('is stored with the option, per location when asked', async () => {
		const { organization, location } = await setup()
		const limit = {
			limit: 12,
			showRemaining: true,
			byLocation: { [location.id]: 4 },
		}
		const result = await createModifierGroup(
			organization.id,
			parsed([
				{ displayName: name('Dessert'), price: 2, dailySaleLimit: limit },
				{ displayName: name('Plain'), price: 0 },
			]),
		)
		expect(result.ok).toBe(true)
		const [dessert] = await optionsNamed(organization.id, name('Dessert'))
		const [plain] = await optionsNamed(organization.id, name('Plain'))
		expect(JSON.parse(dessert!.dailySaleLimit!)).toEqual(limit)
		expect(plain!.dailySaleLimit).toBeNull()
	})

	it("refuses a limit naming another organization's location, and creates no group", async () => {
		const { organization } = await setup()
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
		await expect(
			createModifierGroup(
				organization.id,
				parsed([
					{
						displayName: name('Dessert'),
						price: 2,
						dailySaleLimit: { limit: 5, byLocation: { [foreign!.id]: 1 } },
					},
				]),
			),
		).rejects.toBeInstanceOf(Response)
		const groups = await db
			.select()
			.from(OrganizationMenuModifierGroup)
			.where(eq(OrganizationMenuModifierGroup.organizationId, organization.id))
		expect(groups).toHaveLength(0)
		expect(await optionsNamed(organization.id, name('Dessert'))).toHaveLength(0)
	})
})

describe('linking an existing option into a group never wipes its limit (#409)', () => {
	async function existingOption(organizationId: string) {
		const first = await createModifierGroup(
			organizationId,
			parsed([
				{
					displayName: name('Dessert'),
					price: 2,
					dailySaleLimit: { limit: 12 },
				},
			]),
		)
		if (!first.ok) throw new Error('setup failed')
		const [option] = await optionsNamed(organizationId, name('Dessert'))
		return option!
	}

	it('keeps the limit when the request did not send the field', async () => {
		const { organization } = await setup()
		const option = await existingOption(organization.id)
		await createModifierGroup(
			organization.id,
			parsed([{ id: option.id, displayName: name('Dessert'), price: 3 }]),
			{ dailyLimitPosted: [false] },
		)
		const after = await optionRow(option.id)
		expect(after.price).toBe(3)
		expect(JSON.parse(after.dailySaleLimit!)).toEqual({
			limit: 12,
			showRemaining: false,
		})
	})

	it('changes it when the request sent a new one, and clears it when it sent none', async () => {
		const { organization } = await setup()
		const option = await existingOption(organization.id)
		await createModifierGroup(
			organization.id,
			parsed([
				{
					id: option.id,
					displayName: name('Dessert'),
					price: 2,
					dailySaleLimit: { limit: 30 },
				},
			]),
			{ dailyLimitPosted: [true] },
		)
		expect(
			(JSON.parse((await optionRow(option.id)).dailySaleLimit!) as any).limit,
		).toBe(30)

		await createModifierGroup(
			organization.id,
			parsed([{ id: option.id, displayName: name('Dessert'), price: 2 }]),
			{ dailyLimitPosted: [true] },
		)
		expect((await optionRow(option.id)).dailySaleLimit).toBeNull()
	})
})

describe('the modifier group routes (#409)', () => {
	async function seededGroup(organizationId: string) {
		const created = await createModifierGroup(
			organizationId,
			parsed([
				{
					displayName: name('Dessert'),
					price: 2,
					dailySaleLimit: { limit: 12 },
				},
				{ displayName: name('Plain'), price: 0 },
			]),
		)
		if (!created.ok) throw new Error('setup failed')
		const [dessert] = await optionsNamed(organizationId, name('Dessert'))
		const [plain] = await optionsNamed(organizationId, name('Plain'))
		return { group: created.group, dessert: dessert!, plain: plain! }
	}

	const editGroup = (
		organization: { slug: string },
		cookie: string,
		groupId: string,
		options: unknown[],
	) =>
		call(
			editAction,
			`https://app.test/${organization.slug}/menu/modifiers/${groupId}`,
			cookie,
			{ orgSlug: organization.slug, modifierGroupId: groupId },
			form(options),
		)

	it('saves a new group with an option limit', async () => {
		const { organization, cookie } = await setup()
		const result = await call(
			newAction,
			`https://app.test/${organization.slug}/menu/modifiers/new`,
			cookie,
			{ orgSlug: organization.slug },
			form([
				{
					displayName: name('Dessert'),
					price: 2,
					dailySaleLimit: { limit: 6, showRemaining: true },
				},
			]),
		)
		expect(getResponseStatus(result)).toBe(302)
		const [dessert] = await optionsNamed(organization.id, name('Dessert'))
		expect(JSON.parse(dessert!.dailySaleLimit!)).toEqual({
			limit: 6,
			showRemaining: true,
		})
	})

	it('refuses an option limit of 0', async () => {
		const { organization, cookie } = await setup()
		const result = await call(
			newAction,
			`https://app.test/${organization.slug}/menu/modifiers/new`,
			cookie,
			{ orgSlug: organization.slug },
			form([
				{
					displayName: name('Dessert'),
					price: 2,
					dailySaleLimit: { limit: 0 },
				},
			]),
		)
		expect(getResponseStatus(result)).toBe(400)
		expect(await optionsNamed(organization.id, name('Dessert'))).toHaveLength(0)
	})

	it('changes an option limit on edit, and clears it on an explicit null', async () => {
		const { organization, cookie } = await setup()
		const { group, dessert, plain } = await seededGroup(organization.id)
		await editGroup(organization, cookie, group.id, [
			{
				id: dessert.id,
				displayName: name('Dessert'),
				price: 2,
				dailySaleLimit: { limit: 40 },
			},
			{
				id: plain.id,
				displayName: name('Plain'),
				price: 0,
				dailySaleLimit: null,
			},
		])
		expect(
			(JSON.parse((await optionRow(dessert.id)).dailySaleLimit!) as any).limit,
		).toBe(40)
		expect((await optionRow(plain.id)).dailySaleLimit).toBeNull()
		await editGroup(organization, cookie, group.id, [
			{
				id: dessert.id,
				displayName: name('Dessert'),
				price: 2,
				dailySaleLimit: null,
			},
		])
		expect((await optionRow(dessert.id)).dailySaleLimit).toBeNull()
	})

	it('leaves an option limit alone when the form sent options without that field', async () => {
		const { organization, cookie } = await setup()
		const { group, dessert } = await seededGroup(organization.id)
		const result = await editGroup(organization, cookie, group.id, [
			{ id: dessert.id, displayName: name('Dessert'), price: 5 },
		])
		expect(getResponseStatus(result)).toBe(302)
		const after = await optionRow(dessert.id)
		expect(after.price).toBe(5)
		expect((JSON.parse(after.dailySaleLimit!) as any).limit).toBe(12)
	})

	it('refuses a member who cannot change the menu', async () => {
		const { organization, cookie } = await setup('viewer')
		const code = await status(() =>
			call(
				newAction,
				`https://app.test/${organization.slug}/menu/modifiers/new`,
				cookie,
				{ orgSlug: organization.slug },
				form([{ displayName: name('Dessert'), price: 2 }]),
			),
		)
		expect(code).toBe(403)
	})

	it("shows each option's limit, parsed, and the card only while the feature is on", async () => {
		const { organization, cookie } = await setup()
		const { group, dessert } = await seededGroup(organization.id)
		const load = () =>
			call(
				editLoader,
				`https://app.test/${organization.slug}/menu/modifiers/${group.id}`,
				cookie,
				{ orgSlug: organization.slug, modifierGroupId: group.id },
			) as Promise<{
				dailyLimitsEnabled: boolean
				group: { options: Array<{ id: string; dailySaleLimit: unknown }> }
				availableOptions: Array<{ id: string; dailySaleLimit: unknown }>
			}>
		const off = await load()
		expect(off.dailyLimitsEnabled).toBe(false)
		expect(
			off.group.options.find((option) => option.id === dessert.id)
				?.dailySaleLimit,
		).toEqual({ limit: 12, showRemaining: false })
		expect(
			off.group.options.find((option) => option.id !== dessert.id)
				?.dailySaleLimit,
		).toBeNull()
		flags.on.add(FLAG)
		expect((await load()).dailyLimitsEnabled).toBe(true)
	})

	it('hands the library options to the new-group form with their limits', async () => {
		const { organization, cookie } = await setup()
		const { dessert } = await seededGroup(organization.id)
		flags.on.add(FLAG)
		const loaded = (await call(
			newLoader,
			`https://app.test/${organization.slug}/menu/modifiers/new`,
			cookie,
			{ orgSlug: organization.slug },
		)) as {
			dailyLimitsEnabled: boolean
			availableOptions: Array<{ id: string; dailySaleLimit: unknown }>
		}
		expect(loaded.dailyLimitsEnabled).toBe(true)
		expect(
			loaded.availableOptions.find((option) => option.id === dessert.id)
				?.dailySaleLimit,
		).toEqual({ limit: 12, showRemaining: false })
	})
})
