import {
	ConfigFlag,
	db,
	eq,
	inArray,
	Organization,
	OrganizationMenuItem,
} from '@repo/database'
import { MENU_POPULAR_WINDOW_DAYS } from '@repo/common/menu-popular'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setupTestOrgWithUser } from '#tests/test-utils.ts'

const { purgeSpy } = vi.hoisted(() => {
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
	return { purgeSpy: vi.fn(async () => true) }
})

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#app/utils/sites/kv-cache.server.ts')>()
	return {
		...actual,
		purgeOrganizationSiteCache: purgeSpy,
	}
})

import {
	effectiveIsPopularForMode,
	MENU_AUTO_POPULAR_FLAG_KEY,
	updateAutoPopularSettings,
} from '#app/utils/menu/auto-popular.server.ts'
import { action } from './menu.popular.ts'

const createdFlagIds: string[] = []

async function setFlag(organizationId: string, key: string, value: unknown) {
	const [row] = await db
		.insert(ConfigFlag)
		.values({ key, value, level: 'organization', organizationId })
		.returning({ id: ConfigFlag.id })
	createdFlagIds.push(row!.id)
}

async function enableAutoPopular(
	organizationId: string,
	count: number | null = 5,
) {
	await setFlag(organizationId, MENU_AUTO_POPULAR_FLAG_KEY, true)
	await db
		.update(Organization)
		.set({ hasProvisionedDb: true, autoPopularCount: count })
		.where(eq(Organization.id, organizationId))
}

async function createMenuItem(
	organizationId: string,
	displayName: string,
	patch: Partial<typeof OrganizationMenuItem.$inferInsert> = {},
) {
	const [row] = await db
		.insert(OrganizationMenuItem)
		.values({ organizationId, displayName, ...patch })
		.returning()
	return row!
}

function call(
	body: unknown,
	options: { authorized?: boolean; method?: string } = {},
) {
	return action({
		request: new Request('http://localhost:3001/resources/menu/popular', {
			method: options.method ?? 'POST',
			headers: {
				'content-type': 'application/json',
				...(options.authorized === false
					? {}
					: { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }),
			},
			body:
				options.method === 'GET'
					? undefined
					: typeof body === 'string'
						? body
						: JSON.stringify(body),
		}),
		params: {},
		context: new RouterContextProvider(),
		unstable_pattern: '/resources/menu/popular',
	} as never)
}

afterEach(async () => {
	purgeSpy.mockClear()
	if (createdFlagIds.length > 0) {
		await db
			.delete(ConfigFlag)
			.where(inArray(ConfigFlag.id, createdFlagIds.splice(0)))
	}
})

