import { parsePosLocationStationSettings } from '@repo/common/pos-orders'
import { db, eq, OrganizationLocation } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	createAuthenticatedRequest,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action as registerAction } from './terminals_.register-settings.ts'
import { action } from './terminals_.ticket-settings.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn().mockResolvedValue(true),
}))

async function setup(role: 'admin' | 'viewer' = 'admin') {
	const { organization, cookie } = await setupTestOrgWithUser(role)
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Downtown',
			slug: `dt-${crypto.randomUUID().slice(0, 8)}`,
			timezone: 'Asia/Riyadh',
		})
		.returning()
	return { organization, location: location!, cookie }
}

function post(
	handler: (args: never) => Promise<unknown>,
	path: string,
	orgSlug: string,
	cookie: string,
	values: Record<string, string>,
) {
	const request = createAuthenticatedRequest(
		`https://app.test/${orgSlug}/settings/terminals/${path}`,
		{ method: 'POST', body: new URLSearchParams(values) },
		cookie,
	)
	return handler({
		request,
		params: { orgSlug },
		context: {},
	} as never) as Promise<{
		data?: unknown
	}>
}
const saveTickets = (
	orgSlug: string,
	cookie: string,
	locationId: string,
	tickets: unknown,
) =>
	post(action, 'ticket-settings', orgSlug, cookie, {
		locationId,
		tickets: typeof tickets === 'string' ? tickets : JSON.stringify(tickets),
	})

async function stored(locationId: string) {
	const [row] = await db
		.select({ stationSettings: OrganizationLocation.stationSettings })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.id, locationId))
	return parsePosLocationStationSettings(row?.stationSettings)
}

async function published(organization: {
	id: string
	name: string
	slug: string
}) {
	const { payload } = await buildPublicSiteMenuPayload(
		{
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			currency: 'SAR',
			siteDefaultLocale: 'en',
			siteLocales: null,
			customDomain: null,
		} as never,
		null,
	)
	return payload.locations
}

describe('Ticket settings route (#363)', () => {
	beforeEach(() => {
		vi.mocked(purgeOrganizationSiteCache).mockClear()
	})

	it('saves only what differs from the defaults and leaves the register settings alone', async () => {
		const { organization, location, cookie } = await setup()
		await post(registerAction, 'register-settings', organization.slug, cookie, {
			locationId: location.id,
			guestDetails: 'phone',
			dishNotes: 'false',
			customItems: 'managers',
			customItemMaxCents: '12345',
			cashVarianceFlagCents: '500',
		})
		const res = await saveTickets(organization.slug, cookie, location.id, {
			receipt: { servedBy: { show: false }, tip: { show: true } },
			when: { receipt: 'manual', kitchen: 'on_acceptance' },
			cancellationSlip: true,
			changesOnly: false,
		})
		expect(res.data).toMatchObject({ ok: true })
		const settings = await stored(location.id)
		expect(settings.tickets).toEqual({
			receipt: { servedBy: { show: false } },
			when: { kitchen: 'on_acceptance' },
			cancellationSlip: true,
		})
		expect(settings).toMatchObject({
			guestDetails: 'phone',
			dishNotes: false,
			customItems: 'managers',
			customItemMaxCents: 12345,
			cashVarianceFlagCents: 500,
		})
		expect(purgeOrganizationSiteCache).toHaveBeenCalledWith(
			organization.id,
			organization.slug,
		)
	})

	it('saving the register settings later keeps the ticket settings', async () => {
		const { organization, location, cookie } = await setup()
		await saveTickets(organization.slug, cookie, location.id, {
			excludeDineIn: true,
		})
		await post(registerAction, 'register-settings', organization.slug, cookie, {
			locationId: location.id,
			guestDetails: 'none',
			dishNotes: 'true',
			customItems: 'off',
			customItemMaxCents: '50000',
			cashVarianceFlagCents: '',
		})
		expect((await stored(location.id)).tickets).toEqual({
			excludeDineIn: true,
		})
	})

	it('reaches Station with the published menu, and a location with none publishes the defaults', async () => {
		const { organization, location, cookie } = await setup()
		await saveTickets(organization.slug, cookie, location.id, {
			kitchen: { itemNotes: { bold: true } },
		})
		const [published1] = await published(organization)
		expect(published1?.stationSettings?.tickets).toEqual({
			kitchen: { itemNotes: { bold: true } },
		})
		await saveTickets(organization.slug, cookie, location.id, {})
		const [published2] = await published(organization)
		expect(published2?.stationSettings?.tickets).toEqual({})
	})

	it('never stores a hidden locked field, nor an unknown one', async () => {
		const { organization, location, cookie } = await setup()
		await saveTickets(organization.slug, cookie, location.id, {
			receipt: {
				vatNumber: { show: false },
				total: { show: false, bold: true },
				bogus: { show: false },
			},
		})
		expect((await stored(location.id)).tickets).toEqual({
			receipt: { total: { bold: true } },
		})
	})

	it('refuses a wrong shape, a location from another organization, and a member who cannot edit', async () => {
		const { organization, location, cookie } = await setup()
		for (const bad of [
			'not json',
			JSON.stringify({ receipt: 'all', extra: 1 }),
			JSON.stringify({ when: { receipt: 'whenever' }, unknown: true }),
			'x'.repeat(30_000),
		]) {
			const res = await saveTickets(organization.slug, cookie, location.id, bad)
			expect(getResponseStatus(res)).toBe(400)
		}
		expect((await stored(location.id)).tickets).toEqual({})
		const other = await setup()
		const cross = await saveTickets(
			organization.slug,
			cookie,
			other.location.id,
			{
				excludeDineIn: true,
			},
		)
		expect(getResponseStatus(cross)).toBe(404)
		expect((await stored(other.location.id)).tickets).toEqual({})
		const viewer = await setup('viewer')
		await expect(
			saveTickets(viewer.organization.slug, viewer.cookie, viewer.location.id, {
				excludeDineIn: true,
			}),
		).rejects.toSatisfy((error) => getResponseStatus(error) === 403)
		expect((await stored(viewer.location.id)).tickets).toEqual({})
	})
})
