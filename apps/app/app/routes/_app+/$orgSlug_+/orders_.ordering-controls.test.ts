import { db, eq, OrganizationLocation } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './orders_.ordering-controls.ts'

// The site cache is the external boundary; permissions and the database are real.
vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))

async function setup() {
	const { organization, cookie } = await setupTestOrgWithUser('admin')
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Main Street',
			slug: `main-${Date.now()}`,
			timezone: 'America/New_York',
		})
		.returning()
	return { organization, location: location!, cookie }
}

function post(orgSlug: string, cookie: string, values: Record<string, string>) {
	const request = createAuthenticatedRequest(
		`https://app.test/${orgSlug}/orders/ordering-controls`,
		{ method: 'POST', body: new URLSearchParams(values) },
		cookie,
	)
	return action({ request, params: { orgSlug }, context: {} } as never)
}

async function readLocation(id: string) {
	const [row] = await db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.id, id))
	return row!
}

describe('ordering controls action', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockClear()
	})

	it('pauses for a while, publishes it, and resumes', async () => {
		const { organization, location, cookie } = await setup()
		const before = Date.now()
		const result = await post(organization.slug, cookie, {
			intent: 'pause',
			locationId: location.id,
			duration: '30m',
		})
		expect(getResponseStatus(result)).toBe(200)
		const paused = await readLocation(location.id)
		expect(paused.orderingPausedAt).not.toBeNull()
		const until = paused.orderingPausedUntil!.getTime()
		expect(until).toBeGreaterThanOrEqual(before + 30 * 60_000)
		expect(until).toBeLessThan(before + 31 * 60_000)
		expect(purgeOrganizationSiteCache).toHaveBeenCalledWith(
			organization.id,
			organization.slug,
		)

		const { payload } = await buildPublicSiteMenuPayload(
			{
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				currency: 'USD',
				siteDefaultLocale: 'en',
				siteLocales: null,
				customDomain: null,
			} as never,
			location.id,
		)
		expect(payload.locations[0]?.orderingPause).toEqual({
			until: paused.orderingPausedUntil!.toISOString(),
		})

		await post(organization.slug, cookie, {
			intent: 'resume',
			locationId: location.id,
		})
		const resumed = await readLocation(location.id)
		expect(resumed.orderingPausedAt).toBeNull()
		expect(resumed.orderingPausedUntil).toBeNull()
	})

	it('pauses until turned back on', async () => {
		const { organization, location, cookie } = await setup()
		await post(organization.slug, cookie, {
			intent: 'pause',
			locationId: location.id,
			duration: 'until_resumed',
		})
		const row = await readLocation(location.id)
		expect(row.orderingPausedAt).not.toBeNull()
		expect(row.orderingPausedUntil).toBeNull()
	})

	it('turns busy mode on and off', async () => {
		const { organization, location, cookie } = await setup()
		await post(organization.slug, cookie, {
			intent: 'busy',
			locationId: location.id,
			minutes: '20',
			duration: 'rest_of_day',
		})
		const busy = await readLocation(location.id)
		expect(busy.busyExtraPrepMinutes).toBe(20)
		expect(busy.busyUntil!.getTime()).toBeGreaterThan(Date.now())
		await post(organization.slug, cookie, {
			intent: 'busy_off',
			locationId: location.id,
		})
		const off = await readLocation(location.id)
		expect(off.busyExtraPrepMinutes).toBeNull()
		expect(off.busyUntil).toBeNull()
	})

	it('refuses minutes outside the offered choices', async () => {
		const { organization, location, cookie } = await setup()
		const result = await post(organization.slug, cookie, {
			intent: 'busy',
			locationId: location.id,
			minutes: '500',
			duration: 'rest_of_day',
		})
		expect(getResponseStatus(result)).toBe(400)
		expect((await readLocation(location.id)).busyExtraPrepMinutes).toBeNull()
	})

	it('refuses a member without menu write access', async () => {
		const { organization, location } = await setup()
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
		const { cookie } = await createTestSession(viewer.id)
		const thrown = await post(organization.slug, cookie, {
			intent: 'pause',
			locationId: location.id,
			duration: '15m',
		}).catch((error: unknown) => error)
		expect(thrown).toBeInstanceOf(Response)
		expect((thrown as Response).status).toBe(403)
		expect((await readLocation(location.id)).orderingPausedAt).toBeNull()
	})

	it("cannot pause another organization's location", async () => {
		const { location } = await setup()
		const other = await setupTestOrgWithUser('admin')
		const result = await post(other.organization.slug, other.cookie, {
			intent: 'pause',
			locationId: location.id,
			duration: '15m',
		})
		expect(getResponseStatus(result)).toBe(404)
		expect((await readLocation(location.id)).orderingPausedAt).toBeNull()
	})
})
