/* eslint-disable testing-library/no-unnecessary-act */
// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrintedTicket } from '../apps/orders/Orders.tsx'
import { Receipt } from './Receipt.tsx'
import { type PosOrder } from '~/lib/db.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

/**
 * What the till prints today. These snapshots were taken from the code as it
 * was before ticket contents became configurable (#363): with no settings, the
 * printed markup must be byte for byte the same.
 */
let host: HTMLDivElement
let root: Root
beforeEach(() => {
	i18n.load('en', {})
	i18n.activate('en')
	// Dates print in the tablet's own zone: fix the text, not the clock.
	vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue(
		'18/11/2026, 14:02',
	)
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	document.getElementById('receipt')?.remove()
	vi.restoreAllMocks()
})

const order = (over: Partial<PosOrder> = {}): PosOrder =>
	({
		id: 'o1',
		number: 'T1-0042',
		businessDate: '2026-11-18',
		createdAt: 1_800_000_000_000,
		orderType: 'dine_in',
		customerName: '',
		tableLabel: '4',
		locationId: 'loc',
		currency: 'USD',
		taxRatePercent: 10,
		taxInclusive: false,
		catalogFetchedAt: null,
		lines: [
			{
				id: 'l1',
				itemId: 'burger',
				name: 'Burger',
				variantId: 'v',
				variantLabel: 'Large',
				quantity: 2,
				baseCents: 1000,
				instructions: 'no onions',
				options: [
					{
						groupId: 'g',
						groupName: 'Extras',
						optionId: 'cheese',
						optionName: 'Cheese',
						quantity: 1,
						unitCents: 150,
						taxable: true,
					},
				],
			},
			{
				id: 'l2',
				itemId: 'fries',
				name: 'Fries',
				variantId: null,
				variantLabel: null,
				quantity: 1,
				baseCents: 400,
				instructions: '',
				options: [],
			},
		],
		lineVoids: [],
		adjustments: [
			{ id: 'a1', kind: 'manual', label: 'Staff meal', amountCents: 200 },
		],
		totals: {
			subtotalCents: 2700,
			adjustmentCents: 200,
			taxCents: 250,
			tipCents: 300,
			totalCents: 3050,
		},
		status: 'paid',
		payments: [
			{
				id: 'p1',
				method: 'cash',
				amountCents: 3050,
				tenderedCents: 4000,
				changeCents: 950,
				at: 1_800_000_000_000,
			},
		],
		refunds: [
			{
				id: 'r1',
				paymentId: 'p1',
				method: 'cash',
				amountCents: 500,
				at: 1_800_000_100_000,
				by: null,
				approvedBy: null,
				reason: 'mistake',
				reference: null,
			},
		],
		fiscal: [
			{
				kind: 'invoice',
				counter: 7,
				at: 1_800_000_000_000,
				totalCents: 3050,
				taxCents: 250,
			},
		] as never,
		revision: 2,
		updatedAt: 1_800_000_000_000,
		sync: 'synced',
		attempts: 0,
		nextAttemptAt: 0,
		lastError: null,
		syncedAt: null,
		serverNumber: null,
		staff: { id: 's', name: 'Sam L.' },
		...over,
	}) as PosOrder

const draw = (node: ReturnType<typeof h>) => {
	act(() => root.render(h(I18nProvider, { i18n }, node)))
	// The icon sprite's address depends on where the repository is checked out.
	return document
		.getElementById('receipt')!
		.outerHTML.replace(/href="[^"]*sprite\.svg#/g, 'href="SPRITE#')
}

describe('the till receipt as it prints today', () => {
	it('a dine-in sale paid in cash, with an option, a note, a discount, a tip and a refund', () => {
		expect(
			draw(h(Receipt, { order: order(), businessName: 'Cafe Bloom' })),
		).toMatchSnapshot()
	})

	it('the same sale as a simplified tax invoice', () => {
		expect(
			draw(
				h(Receipt, {
					order: order(),
					businessName: 'Cafe Bloom',
					vatNumber: '300000000000003',
				}),
			),
		).toMatchSnapshot()
	})

	it('an open tab (a bill) with a balance and a takeaway name', () => {
		expect(
			draw(
				h(Receipt, {
					order: order({
						status: 'open',
						orderType: 'takeaway',
						customerName: 'Dana',
						payments: [],
						refunds: [],
						fiscal: [],
						staff: null,
					}),
					businessName: 'Cafe Bloom',
				}),
			),
		).toMatchSnapshot()
	})

	it('a drive-through order', () => {
		expect(
			draw(
				h(Receipt, {
					order: order({
						orderType: 'drive_through',
						driveThroughNote: 'Lane 2',
						refunds: [],
					}),
					businessName: 'Cafe Bloom',
				}),
			),
		).toMatchSnapshot()
	})
})

