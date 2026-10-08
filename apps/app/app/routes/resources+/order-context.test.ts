import type * as DatabaseModule from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { drizzleTable, mockDb, resetMockDb } from '#tests/setup/drizzle-mock.ts'
import { loader } from './order-context.ts'

const findOrg = vi.hoisted(() => vi.fn())
const buildMenu = vi.hoisted(() => vi.fn())
const buildDrop = vi.hoisted(() => vi.fn())

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof DatabaseModule>()
	return {
		...actual,
		db: {
			...mockDb,
			query: { Organization: { findFirst: findOrg } },
		},
		Organization: drizzleTable,
		and: (...args: unknown[]) => args,
		eq: (...args: unknown[]) => args,
	}
})

vi.mock('#app/utils/menu/public-menu-context.server.ts', () => ({
	buildPublicSiteMenuPayload: buildMenu,
}))

vi.mock('#app/utils/menu/public-drop-context.server.ts', () => ({
	buildPublicSiteDropPayload: buildDrop,
}))

function args(
	params: { orgId?: string; locationId?: string; drop?: string } = {},
	authorized = true,
) {
	const url = new URL('http://localhost:3001/resources/order-context')
	url.searchParams.set('orgId', params.orgId ?? 'clw9x0a12000008l00cafeorg1')
	if (params.locationId) url.searchParams.set('locationId', params.locationId)
	if (params.drop) url.searchParams.set('drop', params.drop)
	return {
		request: new Request(url, {
			headers: authorized
				? { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }
				: {},
		}),
		params: {},
		context: new RouterContextProvider(),
		url,
		pattern: '/resources/order-context',
	}
}

const ORG_ID = 'clw9x0a12000008l00cafeorg1'

function orgRow(
	overrides: Partial<{
		dataRegion: string
		shopPaymentProvider: string
		stripeConnectAccountId: string | null
		stripeConnectChargesEnabled: boolean
		checkoutSubEntityId: string | null
		checkoutChargesEnabled: boolean
	}> = {},
) {
	return {
		id: ORG_ID,
		name: 'Cafe',
		slug: 'cafe',
		dataRegion: 'us',
		siteDefaultLocale: 'en',
		siteLocales: '["en","ar"]',
		customDomain: null,
		shopPaymentProvider: 'stripe',
		stripeConnectAccountId: 'acct_1',
		stripeConnectChargesEnabled: true,
		checkoutSubEntityId: null,
		checkoutChargesEnabled: false,
		...overrides,
	}
}

const MENU_PAYLOAD = {
	organization: {
		id: ORG_ID,
		name: 'Cafe',
		slug: 'cafe',
		currency: 'USD',
		defaultLocale: 'en',
		locales: ['en'],
	},
	locations: [],
	menus: [],
	locationOverrides: {},
}

const DROP_PAYLOAD = {
	organization: { id: ORG_ID, name: 'Cafe', slug: 'cafe', currency: 'USD' },
	drop: {
		id: 'drop_1',
		title: 'Friday Drop',
		slug: 'friday',
		status: 'live',
		checkoutHoldMinutes: 5,
	},
	pickupWindows: [],
	inventoryOverrides: [],
	categories: [],
}

type ContextPayload = {
	orgId: string
	dataRegion: string
	menu: typeof MENU_PAYLOAD
	drop: unknown
	onlinePayment: { enabled: boolean; processor: string | null }
}

async function loadContext(
	params: { orgId?: string; locationId?: string; drop?: string } = {},
	authorized = true,
): Promise<ContextPayload> {
	return (await (
		await loader(args(params, authorized))
	).json()) as ContextPayload
}

