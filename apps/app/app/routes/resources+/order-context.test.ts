import type * as DatabaseModule from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	drizzleTable,
	mockDb,
	queryChain,
	resetMockDb,
} from '#tests/setup/drizzle-mock.ts'
import { loader } from './order-context.ts'

const findOrg = vi.hoisted(() => vi.fn())
const buildMenu = vi.hoisted(() => vi.fn())
const buildDrop = vi.hoisted(() => vi.fn())
const featureFlag = vi.hoisted(() => vi.fn())

// Flags default off (null); tests turn one on by key.
vi.mock('@repo/common/feature-flags', () => ({
	getFeatureFlag: featureFlag,
}))

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
		featureFlag.mockReset().mockResolvedValue(null)
	})

	it('requires internal command authentication (401, not a redirect)', async () => {
		const response = await loader(args({}, false))
		expect(response.status).toBe(401)
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
			// QR flags default off (no ConfigFlag rows): the region fails closed.
			qrOrdering: { enabled: false, dineIn: false, online: false },
			// Guest messages are off by default, so no switch is on.
			guestMessages: {
				enabled: false,
				receipt: false,
				ready: false,
				cancelled: false,
			},
			// No locations: nothing extra to prep.
			largeOrder: {},
			// Guest cancel and manual acceptance flags default off: the region
			// reads every location as no cancel and Automatic.
			guestCancel: {},
			acceptance: {},
			// The service fee flag defaults off too: no location is listed.
			serviceFee: { version: 1, locations: {} },
			// Discount flags default off too: nothing to evaluate.
			discounts: {
				features: { automatic: false, coupons: false },
				discounts: [],
				codes: [],
			},
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

/** Rows per table for `db.select().from(table)`; `where` is not evaluated. */
function selectRows(rows: Map<unknown, unknown[]>) {
	mockDb.select.mockImplementation((() => ({
		from: (table: unknown) => queryChain(rows.get(table) ?? []),
	})) as never)
}

describe('order context: guest messages and large orders', () => {
	beforeEach(async () => {
		resetMockDb()
		findOrg.mockReset().mockResolvedValue(orgRow())
		buildMenu.mockReset().mockResolvedValue({
			payload: MENU_PAYLOAD,
			secondsUntilVariationReturn: null,
		})
		buildDrop.mockReset().mockResolvedValue(null)
		featureFlag.mockReset().mockResolvedValue(null)
	})

	type Extra = {
		guestMessages: {
			enabled: boolean
			receipt: boolean
			ready: boolean
			cancelled: boolean
		}
		largeOrder: Record<
			string,
			{ threshold: number; thresholdType: string; extraPrepMinutes: number }
		>
	}

	it('sends every switch off while the flag is off, whatever is stored', async () => {
		const { ConfigFlag } = await import('@repo/database')
		selectRows(
			new Map([
				[
					ConfigFlag,
					[{ value: { receipt: true, ready: true, cancelled: true } }],
				],
			]),
		)
		const payload = (await loadContext()) as unknown as Extra
		expect(payload.guestMessages).toEqual({
			enabled: false,
			receipt: false,
			ready: false,
			cancelled: false,
		})
	})

	it('defaults all switches on when the flag is on and nothing is stored', async () => {
		featureFlag.mockImplementation(async (key: string) =>
			key === 'ordering.guest_messages' ? true : null,
		)
		const payload = (await loadContext()) as unknown as Extra
		expect(payload.guestMessages).toEqual({
			enabled: true,
			receipt: true,
			ready: true,
			cancelled: true,
		})
	})

	it('reads the operator switches, treating a missing one as on', async () => {
		featureFlag.mockImplementation(async (key: string) =>
			key === 'ordering.guest_messages' ? true : null,
		)
		const { ConfigFlag } = await import('@repo/database')
		selectRows(
			new Map([[ConfigFlag, [{ value: { receipt: false, ready: false } }]]]),
		)
		const payload = (await loadContext()) as unknown as Extra
		expect(payload.guestMessages).toEqual({
			enabled: true,
			receipt: false,
			ready: false,
			cancelled: true,
		})
	})

	it('maps stored large-order fields to the wire vocabulary and skips unset ones', async () => {
		const { OrganizationLocation } = await import('@repo/database')
		const row = (
			id: string,
			threshold: number | null,
			type: string,
			minutes: number,
		) => ({
			id,
			largeOrderThreshold: threshold,
			largeOrderThresholdType: type,
			largeOrderExtraPrepTime: minutes,
		})
		selectRows(
			new Map([
				[
					OrganizationLocation,
					[
						row('loc_amount', 120.5, 'dollars', 20),
						row('loc_items', 8, 'items', 10),
						row('loc_no_threshold', null, 'dollars', 15),
						row('loc_zero_threshold', 0, 'items', 15),
						row('loc_no_minutes', 50, 'dollars', 0),
						row('loc_unknown', 50, 'bananas', 15),
					],
				],
			]),
		)
		const payload = (await loadContext()) as unknown as Extra
		expect(payload.largeOrder).toEqual({
			loc_amount: {
				threshold: 120.5,
				thresholdType: 'amount',
				extraPrepMinutes: 20,
			},
			loc_items: { threshold: 8, thresholdType: 'items', extraPrepMinutes: 10 },
		})
	})
})

describe('order context: guest cancel and order acceptance', () => {
	beforeEach(async () => {
		resetMockDb()
		findOrg.mockReset().mockResolvedValue(orgRow())
		buildMenu.mockReset().mockResolvedValue({
			payload: MENU_PAYLOAD,
			secondsUntilVariationReturn: null,
		})
		buildDrop.mockReset().mockResolvedValue(null)
		featureFlag.mockReset().mockResolvedValue(null)
	})

	type Extra = {
		guestCancel: Record<string, unknown>
		acceptance: Record<string, unknown>
	}

	function policyRow(
		id: string,
		overrides: Partial<{
			guestCancelMinutes: number | null
			guestCancelScheduledLeadMinutes: number | null
			orderAcceptanceMode: string
			orderAcceptanceTimeoutMinutes: number
			orderAcceptanceMinTotalCents: number | null
			orderAcceptanceScheduledOnly: boolean
		}> = {},
	) {
		return {
			id,
			// Large-order fields left unset: no extra prep.
			largeOrderThreshold: null,
			largeOrderThresholdType: 'dollars',
			largeOrderExtraPrepTime: 0,
			guestCancelMinutes: null,
			guestCancelScheduledLeadMinutes: null,
			orderAcceptanceMode: 'auto',
			orderAcceptanceTimeoutMinutes: 5,
			orderAcceptanceMinTotalCents: null,
			orderAcceptanceScheduledOnly: false,
			...overrides,
		}
	}

	const ROWS = [
		policyRow('loc_cancel', {
			guestCancelMinutes: 2,
			guestCancelScheduledLeadMinutes: 60,
			orderAcceptanceMode: 'manual',
			orderAcceptanceTimeoutMinutes: 10,
			orderAcceptanceMinTotalCents: 5000,
			orderAcceptanceScheduledOnly: true,
		}),
		policyRow('loc_off', { guestCancelMinutes: 0 }),
		policyRow('loc_odd', {
			guestCancelMinutes: 7,
			orderAcceptanceMode: 'manual',
			orderAcceptanceTimeoutMinutes: 4,
			orderAcceptanceMinTotalCents: -1,
		}),
		policyRow('loc_no_lead', {
			guestCancelMinutes: 10,
			guestCancelScheduledLeadMinutes: 99_999,
		}),
	]

	async function withRows() {
		const { OrganizationLocation } = await import('@repo/database')
		selectRows(new Map([[OrganizationLocation, ROWS]]))
	}

	it('sends no policy and reads no location while both flags are off', async () => {
		await withRows()
		const payload = (await loadContext()) as unknown as Extra
		expect(payload.guestCancel).toEqual({})
		expect(payload.acceptance).toEqual({})
	})

	it('sends guest cancel windows only for locations that offer one', async () => {
		featureFlag.mockImplementation(async (key: string) =>
			key === 'ordering.guest_cancel' ? true : null,
		)
		await withRows()
		const payload = (await loadContext()) as unknown as Extra
		expect(payload.guestCancel).toEqual({
			loc_cancel: { minutes: 2, scheduledLeadMinutes: 60 },
			loc_no_lead: { minutes: 10, scheduledLeadMinutes: null },
		})
		// Manual acceptance stays Automatic while its own flag is off.
		expect(payload.acceptance).toEqual({})
	})

	it('sends manual acceptance only for manual locations, with safe defaults', async () => {
		featureFlag.mockImplementation(async (key: string) =>
			key === 'ordering.manual_acceptance' ? true : null,
		)
		await withRows()
		const payload = (await loadContext()) as unknown as Extra
		expect(payload.acceptance).toEqual({
			loc_cancel: {
				mode: 'manual',
				timeoutMinutes: 10,
				minTotalCents: 5000,
				scheduledOnly: true,
			},
			loc_odd: {
				mode: 'manual',
				timeoutMinutes: 5,
				minTotalCents: null,
				scheduledOnly: false,
			},
		})
		expect(payload.guestCancel).toEqual({})
	})

	it('only a literal true turns a flag on', async () => {
		featureFlag.mockImplementation(async () => 'true')
		await withRows()
		const payload = (await loadContext()) as unknown as Extra
		expect(payload.guestCancel).toEqual({})
		expect(payload.acceptance).toEqual({})
	})
})

describe('order context: service fee', () => {
	beforeEach(async () => {
		resetMockDb()
		findOrg.mockReset().mockResolvedValue(orgRow())
		buildMenu.mockReset().mockResolvedValue({
			payload: MENU_PAYLOAD,
			secondsUntilVariationReturn: null,
		})
		buildDrop.mockReset().mockResolvedValue(null)
		featureFlag.mockReset().mockResolvedValue(null)
	})

	const ON = JSON.stringify({
		enabled: true,
		percentBp: 300,
		fixedMinor: 0,
		capMinor: 200,
		smallOrderBelowMinor: null,
		smallOrderFeeMinor: null,
		fulfillments: ['pickup'],
		label: 'Service fee',
		explanation: null,
		taxable: false,
	})

	async function withFees(rows: Array<{ id: string; serviceFee: string | null }>) {
		const { OrganizationLocation } = await import('@repo/database')
		selectRows(
			new Map([
				[
					OrganizationLocation,
					rows.map((row) => ({
						...row,
						largeOrderThreshold: null,
						largeOrderThresholdType: 'dollars',
						largeOrderExtraPrepTime: 0,
					})),
				],
			]),
		)
	}

	const flagOn = () =>
		featureFlag.mockImplementation(async (key: string) =>
			key === 'ordering.service_fee' ? true : null,
		)

	type Fee = { serviceFee: { version: number; locations: Record<string, unknown> } }

	it('lists no location while the flag is off, whatever is saved', async () => {
		await withFees([{ id: 'loc_a', serviceFee: ON }])
		const payload = (await loadContext()) as unknown as Fee
		expect(payload.serviceFee).toEqual({ version: 1, locations: {} })
	})

	it('lists only locations whose saved fee is on, as stored', async () => {
		flagOn()
		await withFees([
			{ id: 'loc_on', serviceFee: ON },
			{ id: 'loc_off', serviceFee: JSON.stringify({ ...(JSON.parse(ON) as Record<string, unknown>), enabled: false }) },
			{ id: 'loc_none', serviceFee: null },
		])
		const payload = (await loadContext()) as unknown as Fee
		expect(payload.serviceFee.version).toBe(1)
		expect(payload.serviceFee.locations).toEqual({ loc_on: JSON.parse(ON) })
	})

	it('passes a value it cannot read through, so the region refuses instead of dropping the fee', async () => {
		flagOn()
		await withFees([
			{ id: 'loc_junk', serviceFee: '{not json' },
			{ id: 'loc_odd', serviceFee: JSON.stringify({ percentBp: 'x' }) },
		])
		const payload = (await loadContext()) as unknown as Fee
		expect(payload.serviceFee.locations).toEqual({
			loc_junk: { enabled: true },
			loc_odd: { percentBp: 'x' },
		})
	})
})