const detail = (over: Record<string, unknown> = {}) =>
	({
		id: 'w1',
		number: 'W-0951',
		fulfillment: 'delivery',
		tableLabel: null,
		createdAt: 1_800_000_000_000,
		dueAt: 1_800_000_900_000,
		guestName: 'Jordan',
		phoneMasked: '•••• 0111',
		currency: 'USD',
		totalCents: 2800,
		paymentStatus: 'paid',
		onTab: false,
		utensilsRequested: true,
		largeOrderExtraMinutes: 10,
		status: 'preparing',
		lines: [
			{
				name: 'Pizza',
				variantNames: ['Large'],
				quantity: 2,
				totalCents: 2400,
				instructions: 'well done',
				options: [
					{
						name: 'Olives',
						quantity: 1,
						half: null,
						kitchenName: 'OLV',
						groupName: 'Toppings',
						highlight: 'allergy',
					},
				],
				kitchenName: 'PZ L',
				highlight: 'attention',
				courseId: 'c1',
				courseName: 'Mains',
				coursePosition: 1,
				held: true,
			},
			{
				name: 'Cola',
				variantNames: [],
				quantity: 1,
				totalCents: 400,
				instructions: null,
				options: [],
			},
		],
		...over,
	}) as never

const switches = (over: Record<string, boolean> = {}) => ({
	showPaymentStatus: false,
	showOrderTypeColor: false,
	showModifierGroups: false,
	...over,
})
const time = new Intl.DateTimeFormat('en', {
	hour: '2-digit',
	minute: '2-digit',
	timeZone: 'UTC',
})

describe('the online order tickets as they print today', () => {
	const ticket = (
		kind: 'guest' | 'kitchen',
		order: unknown = detail(),
		kitchenSwitches = switches(),
	) =>
		draw(
			h(PrintedTicket, {
				kind,
				detail: order as never,
				businessName: 'Cafe Bloom',
				time,
				kitchenSwitches,
			}),
		)

	it('the guest ticket', () => {
		expect(ticket('guest')).toMatchSnapshot()
	})
	it('the kitchen ticket, every switch off', () => {
		expect(ticket('kitchen')).toMatchSnapshot()
	})
	it('the kitchen ticket with payment status, colour and modifier groups on', () => {
		expect(
			ticket(
				'kitchen',
				detail(),
				switches({
					showPaymentStatus: true,
					showOrderTypeColor: true,
					showModifierGroups: true,
				}),
			),
		).toMatchSnapshot()
	})
	it('a dine-in pay-at-handoff order on the tab', () => {
		expect(
			ticket(
				'guest',
				detail({
					fulfillment: 'dine_in',
					tableLabel: '9',
					paymentStatus: 'unpaid',
					onTab: true,
					dueAt: null,
				}),
			),
		).toMatchSnapshot()
	})
})

describe('sanity', () => {
	it('the fixtures print something', () => {
		expect(draw(h(Receipt, { order: order(), businessName: 'X' }))).toContain(
			'Burger',
		)
		expect(host).toBeTruthy()
		expect(vi.isMockFunction(Date.prototype.toLocaleString)).toBe(true)
	})
})

describe('Check ID and a stated allergy on printed tickets (#167, #294)', () => {
	const printed = (
		kind: 'guest' | 'kitchen',
		over: Record<string, unknown> = {},
	) =>
		draw(
			h(PrintedTicket, {
				kind,
				detail: detail(over),
				businessName: 'Cafe Bloom',
				time,
				kitchenSwitches: switches(),
			}),
		)

	it('boxes the allergy as words and an icon on the kitchen ticket, not on the guest ticket', () => {
		const kitchen = printed('kitchen', { guestAllergy: true })
		expect(kitchen).toContain('data-guest-allergy')
		expect(kitchen).toContain('Allergy stated by guest')
		expect(kitchen).toContain('border-2')
		expect(printed('guest', { guestAllergy: true })).not.toContain(
			'data-guest-allergy',
		)
	})

	it('says Check ID on the kitchen ticket and the guest ticket of an alcohol order', () => {
		for (const kind of ['kitchen', 'guest'] as const) {
			expect(printed(kind, { checkId: true })).toContain('Check ID')
		}
	})

	it('prints nothing extra for an ordinary order', () => {
		const html = printed('kitchen')
		expect(html).not.toContain('Check ID')
		expect(html).not.toContain('data-guest-allergy')
	})

	it('says Check ID on the till receipt when the sale holds alcohol', async () => {
		const { usePos } = await import('~/lib/store.ts')
		const before = usePos.getState().recordItems
		usePos.setState({
			recordItems: new Map([
				['burger', { id: 'burger', isAlcohol: true } as never],
			]),
		})
		try {
			expect(
				draw(h(Receipt, { order: order(), businessName: 'Cafe Bloom' })),
			).toContain('Check ID')
		} finally {
			usePos.setState({ recordItems: before })
		}
		expect(
			draw(h(Receipt, { order: order(), businessName: 'Cafe Bloom' })),
		).not.toContain('Check ID')
	})
})

