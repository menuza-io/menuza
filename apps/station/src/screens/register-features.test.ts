// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CustomItemSheet } from './CustomItemSheet.tsx'
import { ItemSheet } from './ItemSheet.tsx'

import { type MenuItem } from '~/lib/types.ts'
;(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
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

function draw(node: ReactNode) {
	// eslint-disable-next-line testing-library/no-unnecessary-act
	act(() => root.render(h(I18nProvider, { i18n }, node)))
}

function setFieldValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		'value',
	)!.set!
	setter.call(input, value)
	input.dispatchEvent(new Event('input', { bubbles: true }))
}

const sampleItem: MenuItem = {
	id: 'dish-1',
	displayName: 'Shawarma Plate',
	description: null,
	price: 25,
	imageUrl: null,
	variations: { groups: [], variants: [] },
	isVegetarian: false,
	isGlutenFree: false,
	isAlcohol: false,
	allergens: [],
	isPopular: false,
	availabilityStatus: 'available',
	position: 0,
	modifierGroups: [],
}

describe('dish notes toggle (#372)', () => {
	it('shows the kitchen note field by default and hides it when showNotes is false', () => {
		draw(
			h(ItemSheet, {
				item: sampleItem,
				money: (c) => `$${(c / 100).toFixed(2)}`,
				onClose: vi.fn(),
				onSubmit: vi.fn(),
			}),
		)
		expect(
			host.querySelector('textarea[aria-label="Kitchen note"]'),
		).not.toBeNull()

		draw(
			h(ItemSheet, {
				item: sampleItem,
				showNotes: false,
				money: (c) => `$${(c / 100).toFixed(2)}`,
				onClose: vi.fn(),
				onSubmit: vi.fn(),
			}),
		)
		expect(host.querySelector('textarea[aria-label="Kitchen note"]')).toBeNull()
	})
})

describe('CustomItemSheet (#171)', () => {
	it('adds an untaxed custom item routed to a chosen kitchen station', async () => {
		const onSubmit = vi.fn()
		draw(
			h(CustomItemSheet, {
				open: true,
				maxCents: 50_000,
				money: (c) => `$${(c / 100).toFixed(2)}`,
				kdsStations: [
					{ id: 'grill', name: 'Grill' },
					{ id: 'bar', name: 'Bar' },
				],
				needsManagerPin: false,
				onApprove: vi.fn(async () => ({
					ok: true as const,
					manager: { id: 'm1', name: 'M.' },
				})),
				onClose: vi.fn(),
				onSubmit,
			}),
		)

		const nameInput = host.querySelector<HTMLInputElement>('#custom-item-name')!
		const priceInput =
			host.querySelector<HTMLInputElement>('#custom-item-price')!
		const stationSelect = host.querySelector<HTMLSelectElement>(
			'#custom-item-station',
		)!
		const radios = [...host.querySelectorAll<HTMLElement>('[role="radio"]')]
		const noTax = radios.find((r) => r.textContent === 'None')!

		act(() => {
			setFieldValue(nameInput, 'Corkage fee')
			setFieldValue(priceInput, '15.00')
			noTax.click()
			stationSelect.value = 'bar'
			stationSelect.dispatchEvent(new Event('change', { bubbles: true }))
		})

		const form = host.querySelector<HTMLFormElement>('#custom-item-form')!
		await act(async () => {
			form.dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true }),
			)
		})

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'custom',
				name: 'Corkage fee',
				variantId: null,
				baseCents: 1500,
				taxable: false,
				kitchenStationId: 'bar',
				options: [],
			}),
		)
	})

	it('requires a manager PIN when configured for managers only and rejects prices over limit', async () => {
		const onSubmit = vi.fn()
		const onApprove = vi.fn(async (pin: string) =>
			pin === '2468'
				? { ok: true as const, manager: { id: 'm1', name: 'Mgr M.' } }
				: { ok: false as const, message: 'Wrong PIN' },
		)
		draw(
			h(CustomItemSheet, {
				open: true,
				maxCents: 2000,
				money: (c) => `$${(c / 100).toFixed(2)}`,
				kdsStations: [],
				needsManagerPin: true,
				onApprove,
				onClose: vi.fn(),
				onSubmit,
			}),
		)

		const nameInput = host.querySelector<HTMLInputElement>('#custom-item-name')!
		const priceInput =
			host.querySelector<HTMLInputElement>('#custom-item-price')!
		const pinInput = host.querySelector<HTMLInputElement>('#custom-item-pin')!
		const form = host.querySelector<HTMLFormElement>('#custom-item-form')!

		// Over limit is refused before calling onApprove.
		act(() => {
			setFieldValue(nameInput, 'Expensive')
			setFieldValue(priceInput, '25.00')
			setFieldValue(pinInput, '2468')
		})
		await act(async () => {
			form.dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true }),
			)
		})
		expect(onApprove).not.toHaveBeenCalled()
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			'$20.00',
		)

		// Valid price with manager PIN succeeds.
		act(() => {
			setFieldValue(priceInput, '12.50')
			setFieldValue(pinInput, '2468')
		})
		await act(async () => {
			form.dispatchEvent(
				new Event('submit', { bubbles: true, cancelable: true }),
			)
		})
		expect(onApprove).toHaveBeenCalledWith('2468')
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'custom',
				name: 'Expensive',
				baseCents: 1250,
				taxable: true,
				kitchenStationId: null,
			}),
		)
	})
})
