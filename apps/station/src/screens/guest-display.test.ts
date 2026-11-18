/* eslint-disable testing-library/no-unnecessary-act */
// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Checkout } from './Checkout.tsx'
import { GuestDisplay } from './GuestDisplay.tsx'
import { db } from '~/lib/db.ts'
import {
	clearGuestCheckout,
	startGuestDisplayHost,
	useGuestCheckout,
} from '~/lib/guest-display-host.ts'
import { guestChannelName } from '~/lib/guest-display.ts'
import { type OrderDraft } from '~/lib/orders.ts'
import { type CartLine } from '~/lib/pricing.ts'
import { usePos } from '~/lib/store.ts'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

type Chan = {
	postMessage: (m: unknown) => void
	onmessage: ((e: { data: unknown }) => void) | null
	close: () => void
}
/** Two windows of one origin: what one posts the other hears, never itself. */
function makeBus() {
	const peers = new Map<string, Set<Chan>>()
	return (name: string): Chan => {
		const mine: Chan = {
			onmessage: null,
			postMessage(message) {
				for (const peer of peers.get(name) ?? [])
					if (peer !== mine)
						queueMicrotask(() =>
							peer.onmessage?.({ data: structuredClone(message) }),
						)
			},
			close() {
				peers.get(name)?.delete(mine)
			},
		}
		const set = peers.get(name) ?? new Set()
		set.add(mine)
		peers.set(name, set)
		return mine
	}
}

const line = (over: Partial<CartLine> = {}): CartLine => ({
	id: 'l1',
	itemId: 'a',
	name: 'Burger',
	variantId: null,
	variantLabel: null,
	quantity: 1,
	baseCents: 1000,
	instructions: '',
	options: [],
	...over,
})

let tillHost: HTMLDivElement
let tillRoot: Root
let screenHost: HTMLDivElement
let screenRoot: Root
let stop: (() => void) | null = null
const NAME = guestChannelName('demo', 'T1')

const settingsWith = (managed: Record<string, unknown>) => ({
	...usePos.getState().settings,
	slug: 'demo',
	terminalCode: 'T1',
	managed,
})

beforeEach(async () => {
	await db.orders.clear()
	await db.meta.clear()
	i18n.load('en', {})
	i18n.activate('en')
	vi.stubGlobal('matchMedia', () => ({ matches: true }))
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
	HTMLElement.prototype.scrollIntoView = vi.fn()
	HTMLDialogElement.prototype.showModal = function showModal() {
		this.open = true
	}
	HTMLDialogElement.prototype.close = function close() {
		this.open = false
	}
	tillHost = document.createElement('div')
	screenHost = document.createElement('div')
	document.body.append(tillHost, screenHost)
	tillRoot = createRoot(tillHost)
	screenRoot = createRoot(screenHost)
	clearGuestCheckout()
	usePos.setState({
		lines: [],
		adjustments: [],
		settings: settingsWith({ guestDisplayEnabled: true }),
	})
})