describe('internal restaurant order context', () => {
	beforeEach(() => {
		resetMockDb()
		findOrg.mockReset().mockResolvedValue(orgRow())
		buildMenu.mockReset().mockResolvedValue({
			payload: MENU_PAYLOAD,
			secondsUntilVariationReturn: null,
		})
		buildDrop.mockReset().mockResolvedValue(null)
	})

	it('requires internal command authentication (403, not a redirect)', async () => {
		const response = await loader(args({}, false))
		expect(response.status).toBe(403)
		expect(findOrg).not.toHaveBeenCalled()
	})

	it('rejects malformed org ids', async () => {
		expect((await loader(args({ orgId: '../invalid' }))).status).toBe(400)
	})

	it('only serves active, published, provisioned organizations', async () => {
		findOrg.mockResolvedValue(null)
		expect((await loader(args())).status).toBe(404)
	})

	it('returns fresh menu context with routing flags and no-store', async () => {
		const response = await loader(args({ locationId: 'loc_1' }))
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('private, no-store')

		const payload = (await response.json()) as ContextPayload
		expect(payload).toEqual({
			orgId: ORG_ID,
			dataRegion: 'us',
			menu: MENU_PAYLOAD,
			drop: null,
			onlinePayment: { enabled: true, processor: 'connect' },
		})

		// Fresh catalog reads: the builder is called with the resolved org and
		// the requested location, and nothing else.
		expect(buildMenu).toHaveBeenCalledTimes(1)
		expect(buildMenu).toHaveBeenCalledWith(
			expect.objectContaining({ id: ORG_ID, currency: 'USD' }),
			'loc_1',
		)
		expect(buildDrop).not.toHaveBeenCalled()
	})

	it('resolves KSA organizations with SAR currency and fails Stripe closed', async () => {
		findOrg.mockResolvedValue(
			orgRow({
				dataRegion: 'ksa',
				stripeConnectChargesEnabled: true,
				stripeConnectAccountId: 'acct_1',
			}),
		)
		const payload = await loadContext()
		expect(payload.dataRegion).toBe('ksa')
		expect(payload.onlinePayment).toEqual({ enabled: false, processor: null })
		expect(buildMenu).toHaveBeenCalledWith(
			expect.objectContaining({ currency: 'SAR' }),
			null,
		)
	})

	it('enables Checkout.com only with a charges-enabled sub-entity', async () => {
		findOrg.mockResolvedValue(
			orgRow({
				shopPaymentProvider: 'checkout',
				checkoutSubEntityId: 'ent_1',
				checkoutChargesEnabled: true,
			}),
		)
		expect((await loadContext()).onlinePayment).toEqual({
			enabled: true,
			processor: 'checkout',
		})

		findOrg.mockResolvedValue(
			orgRow({
				shopPaymentProvider: 'checkout',
				checkoutSubEntityId: null,
				checkoutChargesEnabled: true,
			}),
		)
		expect((await loadContext()).onlinePayment).toEqual({
			enabled: false,
			processor: null,
		})
	})

	it('fails closed for merchant-of-record providers and uncharged connect accounts', async () => {
		findOrg.mockResolvedValue(orgRow({ shopPaymentProvider: 'polar' }))
		expect((await loadContext()).onlinePayment).toEqual({
			enabled: false,
			processor: null,
		})

		findOrg.mockResolvedValue(
			orgRow({
				shopPaymentProvider: 'stripe',
				stripeConnectChargesEnabled: false,
			}),
		)
		expect((await loadContext()).onlinePayment).toEqual({
			enabled: false,
			processor: null,
		})
	})

	it('includes a published drop scoped to the org', async () => {
		buildDrop.mockResolvedValue(DROP_PAYLOAD)
		const payload = await loadContext({ drop: 'friday' })
		expect(payload.drop).toEqual(DROP_PAYLOAD)
		expect(buildDrop).toHaveBeenCalledWith(
			expect.objectContaining({ id: ORG_ID }),
			'friday',
		)
	})

	it('never leaks draft drops', async () => {
		buildDrop.mockResolvedValue({
			...DROP_PAYLOAD,
			drop: { ...DROP_PAYLOAD.drop, status: 'draft' },
		})
		expect((await loadContext({ drop: 'draft-drop' })).drop).toBeNull()
	})

	it('treats a missing drop as null rather than an error', async () => {
		buildDrop.mockResolvedValue(null)
		expect((await loadContext({ drop: 'ghost' })).drop).toBeNull()
	})
})
