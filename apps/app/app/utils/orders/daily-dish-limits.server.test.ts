import {
	db,
	OrganizationLocation,
	OrganizationMenuItem,
	OrganizationMenuOption,
} from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestOrganization, createTestUser } from '#tests/test-utils.ts'
import {
	buildDailyDishLimitsContext,
	isDailyDishLimitsEnabled,
	loadDailyLimitLocations,
} from './daily-dish-limits.server.ts'

const flags = vi.hoisted(() => ({ on: new Set<string>() }))
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: vi.fn(async (key: string) =>
		flags.on.has(key) ? true : null,
	),
}))

const FLAG = 'ordering.daily_dish_limits'

async function org() {
	const user = await createTestUser()
	return createTestOrganization(user.id, 'admin')
}

async function item(
	organizationId: string,
	displayName: string,
	dailySaleLimit: string | null,
) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({ organizationId, displayName, dailySaleLimit })
		.returning()
	return row!
}

async function option(
	organizationId: string,
	displayName: string,
	dailySaleLimit: string | null,
) {
	const [row] = await db
		.insert(OrganizationMenuOption)
		.values({ organizationId, displayName, dailySaleLimit })
		.returning()
	return row!
}

async function location(
	organizationId: string,
	name: string,
	patch: Partial<typeof OrganizationLocation.$inferInsert> = {},
) {
	const [row] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId,
			name,
			slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`,
			...patch,
		})
		.returning()
	return row!
}

beforeEach(() => {
	flags.on.clear()
})

describe('buildDailyDishLimitsContext (#409)', () => {
	it('is off, and reads nothing, while the flag is off', async () => {
		const organization = await org()
		await item(organization.id, 'Special', JSON.stringify({ limit: 20 }))
		expect(await isDailyDishLimitsEnabled(organization.id)).toBe(false)
		expect(await buildDailyDishLimitsContext(organization.id)).toEqual({
			enabled: false,
			entries: [],
		})
	})

	it('lists every capped dish and option with its name and config', async () => {
		flags.on.add(FLAG)
		const organization = await org()
		const special = await item(
			organization.id,
			'Special',
			JSON.stringify({ limit: 20, showRemaining: true, byLocation: { a: 5 } }),
		)
		const dessert = await option(
			organization.id,
			'Dessert',
			JSON.stringify({ limit: 12 }),
		)
		await item(organization.id, 'Burger', null)
		await option(organization.id, 'Plain', null)

		const context = await buildDailyDishLimitsContext(organization.id)
		expect(context.enabled).toBe(true)
		expect(context.entries).toHaveLength(2)
		expect(context.entries).toContainEqual({
			kind: 'item',
			id: special.id,
			name: 'Special',
			config: { limit: 20, showRemaining: true, byLocation: { a: 5 } },
		})
		expect(context.entries).toContainEqual({
			kind: 'option',
			id: dessert.id,
			name: 'Dessert',
			config: { limit: 12, showRemaining: false },
		})
	})

	it('leaves out a limit it cannot read, so one bad row never hides the rest', async () => {
		flags.on.add(FLAG)
		const organization = await org()
		await item(organization.id, 'Broken', '{not json')
		await item(organization.id, 'Zero', JSON.stringify({ limit: 0 }))
		const good = await item(
			organization.id,
			'Good',
			JSON.stringify({ limit: 4 }),
		)
		const context = await buildDailyDishLimitsContext(organization.id)
		expect(context.entries.map((entry) => entry.id)).toEqual([good.id])
	})

	it("never lists another organization's dish", async () => {
		flags.on.add(FLAG)
		const mine = await org()
		const other = await org()
		await item(other.id, 'Theirs', JSON.stringify({ limit: 9 }))
		expect((await buildDailyDishLimitsContext(mine.id)).entries).toEqual([])
	})
})

describe('loadDailyLimitLocations (#409)', () => {
	it('is empty while the flag is off', async () => {
		const organization = await org()
		await item(organization.id, 'Special', JSON.stringify({ limit: 20 }))
		await location(organization.id, 'Main')
		expect(await loadDailyLimitLocations(organization.id)).toEqual([])
	})

	it('is empty while nothing has a limit, so the panel never shows empty', async () => {
		flags.on.add(FLAG)
		const organization = await org()
		await item(organization.id, 'Burger', null)
		await location(organization.id, 'Main')
		expect(await loadDailyLimitLocations(organization.id)).toEqual([])
	})

	it('lists the active locations, default first, once a dish has a limit', async () => {
		flags.on.add(FLAG)
		const organization = await org()
		await item(organization.id, 'Special', JSON.stringify({ limit: 20 }))
		await location(organization.id, 'Beta')
		const main = await location(organization.id, 'Zed', { isDefault: true })
		await location(organization.id, 'Closed', { isActive: false })
		const rows = await loadDailyLimitLocations(organization.id)
		expect(rows.map((row) => row.name)).toEqual(['Zed', 'Beta'])
		expect(rows[0]).toEqual({ id: main.id, name: 'Zed' })
	})

	it('counts an option with a limit as something capped', async () => {
		flags.on.add(FLAG)
		const organization = await org()
		await option(organization.id, 'Dessert', JSON.stringify({ limit: 3 }))
		await location(organization.id, 'Main')
		expect(await loadDailyLimitLocations(organization.id)).toHaveLength(1)
	})
})
