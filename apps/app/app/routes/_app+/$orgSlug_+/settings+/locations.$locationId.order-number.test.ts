import { db, eq, OrganizationLocation } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
	createTestUser,
} from '#tests/test-utils.ts'
import { action, loader } from './locations.$locationId.tsx'
import { action as createAction } from './locations.new.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))
vi.mock('#app/utils/phone-agent/phone-agent.server.ts', () => ({
	deleteScopeData: vi.fn(),
}))
vi.mock('#app/utils/reservations/regional-internal.server.ts', () => ({
	postRegionalReservationsInternal: vi.fn(),
}))
vi.mock('#app/utils/location/geocoder.server.ts', () => ({
	ensureLocationCoordinates: async (address: unknown) => ({ address }),
}))

vi.mock('@repo/common/feature-flags', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getFeatureFlag: vi.fn(async () => null),
}))

async function setup(role: 'admin' | 'viewer' = 'admin') {
	const user = await createTestUser()
	const organization = await createTestOrganization(user.id, role)
	const { cookie } = await createTestSession(user.id)
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Olaya Branch',
			slug: `olaya-${crypto.randomUUID().slice(0, 8)}`,
			timezone: 'Asia/Riyadh',
			isActive: true,
			isDefault: true,
		})
		.returning()

	const editUrl = new URL(
		`http://localhost:3001/${organization.slug}/settings/locations/${location!.id}`,
	)
	const editArgs = (init?: RequestInit) => ({
		request: createAuthenticatedRequest(editUrl.toString(), init ?? {}, cookie),
		params: { orgSlug: organization.slug, locationId: location!.id },
		context: new RouterContextProvider(),
		url: editUrl,
		pattern: '/:orgSlug/settings/locations/:locationId',
	})

	const newUrl = new URL(
		`http://localhost:3001/${organization.slug}/settings/locations/new`,
	)
	const create = (fields: Record<string, string>) =>
		createAction({
			request: createAuthenticatedRequest(
				newUrl.toString(),
				{
					method: 'POST',
					body: new URLSearchParams({
						name: 'Diriyah Branch',
						slug: `diriyah-${crypto.randomUUID().slice(0, 8)}`,
						timezone: 'Asia/Riyadh',
						isActive: 'true',
						isDefault: 'false',
						...fields,
					}),
				},
				cookie,
			),
			params: { orgSlug: organization.slug },
			context: new RouterContextProvider(),
			url: newUrl,
			pattern: '/:orgSlug/settings/locations/new',
		})

	return {
		organization,
		location: location!,
		create,
		load: () => loader(editArgs()) as Promise<any>,
		save: (fields: Record<string, string>) =>
			action(
				editArgs({
					method: 'POST',
					body: new URLSearchParams({
						name: location!.name,
						slug: location!.slug,
						timezone: 'Asia/Riyadh',
						isActive: 'true',
						isDefault: 'true',
						...fields,
					}),
				}),
			) as Promise<any>,
		row: async () => {
			const [row] = await db
				.select()
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.id, location!.id))
			return row!
		},
		published: async () => {
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
		},
	}
}

describe('location order number format (#371)', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('omits orderNumberFormat from menu context until configured, then saves and publishes it', async () => {
		const ctx = await setup()
		expect((await ctx.published())[0]?.orderNumberFormat).toBeUndefined()

		const payloadJson = JSON.stringify({
			prefix: 'A',
			digits: 3,
			resetTime: '06:00',
		})
		await ctx.save({ orderNumberFormat: payloadJson })

		const saved = await ctx.row()
		expect(JSON.parse(saved.orderNumberFormat!)).toEqual({
			prefix: 'A',
			digits: 3,
			resetTime: '06:00',
		})

		const loaded = await ctx.load()
		expect(JSON.parse(loaded.location.orderNumberFormat)).toEqual({
			prefix: 'A',
			digits: 3,
			resetTime: '06:00',
		})

		const pub = await ctx.published()
		expect(pub[0]?.orderNumberFormat).toEqual({
			prefix: 'A',
			digits: 3,
			resetTime: '06:00',
		})
	})

	it.each([
		['malformed JSON', '{bad'],
		[
			'prefix over 4 chars',
			JSON.stringify({ prefix: 'ABCDE', digits: 3, resetTime: '04:00' }),
		],
		[
			'prefix with punctuation',
			JSON.stringify({ prefix: 'A-1', digits: 3, resetTime: '04:00' }),
		],
		[
			'digits out of range',
			JSON.stringify({ prefix: 'A', digits: 1, resetTime: '04:00' }),
		],
		[
			'invalid reset time',
			JSON.stringify({ prefix: 'A', digits: 3, resetTime: '25:99' }),
		],
	])(
		'rejects invalid orderNumberFormat (%s) without updating DB',
		async (_label, raw) => {
			const ctx = await setup()
			const result = await ctx.save({ orderNumberFormat: raw })
			expect(typeof result?.error).toBe('string')
			expect((await ctx.row()).orderNumberFormat).toBeNull()
		},
	)

	it('saves orderNumberFormat when creating a new location', async () => {
		const ctx = await setup()
		const res = await ctx.create({
			orderNumberFormat: JSON.stringify({
				prefix: 'B2',
				digits: 4,
				resetTime: '05:30',
			}),
		})
		expect(res).toBeInstanceOf(Response)
		const created = (await ctx.published()).find(
			(loc) => loc.name === 'Diriyah Branch',
		)
		expect(created?.orderNumberFormat).toEqual({
			prefix: 'B2',
			digits: 4,
			resetTime: '05:30',
		})
	})
})