describe('logo and codes on the till receipt (#263)', () => {
	const extrasOn = {
		extras: {
			logo: true,
			review: { show: true, caption: 'Tell us how we did' },
			app: { show: true },
		},
	}
	const prepare = async (opts: {
		tickets?: unknown
		codes?: { reviewUrl: string | null; appUrl: string | null }
		logo?: string | null
	}) => {
		const { usePos } = await import('~/lib/store.ts')
		const before = usePos.getState()
		usePos.setState({
			location: {
				stationSettings: { tickets: opts.tickets ?? extrasOn },
				receiptCodes: opts.codes ?? {
					reviewUrl: 'https://g.page/r/abc/review',
					appUrl: 'https://site.test/get-app?p=print',
				},
			} as never,
			snapshot: {
				organization: {
					siteIcon: opts.logo === null ? null : { appleTouchIcon: 'https://app.test/logo.png' },
				},
			} as never,
		})
		return () =>
			usePos.setState({ location: before.location, snapshot: before.snapshot })
	}
	const html = async (over: Partial<PosOrder> = {}, vatNumber?: string) => {
		const act2 = draw(
			h(Receipt, { order: order(over), businessName: 'Cafe Bloom', vatNumber }),
		)
		// The QR images resolve asynchronously: wait for them (a slow machine takes longer).
		const dom = document.getElementById('receipt')!
		const imagesReady = () =>
			dom.querySelectorAll('[data-receipt-code]').length ===
				dom.querySelectorAll('[data-receipt-code] img').length &&
			(!vatNumber ||
				dom.querySelectorAll('img:not([data-receipt-logo])').length > 0)
		for (let i = 0; i < 100 && !imagesReady(); i++) {
			await new Promise((r) => setTimeout(r, 20))
		}
		return { html: act2, dom }
	}

	it('shows the logo and both codes with their captions when switched on', async () => {
		const restore = await prepare({})
		try {
			const { dom } = await html()
			expect(dom.querySelector('[data-receipt-logo]')).not.toBeNull()
			const codes = [...dom.querySelectorAll('[data-receipt-code]')]
			expect(codes.map((c) => c.getAttribute('data-receipt-code'))).toEqual([
				'review',
				'app',
			])
			expect(codes[0]!.textContent).toContain('Tell us how we did')
			expect(codes[1]!.textContent).toContain('Order ahead next time')
		} finally {
			restore()
		}
	})

	it('shows no review code for a location without a review link', async () => {
		const restore = await prepare({
			codes: { reviewUrl: null, appUrl: 'https://site.test/get-app?p=print' },
		})
		try {
			const { dom } = await html()
			expect(dom.querySelector('[data-receipt-code="review"]')).toBeNull()
			expect(dom.querySelector('[data-receipt-code="app"]')).not.toBeNull()
		} finally {
			restore()
		}
	})

	it('keeps the ZATCA code first and unchanged on a KSA receipt, with the codes after it', async () => {
		const restore = await prepare({})
		try {
			const withoutCodes = await prepare({ tickets: {} })
			const { dom: plain } = await html({}, '300000000000003')
			const fiscalPlain = plain.querySelector('img:not([data-receipt-logo])')!
			const plainSrc = fiscalPlain.getAttribute('src')
			withoutCodes()
			// Back to the codes-on state.
			await prepare({})
			const { dom } = await html({}, '300000000000003')
			const images = [...dom.querySelectorAll('img')].filter(
				(img) => !img.hasAttribute('data-receipt-logo'),
			)
			// First is the fiscal code, byte for byte what it was; the codes follow.
			expect(images[0]!.getAttribute('src')).toBe(plainSrc)
			const fiscalIndex = [...dom.querySelectorAll('*')].indexOf(images[0]!)
			const codeIndex = [...dom.querySelectorAll('*')].indexOf(
				dom.querySelector('[data-receipt-code]')!,
			)
			expect(fiscalIndex).toBeLessThan(codeIndex)
		} finally {
			restore()
		}
	})

	it('never puts marketing on a voided sale', async () => {
		const restore = await prepare({})
		try {
			const { dom } = await html({ status: 'void' })
			expect(dom.querySelector('[data-receipt-logo]')).toBeNull()
			expect(dom.querySelector('[data-receipt-code]')).toBeNull()
		} finally {
			restore()
		}
	})
})