afterEach(() => {
	stop?.()
	stop = null
	act(() => {
		tillRoot.unmount()
		screenRoot.unmount()
	})
	tillHost.remove()
	screenHost.remove()
	clearGuestCheckout()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

/** The till and the guest screen, two windows over one bus. */
function openBoth() {
	const channel = makeBus()
	stop = startGuestDisplayHost({
		slug: 'demo',
		terminalCode: 'T1',
		createChannel: channel,
	})
	act(() =>
		screenRoot.render(
			h(
				I18nProvider,
				{ i18n },
				h(GuestDisplay, { channelName: NAME, createChannel: channel }),
			),
		),
	)
	return channel
}
const screenText = () => screenHost.textContent ?? ''
const flush = () => act(async () => void (await Promise.resolve()))

describe('guest second screen (#367)', () => {
	it('shows the idle image when no order is open, and only a plain https address', async () => {
		usePos.setState({
			settings: settingsWith({
				guestDisplayEnabled: true,
				guestDisplayImageUrl: 'https://cdn.test/idle.png',
			}),
		})
		openBoth()
		await flush()
		await flush()
		const image = screenHost.querySelector<HTMLImageElement>(
			'[data-guest-idle-image]',
		)
		expect(image?.getAttribute('src')).toBe('https://cdn.test/idle.png')
		expect(screenHost.querySelector('[data-view="idle"]')).toBeTruthy()
		expect(screenHost.querySelector('[data-guest-order]')).toBeNull()
		// An unsafe address is never loaded.
		stop?.()
		act(() => screenRoot.unmount())
		screenRoot = createRoot(screenHost)
		usePos.setState({
			settings: settingsWith({
				guestDisplayEnabled: true,
				guestDisplayImageUrl: 'javascript:alert(1)',
			}),
		})
		openBoth()
		await flush()
		await flush()
		expect(screenHost.querySelector('[data-guest-idle-image]')).toBeNull()
	})

	it('shows an item added at the till on the second screen well within a second', async () => {
		openBoth()
		await flush()
		await flush()
		expect(screenHost.querySelector('[data-view="idle"]')).toBeTruthy()
		const started = performance.now()
		act(() => {
			usePos.setState({
				lines: [line({ name: 'Flat white', quantity: 2, baseCents: 450 })],
			})
		})
		await flush()
		await flush()
		const elapsed = performance.now() - started
		expect(screenText()).toContain('Flat white')
		expect(screenText()).toContain('2×')
		expect(screenText()).toContain('$9.00')
		expect(elapsed).toBeLessThan(1000)
		expect(screenHost.querySelector('[data-view="order"]')).toBeTruthy()
		// Clearing the order goes back to the idle screen.
		act(() => usePos.setState({ lines: [] }))
		await flush()
		await flush()
		expect(screenHost.querySelector('[data-view="idle"]')).toBeTruthy()
		expect(screenText()).not.toContain('Flat white')
	})

	it('shows no staff or customer details, only the order', async () => {
		usePos.setState({
			lines: [line({ instructions: 'ring the bell for Dana', name: 'Soup' })],
			customerName: 'Dana Whitfield',
			customerPhone: '+15551234567',
			tableLabel: 'T12',
			session: {
				staff: { id: 's1', name: 'Sam L.' },
				role: 'manager',
				mode: 'online',
			},
		} as never)
		openBoth()
		await flush()
		await flush()
		const text = screenText()
		expect(text).toContain('Soup')
		for (const secret of ['Sam', 'Dana', '5551234567', 'T12', 'ring the bell'])
			expect(text).not.toContain(secret)
		usePos.setState({
			session: null,
			customerName: '',
			customerPhone: '',
			tableLabel: '',
		})
	})

	it('a tip chosen on the second screen is written to the order being paid', async () => {
		openBoth()
		const draft: OrderDraft = {
			terminalCode: 'T1',
			locationId: 'loc',
			currency: 'USD',
			taxRatePercent: 0,
			orderType: 'dine_in',
			customerName: '',
			tableLabel: '4',
			lines: [line({ quantity: 10 })], // $100.00
			adjustments: [],
			tipCents: 0,
		}
		const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
		act(() =>
			tillRoot.render(
				h(
					I18nProvider,
					{ i18n },
					h(Checkout, {
						draft,
						existing: null,
						businessName: 'Cafe',
						money,
						tipsEnabled: true,
						staff: null,
						onSaved: () => undefined,
						onClose: () => undefined,
					}),
				),
			),
		)
		await flush()
		await flush()
		// The guest sees the bill and the tip prompt.
		expect(screenHost.querySelector('[data-view="checkout"]')).toBeTruthy()
		expect(screenHost.querySelector('[data-guest-tip]')).toBeTruthy()
		expect(screenText()).toContain('$100.00')
		const tip15 = [...screenHost.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === '15%',
		)!
		act(() => tip15.click())
		await flush()
		await flush()
		// The till's bill now carries the tip, and so does the guest's total.
		expect(tillHost.textContent).toContain('Tip$15.00')
		expect(screenText()).toContain('$115.00')
		expect(
			screenHost.querySelector('[data-guest-tip] [aria-pressed="true"]')
				?.textContent,
		).toBe('15%')
		// Paying stores the order with that tip.
		const exact = [...tillHost.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Exact',
		)!
		act(() => exact.click())
		const confirm = [...tillHost.querySelectorAll('button')].find((b) =>
			b.textContent?.trim().startsWith('Confirm'),
		)!
		await act(async () => {
			confirm.click()
			await new Promise((resolve) => setTimeout(resolve, 50))
		})
		const [saved] = await db.orders.toArray()
		expect(saved?.totals.tipCents).toBe(1500)
		expect(saved?.totals.totalCents).toBe(11_500)
	})

	it('ignores a tip nobody offered, and a tip outside the choices', async () => {
		const channel = openBoth()
		const stranger = channel(NAME)
		// No payment is open: there is no tip to set.
		stranger.postMessage({ type: 'tip', percent: 20 })
		await flush()
		expect(useGuestCheckout.getState().requested).toBeNull()
		// Payment open with tips offered: only the offered percentages apply.
		const draft: OrderDraft = {
			terminalCode: 'T1',
			locationId: 'loc',
			currency: 'USD',
			taxRatePercent: 0,
			orderType: 'dine_in',
			customerName: '',
			tableLabel: '4',
			lines: [line({ quantity: 10 })],
			adjustments: [],
			tipCents: 0,
		}
		act(() =>
			tillRoot.render(
				h(
					I18nProvider,
					{ i18n },
					h(Checkout, {
						draft,
						existing: null,
						businessName: 'Cafe',
						money: (cents: number) => `$${(cents / 100).toFixed(2)}`,
						tipsEnabled: true,
						staff: null,
						onSaved: () => undefined,
						onClose: () => undefined,
					}),
				),
			),
		)
		await flush()
		stranger.postMessage({ type: 'tip', percent: 33 })
		stranger.postMessage({ type: 'tip', percent: -5 })
		stranger.postMessage({ type: 'tip', percent: 'lots' })
		await flush()
		await flush()
		expect(tillHost.textContent).not.toContain('Tip$')
	})
})
