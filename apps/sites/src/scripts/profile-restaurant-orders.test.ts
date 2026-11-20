/** @vitest-environment jsdom */
import { type CustomerOrderListItem } from '@repo/common/customer-orders'
import { describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/client-auth', () => ({
	tenantFetch: vi.fn(),
	redirectToLogin: vi.fn(),
}))

import {
	renderOrderRow,
	summaryOf,
	type RestaurantOrdersLabels,
} from './profile-restaurant-orders'

const labels: RestaurantOrdersLabels = {
	empty: 'No restaurant orders yet.',
	emptyHint: '',
	orderAgain: 'Order again',
	finish: 'Finish this order',
	details: 'Details',
	hideDetails: 'Hide details',
	loadMore: 'Load more',
	loadError: 'error',
	retry: 'retry',
	items: 'Items',
	subtotal: 'Subtotal',
	total: 'Total',
	tax: 'Tax',
	number: 'Order',
	statuses: { completed: 'Completed', expired: 'Expired' },
}

const order = (
	overrides: Partial<CustomerOrderListItem> = {},
): CustomerOrderListItem => ({
	id: 'ord_1',
	number: 'A12',
	status: 'completed',
	paymentStatus: 'paid',
	paymentMethod: 'online',
	fulfillment: 'pickup',
	currency: 'USD',
	totalCents: 2450,
	createdAt: '2026-01-02T10:00:00.000Z',
	location: { id: 'loc_1', name: 'Downtown' },
	itemCount: 4,
	itemNames: ['Margherita', 'Cola'],
	isDrop: false,
	canReorder: true,
	canFinish: false,
	...overrides,
})

const render = (
	o: CustomerOrderListItem,
	loadDetail = vi.fn(async () => null),
) =>
	renderOrderRow(o, {
		labels,
		locale: 'en',
		defaultLocale: 'en',
		localePrefix: '',
		loadDetail,
	})

describe('a restaurant order row (#112)', () => {
	it('shows number, status, location, items summary and total', () => {
		const row = render(order())
		expect(row.textContent).toContain('Order A12')
		expect(row.textContent).toContain('Completed')
		expect(row.textContent).toContain('Downtown')
		expect(row.textContent).toContain('Margherita, Cola +2')
		expect(row.textContent).toContain('$24.50')
	})

	it('"Order again" opens the menu with the order id in the fragment only', () => {
		const link =
			render(order()).querySelector<HTMLAnchorElement>('a[data-reorder]')!
		expect(link.textContent).toBe('Order again')
		expect(link.getAttribute('href')).toBe('/menu#reorder=ord_1')
	})

	it('offers "Finish this order" for a lapsed unpaid online order', () => {
		const link = render(
			order({ status: 'expired', canFinish: true }),
		).querySelector<HTMLAnchorElement>('a[data-reorder]')!
		expect(link.textContent).toBe('Finish this order')
		expect(link.dataset.reorder).toBe('finish')
	})

	it('offers no reorder for a drop', () => {
		const row = render(order({ isDrop: true, canReorder: false }))
		expect(row.querySelector('a[data-reorder]')).toBeNull()
	})

	it('loads the detail once and toggles it', async () => {
		const loadDetail = vi.fn(async () => ({
			subtotalCents: 2000,
			taxCents: 450,
			totalCents: 2450,
			currency: 'USD',
			lines: [
				{
					itemName: 'Margherita',
					quantity: 2,
					totalCents: 2000,
					options: [{ optionName: 'Olives', quantity: 1 }],
				},
			],
		}))
		const row = render(order(), loadDetail as never)
		const toggle = row.querySelector<HTMLButtonElement>('button')!
		toggle.click()
		await vi.waitFor(() =>
			expect(row.textContent).toContain('2× Margherita (Olives)'),
		)
		expect(row.textContent).toContain('Tax')
		toggle.click()
		expect(toggle.textContent).toBe('Details')
		toggle.click()
		expect(loadDetail).toHaveBeenCalledTimes(1)
	})

	it('summarizes without the extra count when every dish is named', () => {
		expect(summaryOf(order({ itemCount: 2 }), 'en', 'en')).toBe(
			'Margherita, Cola',
		)
	})
})
