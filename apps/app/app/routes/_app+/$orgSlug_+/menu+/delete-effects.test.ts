import { INVENTORY_FLAG_KEYS } from '@repo/inventory'
import {
	db,
	OrganizationMenuItem,
	OrganizationMenuOption,
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
})

const mocks = vi.hoisted(() => ({ flags: new Map<string, unknown>() }))

vi.mock('@repo/common/feature-flags', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getFeatureFlag: vi.fn(async (key: string) => mocks.flags.get(key) ?? false),
}))

import { loader } from './delete-effects.ts'

type Setup = Awaited<ReturnType<typeof setupTestOrgWithUser>>

async function get(
	{ organization, cookie }: Pick<Setup, 'organization' | 'cookie'>,
	query: string,
): Promise<{ status: number; body: any }> {
	const request = new Request(
		`https://app.example/${organization.slug}/menu/delete-effects${query}`,
		{ headers: { cookie } },
	)
	try {
		const result = (await loader({
			request,
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
		} as never)) as { data: unknown; init?: { status?: number } }
		return { status: result.init?.status ?? 200, body: result.data }
	} catch (thrown) {
		if (thrown instanceof Response) return { status: thrown.status, body: null }
		const refusal = thrown as { data?: unknown; init?: { status?: number } }
		if (refusal?.init?.status) {
			return { status: refusal.init.status, body: refusal.data }
		}
		throw thrown
	}
}

async function dish(organizationId: string) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({ organizationId, displayName: '{"en":"Falafel"}' })
		.returning()
	return row!
}

beforeEach(() => {
	mocks.flags.clear()
})

describe('GET /:orgSlug/menu/delete-effects', () => {
	it('answers the effects of a dish, without recipe owners while recipes are off', async () => {
		const admin = await setupTestOrgWithUser('admin')
		const item = await dish(admin.organization.id)

		const { status, body } = await get(admin, `?type=item&id=${item.id}`)

		expect(status).toBe(200)
		expect(body).toMatchObject({
			entityType: 'item',
			entityId: item.id,
			name: 'Falafel',
			groups: [],
			recipes: false,
			recipeOwners: [],
		})
		expect(typeof body.checkedAt).toBe('number')
	})

	it('names the recipe owners only when inventory and recipes are both on', async () => {
		const admin = await setupTestOrgWithUser('admin')
		const item = await dish(admin.organization.id)
		const [option] = await db
			.insert(OrganizationMenuOption)
			.values({
				organizationId: admin.organization.id,
				displayName: '{"en":"Tahini"}',
			})
			.returning()

		mocks.flags.set(INVENTORY_FLAG_KEYS.recipes, true)
		const masterOff = await get(admin, `?type=item&id=${item.id}`)
		expect(masterOff.body.recipes).toBe(false)
		expect(masterOff.body.recipeOwners).toEqual([])

		mocks.flags.set(INVENTORY_FLAG_KEYS.enabled, true)
		const on = await get(admin, `?type=item&id=${item.id}`)
		expect(on.body.recipes).toBe(true)
		expect(on.body.recipeOwners).toEqual([
			{ ownerKind: 'menu_item', ownerId: item.id },
		])
		const forOption = await get(admin, `?type=modifier_option&id=${option!.id}`)
		expect(forOption.body.recipeOwners).toEqual([
			{ ownerKind: 'option', ownerId: option!.id },
		])
	})

	it("answers 404 for another organization's record", async () => {
		const admin = await setupTestOrgWithUser('admin')
		const other = await setupTestOrgWithUser('admin')
		const theirs = await dish(other.organization.id)

		expect((await get(admin, `?type=item&id=${theirs.id}`)).status).toBe(404)
		// And the other organization's route is not theirs to open at all.
		expect(
			(
				await get(
					{ organization: other.organization, cookie: admin.cookie },
					`?type=item&id=${theirs.id}`,
				)
			).status,
		).toBe(404)
	})

	it('needs menu read access', async () => {
		const guest = await setupTestOrgWithUser('guest')
		const item = await dish(guest.organization.id)

		expect((await get(guest, `?type=item&id=${item.id}`)).status).toBe(403)
	})

	it('refuses a signed-out request and a malformed query', async () => {
		const admin = await setupTestOrgWithUser('admin')
		const item = await dish(admin.organization.id)

		const signedOut = await get(
			{ organization: admin.organization, cookie: '' },
			`?type=item&id=${item.id}`,
		)
		expect([302, 401]).toContain(signedOut.status)
		expect((await get(admin, `?type=order&id=${item.id}`)).status).toBe(400)
		expect((await get(admin, '?type=item')).status).toBe(400)
	})
})
