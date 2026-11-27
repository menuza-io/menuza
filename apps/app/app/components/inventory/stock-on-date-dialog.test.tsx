// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from './inventory-client-provider.tsx'
import { previousMonthEnd, StockOnDateDialog } from './stock-on-date-dialog.tsx'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('previousMonthEnd', () => {
	it('is the last day of the month before', () => {
		expect(previousMonthEnd('2026-11-27')).toBe('2026-10-31')
		expect(previousMonthEnd('2026-03-05')).toBe('2026-02-28')
		expect(previousMonthEnd('2028-03-05')).toBe('2028-02-29')
		expect(previousMonthEnd('2026-01-10')).toBe('2025-12-31')
	})
})

const ON_DATE = {
	locationId: 'main',
	date: '2026-10-31',
	today: '2026-11-27',
	open: false,
	items: [
		{
			itemId: 'it1',
			name: 'Tomatoes',
			category: 'Produce',
			baseUnit: 'g' as const,
			countUnit: null,
			onHand: 12_000,
			valueMinor: 4800,
		},
	],
	totalValueMinor: 4800,
	currency: 'SAR',
	unpricedItems: 0,
}

function renderDialog(
	request: InventoryClient['request'],
	canSeeCost: boolean,
) {
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<StockOnDateDialog
					open
					onOpenChange={() => undefined}
					locationId="main"
					canSeeCost={canSeeCost}
					currency="SAR"
				/>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('StockOnDateDialog', () => {
	it('starts at the last month end and shows stock and its value on that date', async () => {
		const request = vi.fn(
			async () => ON_DATE,
		) as unknown as InventoryClient['request']
		renderDialog(request, true)
		expect(await screen.findByTestId('stock-date-item-it1')).toHaveTextContent(
			'Tomatoes',
		)
		const first = (request as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as string
		expect(first).toMatch(/^\/stock\/on-date\?/)
		expect(first).toContain('locationId=main')
		expect(screen.getByTestId('stock-date-total')).toBeInTheDocument()
		expect(screen.getByTestId('stock-value-export')).toBeInTheDocument()
	})

	it('shows no value and no export to someone without the cost grant', async () => {
		const noValue = { ...ON_DATE, totalValueMinor: undefined }
		noValue.items = [{ ...ON_DATE.items[0]!, valueMinor: undefined as never }]
		const request = vi.fn(
			async () => noValue,
		) as unknown as InventoryClient['request']
		renderDialog(request, false)
		await screen.findByTestId('stock-date-item-it1')
		expect(screen.queryByTestId('stock-date-total')).toBeNull()
		expect(screen.queryByTestId('stock-value-export')).toBeNull()
	})

	it('asks the region for the chosen day when the date changes, never the browser clock', async () => {
		const request = vi.fn(
			async () => ON_DATE,
		) as unknown as InventoryClient['request']
		renderDialog(request, true)
		const input = await screen.findByTestId('stock-date-input')
		fireEvent.change(input, { target: { value: '2026-09-30' } })
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith(
				expect.stringContaining('date=2026-09-30'),
			),
		)
	})
})
