// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Checkout } from './Checkout.tsx'
import { db } from '~/lib/db.ts'
import { type OrderDraft } from '~/lib/orders.ts'
import { type CartLine } from '~/lib/pricing.ts'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
	await db.orders.clear()
	await db.meta.clear()
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
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})

afterEach(() => {
	act(() => root.unmount())
	host.remove()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

const line: CartLine = {
	id: 'l1',
	itemId: 'a',
	name: 'Burger',
	variantId: null,
	variantLabel: null,
	quantity: 10,
	baseCents: 1000,
	instructions: '',
	options: [],
}
const draft: OrderDraft = {
	terminalCode: 'T1',
	locationId: 'loc',
	currency: 'USD',
	taxRatePercent: 10,
	orderType: 'dine_in',
	customerName: '',
	tableLabel: '4',
	lines: [line],
	adjustments: [],
	tipCents: 0,
}
const money = (cents: number) =>
	`${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`

function draw(cashDiscountBp: number | null) {
	i18n.load('en', {})
	i18n.activate('en')
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() =>
		root.render(
			h(
				I18nProvider,
				{ i18n },
				h(Checkout, {
					draft,
					existing: null,
					businessName: 'Cafe',
					money,
					tipsEnabled: false,
					staff: null,
					cashDiscountBp,
					onSaved: () => undefined,
					onClose: () => undefined,
				}),
			),
		),
	)
}

const text = () => document.body.textContent ?? ''
const click = (label: string) => {
	const button = [...document.querySelectorAll('button')].find(
		(node) => node.textContent?.trim() === label,
	)
	if (!button) throw new Error(`No button "${label}"`)
	act(() => button.click())
}

describe('the cash discount at the checkout (#375)', () => {
	it('shows its own line and the cash price while the bill is set to cash in full', () => {
		draw(300)
		expect(text()).toContain('Cash discount (3%)')
		expect(text()).toContain('-$3.00')
		// 100.00 less 3.00, tax 9.70, no tip: 106.70 rather than 110.00.
		expect(text()).toContain('Total due$106.70')
	})

	it('takes it off, and says how to get it, when the cashier chooses a card', () => {
		draw(300)
		click('Card')
		expect(text()).not.toContain('Cash discount (3%)')
		expect(text()).toContain('Total due$110.00')
		expect(text()).toContain('to save 3%')
	})

	it('takes it off for a split or a part payment, and puts it back for the whole bill', () => {
		draw(300)
		click('Split 2')
		expect(text()).not.toContain('Cash discount (3%)')
		click('Full')
		expect(text()).toContain('Cash discount (3%)')
	})

	it('is not offered at a location without a rate', () => {
		draw(null)
		expect(text()).not.toContain('Cash discount')
		expect(text()).toContain('Total due$110.00')
		expect(text()).not.toContain('to save')
	})
})
