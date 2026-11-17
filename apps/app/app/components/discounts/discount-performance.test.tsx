// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderStaff } from '#tests/staff-render.tsx'
import {
	DiscountPerformance,
	defaultPerformancePeriod,
} from './discount-performance.tsx'

const fetchPerformance = vi.hoisted(() => vi.fn())

vi.mock('#app/utils/discounts/usage-client.ts', () => ({
	createDiscountUsageClient: () => ({ fetchPerformance }),
}))

const DISCOUNTS = [
	{ id: 'd_auto', name: 'Happy hour', application: 'automatic' },
	{ id: 'd_few', name: 'Lunch deal', application: 'code' },
	{ id: 'd_till', name: 'Staff meal', application: 'manual' },
	{ id: 'd_none', name: 'Unused', application: 'automatic' },
]

const RESPONSE = {
	basis: 'net' as const,
	entries: [
		{
			discountId: 'd_auto',
			orders: 10,
			salesMinor: 18_000,
			discountMinor: 2000,
		},
		{ discountId: 'd_few', orders: 9, salesMinor: 9000, discountMinor: 900 },
		{ discountId: 'd_till', orders: 12, salesMinor: 6000, discountMinor: 1200 },
		{ discountId: 'd_none', orders: 0, salesMinor: 0, discountMinor: 0 },
	],
	ordersTotal: 80,
	ordersWithDiscount: 31,
}

function panel() {
	return (
		<DiscountPerformance
			orgSlug="acme"
			currency="USD"
			locale="en"
			discounts={DISCOUNTS}
			from="2026-11-01"
			to="2026-11-30"
			timeZone="America/New_York"
		/>
	)
}

beforeEach(() => {
	fetchPerformance.mockReset().mockResolvedValue(RESPONSE)
})

describe('DiscountPerformance (#390)', () => {
	it('shows orders, sales, what was given and the return, matching the orders', async () => {
		renderStaff(panel())
		const row = (
			await screen.findByRole('link', { name: 'Happy hour' })
		).closest('tr')!
		const cells = within(row).getAllByRole('cell')
		expect(cells.map((cell) => cell.textContent)).toEqual([
			'Happy hour',
			'10',
			'$180.00',
			'$20.00',
			// 180.00 sold for 20.00 given: 9.00 for each 1.00.
			'$9.00',
		])
		expect(fetchPerformance).toHaveBeenCalledWith(
			{
				ids: ['d_auto', 'd_few', 'd_till', 'd_none'],
				from: '2026-11-01',
				to: '2026-11-30',
				tz: 'America/New_York',
				basis: 'net',
			},
			expect.any(AbortSignal),
		)
	})

	it('says not enough data under ten orders but still shows the figures', async () => {
		renderStaff(panel())
		const row = (
			await screen.findByRole('link', { name: 'Lunch deal' })
		).closest('tr')!
		expect(within(row).getByText('9')).toBeInTheDocument()
		expect(within(row).getByText('$90.00')).toBeInTheDocument()
		expect(within(row).getByText('Not enough data')).toBeInTheDocument()
	})

	it('shows till discounts in their own table, and leaves out discounts nobody used', async () => {
		renderStaff(panel())
		await screen.findByRole('link', { name: 'Happy hour' })
		const tables = screen.getAllByRole('table')
		expect(tables).toHaveLength(2)
		expect(within(tables[0]!).getByText('Happy hour')).toBeInTheDocument()
		expect(within(tables[0]!).queryByText('Staff meal')).toBeNull()
		expect(within(tables[1]!).getByText('Staff meal')).toBeInTheDocument()
		expect(screen.queryByText('Unused')).toBeNull()
	})

	it('says how many orders used a discount', async () => {
		renderStaff(panel())
		const share = await screen.findByTestId('discount-share')
		expect(share).toHaveTextContent(
			'39% of orders used a discount (31 of 80), till discounts included.',
		)
	})

	it('asks again for gross sales', async () => {
		renderStaff(panel())
		await screen.findByRole('link', { name: 'Happy hour' })
		fetchPerformance.mockResolvedValue({ ...RESPONSE, basis: 'gross' })
		await userEvent.selectOptions(
			screen.getByLabelText('Sales are counted'),
			'gross',
		)
		await waitFor(() =>
			expect(fetchPerformance).toHaveBeenLastCalledWith(
				expect.objectContaining({ basis: 'gross' }),
				expect.any(AbortSignal),
			),
		)
	})

	it('says so when the region cannot be reached', async () => {
		fetchPerformance.mockResolvedValue(null)
		renderStaff(panel())
		expect(
			await screen.findByText(/Performance figures are unavailable/),
		).toBeInTheDocument()
	})

	it('says so when no discount was used', async () => {
		fetchPerformance.mockResolvedValue({
			basis: 'net',
			entries: [],
			ordersTotal: 0,
			ordersWithDiscount: 0,
		})
		renderStaff(panel())
		expect(
			await screen.findByText(/No discount was used on a completed order/),
		).toBeInTheDocument()
	})

	it('defaults to the last 30 days', () => {
		expect(defaultPerformancePeriod('2026-11-30')).toEqual({
			from: '2026-11-01',
			to: '2026-11-30',
		})
	})
})
