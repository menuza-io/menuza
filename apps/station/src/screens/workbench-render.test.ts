// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	act,
	createElement as h,
	type ComponentProps,
	type ReactNode,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppLauncher } from './AppLauncher.tsx'
import { Cart } from './Cart.tsx'
import { MenuGrid } from './MenuGrid.tsx'
import { type CartLine } from '~/lib/pricing.ts'
import { type MenuItem } from '~/lib/types.ts'

;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const issues: unknown[][] = []
beforeEach(() => {
	issues.length = 0
	vi.spyOn(console, 'error').mockImplementation((...args) => {
		issues.push(args)
	})
	vi.spyOn(console, 'warn').mockImplementation((...args) => {
		issues.push(args)
	})
	vi.stubGlobal('matchMedia', () => ({ matches: true }))
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			disconnect() {}
		},
	)
	HTMLElement.prototype.scrollIntoView = vi.fn()
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
})
afterEach(() => {
	act(() => root.unmount())
	host.remove()
	try {
		expect(issues).toEqual([])
	} finally {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	}
})
function draw(node: ReactNode) {
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, node)))
}
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`
const item: MenuItem = {
	id: 'dish',
	displayName: 'House dish',
	description: 'Prepared to order',
	price: 12,
	imageUrl: null,
	variations: { groups: [], variants: [] },
	isVegetarian: true,
	isGlutenFree: false,
	isAlcohol: false,
	allergens: [],
	isPopular: false,
	availabilityStatus: 'available',
	position: 0,
	modifierGroups: [],
}
const line: CartLine = {
	id: 'line',
	itemId: item.id,
	name: item.displayName,
	variantId: null,
	variantLabel: 'Regular',
	quantity: 2,
	baseCents: 1200,
	instructions: 'No salt',
	options: [],
}

describe('flat shared Item workbench', () => {
	it('renders actual Item menu rows, preserving sold-out state, labels and pick payloads', () => {
		const pick = vi.fn()
		draw(
			h(MenuGrid, {
				categories: [
					{
						id: 'cat',
						displayName: 'Menu',
						items: [
							item,
							{
								...item,
								id: 'sold',
								displayName: 'Sold dish',
								availabilityStatus: 'sold_out',
							},
						],
						availabilityStatus: 'available',
						position: 0,
					},
				],
				money,
				counts: new Map([['dish', 2]]),
				onPick: pick,
			}),
		)
		const rows = [
			...host.querySelectorAll<HTMLButtonElement>('button[data-slot="item"]'),
		]
		expect(rows).toHaveLength(2)
		expect(rows[0]!.getAttribute('aria-label')).toBe(
			'House dish, $12.00, 2 in order',
		)
		expect(rows[1]!.disabled).toBe(true)
		expect(rows[0]!.querySelector('[data-slot="item-content"]')).not.toBeNull()
		expect(rows[0]!.querySelector('button')).toBeNull()
		act(() => rows[0]!.click())
		act(() => rows[1]!.click())
		expect(pick).toHaveBeenCalledExactlyOnceWith(item)
		expect(
			host.querySelector('input[type="search"]')!.getAttribute('data-slot'),
		).toBe('input')
	})
	it('preserves cart edit, quantity, remove, save and charge callbacks with unchanged totals', () => {
		const props: ComponentProps<typeof Cart> = {
			tabNumber: null,
			error: null,
			lines: [line],
			adjustments: [],
			taxRatePercent: 10,
			orderType: 'dine_in',
			customerName: '',
			orderSource: 'counter',
			customerPhone: '',
			pickupAt: null,
			pickupTimeZone: null,
			tableLabel: '4',
			money,
			onPhoneOrder: vi.fn(),
			onCounterOrder: vi.fn(),
			onOrderType: vi.fn(),
			onCustomer: vi.fn(),
			onTable: vi.fn(),
			onQuantity: vi.fn(),
			onEdit: vi.fn(),
			onRemove: vi.fn(),
			onClear: vi.fn(),
			onCharge: vi.fn(),
			onSaveTab: vi.fn(),
		}
		draw(h(Cart, props))
		expect(host.querySelector('[data-slot="item-content"]')).not.toBeNull()
		expect(host.textContent).toContain('No salt')
		expect(host.textContent).toContain('$26.40')
		const buttons = [...host.querySelectorAll('button')]
		const byName = (name: string) =>
			buttons.find((button) => button.getAttribute('aria-label') === name)!
		act(() => byName('Edit House dish').click())
		expect(props.onEdit).toHaveBeenCalledExactlyOnceWith(line)
		act(() => byName('More House dish').click())
		act(() => byName('Fewer House dish').click())
		expect(props.onQuantity).toHaveBeenNthCalledWith(1, 'line', 3)
		expect(props.onQuantity).toHaveBeenNthCalledWith(2, 'line', 1)
		act(() =>
			buttons.find((button) => button.textContent === 'Remove')!.click(),
		)
		expect(props.onRemove).toHaveBeenCalledExactlyOnceWith('line')
		act(() =>
			buttons.find((button) => button.textContent === 'Pay later')!.click(),
		)
		act(() =>
			buttons
				.find((button) => button.textContent?.startsWith('Charge'))!
				.click(),
		)
		expect(props.onSaveTab).toHaveBeenCalledTimes(1)
		expect(props.onCharge).toHaveBeenCalledTimes(1)
		expect(host.querySelector('button button')).toBeNull()
	})
	it('keeps empty-order copy and disables payment without decorative placeholders', () => {
		const nothing = vi.fn()
		draw(
			h(Cart, {
				tabNumber: null,
				error: null,
				lines: [],
				adjustments: [],
				taxRatePercent: 0,
				orderType: 'takeaway',
				customerName: '',
				orderSource: 'counter',
				customerPhone: '',
				pickupAt: null,
				pickupTimeZone: null,
				tableLabel: '',
				money,
				onPhoneOrder: nothing,
				onCounterOrder: nothing,
				onOrderType: nothing,
				onCustomer: nothing,
				onTable: nothing,
				onQuantity: nothing,
				onEdit: nothing,
				onRemove: nothing,
				onClear: nothing,
				onCharge: nothing,
				onSaveTab: nothing,
			}),
		)
		expect(host.querySelector('[data-slot="empty-title"]')!.textContent).toBe(
			'No items yet',
		)
		expect(host.querySelector('[data-slot="empty-icon"]')).toBeNull()
		const charge = [...host.querySelectorAll('button')].find((button) =>
			button.textContent?.startsWith('Charge'),
		)!
		expect(charge.disabled).toBe(true)
	})
	it('keeps restaurant and app identity, all four app choices and launcher focus restoration', () => {
		const app = vi.fn()
		draw(
			h(AppLauncher, {
				name: 'Restaurant',
				logoUrl: null,
				locationName: 'Main',
				app: 'reservations',
				apps: { timeclock: true, reservations: true },
				onApp: app,
			}),
		)
		const trigger = host.querySelector<HTMLButtonElement>(
			'[aria-label="Apps"]',
		)!
		expect(trigger.textContent).toContain('Restaurant')
		expect(trigger.textContent).toContain('Reservations')
		act(() => trigger.click())
		const nav = host.querySelector('nav')!
		const choices = [...nav.querySelectorAll('button')]
		expect(choices.map((button) => button.textContent)).toEqual([
			'Register',
			'Kitchen',
			'Time clock',
			'Reservations',
		])
		act(() => choices[1]!.click())
		expect(app).toHaveBeenCalledExactlyOnceWith('kitchen')
		expect(document.activeElement?.getAttribute('aria-label')).toBe('Apps')
	})
})