describe('POST /resources/menu/popular', () => {
	it('rejects unauthenticated requests with 401 and GET with 405', async () => {
		const unauth = await call(
			{ orgId: 'org_x', itemIds: [], windowDays: MENU_POPULAR_WINDOW_DAYS },
			{ authorized: false },
		)
		expect(unauth.status).toBe(401)

		const wrongMethod = await call(null, { method: 'GET' })
		expect(wrongMethod.status).toBe(405)
	})

	it('rejects strict payload violations (extra fields or missing orgId)', async () => {
		const res = await call({
			orgId: 'org_x',
			itemIds: ['item_1'],
			windowDays: MENU_POPULAR_WINDOW_DAYS,
			extraField: 'nope',
		})
		expect(res.status).toBe(400)
	})

	it('is a no-op when menu.auto_popular flag is off', async () => {
		const { organization } = await setupTestOrgWithUser()
		await db
			.update(Organization)
			.set({ hasProvisionedDb: true, autoPopularCount: 5 })
			.where(eq(Organization.id, organization.id))
		const item = await createMenuItem(organization.id, 'Burger', {
			popularMode: 'auto',
			isPopular: false,
		})

		const res = await call({
			orgId: organization.id,
			itemIds: [item.id],
			windowDays: MENU_POPULAR_WINDOW_DAYS,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			updated: 0,
			skipped: 'feature_disabled',
		})

		const fresh = await db.query.OrganizationMenuItem.findFirst({
			where: eq(OrganizationMenuItem.id, item.id),
		})
		expect(fresh?.isPopular).toBe(false)
		expect(purgeSpy).not.toHaveBeenCalled()
	})

	it('marks top N available auto dishes, skips hidden/unavailable and never, and preserves always/never', async () => {
		const { organization } = await setupTestOrgWithUser()
		await enableAutoPopular(organization.id, 3)

		const neverTop = await createMenuItem(organization.id, 'Never Top', {
			popularMode: 'never',
			isPopular: false,
		})
		const hiddenTop = await createMenuItem(organization.id, 'Hidden Top', {
			popularMode: 'auto',
			availabilityStatus: 'hidden',
			isPopular: false,
		})
		const unavailableTop = await createMenuItem(
			organization.id,
			'Unavailable Top',
			{
				popularMode: 'auto',
				availabilityStatus: 'unavailable',
				isPopular: true,
			},
		)
		const alwaysPinned = await createMenuItem(
			organization.id,
			'Always Pinned',
			{
				popularMode: 'always',
				isPopular: true,
			},
		)
		const droppedAuto = await createMenuItem(organization.id, 'Dropped Auto', {
			popularMode: 'auto',
			isPopular: true,
		})
		const pick1 = await createMenuItem(organization.id, 'Pick 1', {
			popularMode: 'auto',
			isPopular: false,
		})
		const pick2 = await createMenuItem(organization.id, 'Pick 2', {
			popularMode: 'auto',
			isPopular: false,
		})
		const pick3 = await createMenuItem(organization.id, 'Pick 3', {
			popularMode: 'auto',
			isPopular: false,
		})
		const pick4 = await createMenuItem(organization.id, 'Pick 4', {
			popularMode: 'auto',
			isPopular: false,
		})

		const res = await call({
			orgId: organization.id,
			itemIds: [
				neverTop.id,
				hiddenTop.id,
				unavailableTop.id,
				alwaysPinned.id,
				pick1.id,
				pick2.id,
				pick3.id,
				pick4.id,
			],
			windowDays: MENU_POPULAR_WINDOW_DAYS,
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		// pick1, pick2, pick3 set true (+3); unavailableTop and droppedAuto cleared (+2) => 5
		expect(body).toEqual({ updated: 5 })
		expect(purgeSpy).toHaveBeenCalledWith(organization.id, organization.slug)

		const rows = await db.query.OrganizationMenuItem.findMany({
			where: eq(OrganizationMenuItem.organizationId, organization.id),
		})
		const byId = new Map(rows.map((r) => [r.id, r]))

		expect(byId.get(neverTop.id)?.isPopular).toBe(false)
		expect(byId.get(hiddenTop.id)?.isPopular).toBe(false)
		expect(byId.get(unavailableTop.id)?.isPopular).toBe(false)
		expect(byId.get(alwaysPinned.id)?.isPopular).toBe(true)
		expect(byId.get(droppedAuto.id)?.isPopular).toBe(false)
		expect(byId.get(pick1.id)?.isPopular).toBe(true)
		expect(byId.get(pick2.id)?.isPopular).toBe(true)
		expect(byId.get(pick3.id)?.isPopular).toBe(true)
		expect(byId.get(pick4.id)?.isPopular).toBe(false)
	})

	it('clears auto badges when empty itemIds sent while leaving always and never untouched', async () => {
		const { organization } = await setupTestOrgWithUser()
		await enableAutoPopular(organization.id, 5)

		const autoItem = await createMenuItem(organization.id, 'Auto Item', {
			popularMode: 'auto',
			isPopular: true,
		})
		const alwaysItem = await createMenuItem(organization.id, 'Always Item', {
			popularMode: 'always',
			isPopular: true,
		})
		const neverItem = await createMenuItem(organization.id, 'Never Item', {
			popularMode: 'never',
			isPopular: false,
		})

		const res = await call({
			orgId: organization.id,
			itemIds: [],
			windowDays: MENU_POPULAR_WINDOW_DAYS,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ updated: 1 })

		const rows = await db.query.OrganizationMenuItem.findMany({
			where: eq(OrganizationMenuItem.organizationId, organization.id),
		})
		const byId = new Map(rows.map((r) => [r.id, r]))
		expect(byId.get(autoItem.id)?.isPopular).toBe(false)
		expect(byId.get(alwaysItem.id)?.isPopular).toBe(true)
		expect(byId.get(neverItem.id)?.isPopular).toBe(false)
	})
})

describe('effectiveIsPopularForMode & updateAutoPopularSettings', () => {
	it('computes effective isPopular for mode transitions', () => {
		expect(effectiveIsPopularForMode('always', false)).toBe(true)
		expect(effectiveIsPopularForMode('never', true)).toBe(false)
		expect(effectiveIsPopularForMode('auto', true)).toBe(true)
		expect(effectiveIsPopularForMode('auto', false)).toBe(false)
	})

	it('clears auto badges when auto popular setting is turned off', async () => {
		const { organization } = await setupTestOrgWithUser()
		await enableAutoPopular(organization.id, 5)
		const autoItem = await createMenuItem(organization.id, 'Auto Item', {
			popularMode: 'auto',
			isPopular: true,
		})
		const alwaysItem = await createMenuItem(organization.id, 'Always Item', {
			popularMode: 'always',
			isPopular: true,
		})

		await updateAutoPopularSettings({
			organizationId: organization.id,
			enabled: false,
		})

		const rows = await db.query.OrganizationMenuItem.findMany({
			where: eq(OrganizationMenuItem.organizationId, organization.id),
		})
		const byId = new Map(rows.map((r) => [r.id, r]))
		expect(byId.get(autoItem.id)?.isPopular).toBe(false)
		expect(byId.get(alwaysItem.id)?.isPopular).toBe(true)
	})
})
