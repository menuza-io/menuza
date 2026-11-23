// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type RepeatOrderSummary } from '@repo/inventory'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RepeatOrderDialog } from './repeat-order-dialog.tsx'
import { RepeatOrdersPanel } from './repeat-orders-panel.tsx'

const mockRequest = vi.fn()

vi.mock('#app/hooks/use-inventory-client.ts', () => ({
	useInventoryClient: () => ({
		request: mockRequest,
	}),
}))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

beforeEach(() => {
	mockRequest.mockReset()
})

const sampleRepeat: RepeatOrderSummary = {
	id: 'rep_1',
	locationId: 'loc_1',
	supplierId: 'sup_1',
	supplierName: 'Fresh Farm',
	supplierPaused: false,
	supplierArchived: false,
	sourceOrderId: 'ord_1',
	cadenceWeeks: 1,
	weekdays: [1, 4],
	mode: 'fixed_lines',
	anchorDate: '2026-11-23',
	linesCount: 2,
	note: 'Morning produce',
	status: 'active',
	effectiveStatus: 'active',
	version: 1,
	upcomingRuns: [
		{
			deliveryDate: '2026-11-26',
			cutoffDate: '2026-11-25',
			cutoffTime: '16:00',
			status: 'scheduled',
			orderId: null,
			note: null,
		},
		{
			deliveryDate: '2026-11-30',
			cutoffDate: '2026-11-29',
			cutoffTime: '16:00',
			status: 'skipped_holiday',
			orderId: null,
			note: 'Skipped: closed for holiday (National Day)',
		},
	],
}

describe('RepeatOrdersPanel & RepeatOrderDialog (#499)', () => {
	it('renders repeat orders, holiday skip notes, and handles skip & pause actions', async () => {
		const onReload = vi.fn()
		mockRequest.mockResolvedValue({
			...sampleRepeat,
			version: 2,
			status: 'paused',
			effectiveStatus: 'paused',
		})

		render(
			<I18nProvider i18n={i18n}>
				<MemoryRouter>
					<RepeatOrdersPanel
						repeatOrders={[sampleRepeat]}
						canManagePurchasing={true}
						orderHrefPrefix="/demo/inventory/purchasing/orders"
						onReload={onReload}
					/>
				</MemoryRouter>
			</I18nProvider>,
		)

		expect(screen.getByText('Fresh Farm')).toBeTruthy()
		expect(
			screen.getByText(/Skipped: closed for holiday \(National Day\)/),
		).toBeTruthy()

		fireEvent.click(screen.getByTestId('repeat-pause-rep_1'))
		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith(
				'/repeat-orders/rep_1',
				expect.objectContaining({ method: 'PATCH' }),
			)
		})
		expect(onReload).toHaveBeenCalledTimes(1)

		fireEvent.click(screen.getByTestId('repeat-skip-rep_1-2026-11-26'))
		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith(
				'/repeat-orders/rep_1/skip',
				expect.objectContaining({ method: 'POST' }),
			)
		})
		expect(onReload).toHaveBeenCalledTimes(2)
	})

	it('creates a repeat order schedule from RepeatOrderDialog', async () => {
		const onCreated = vi.fn()
		const onOpenChange = vi.fn()
		mockRequest.mockResolvedValue(sampleRepeat)

		render(
			<I18nProvider i18n={i18n}>
				<MemoryRouter>
					<RepeatOrderDialog
						order={{
							id: 'ord_1',
							locationId: 'loc_1',
							supplierId: 'sup_1',
							lines: [
								{
									itemId: 'item_1',
									supplierProductId: 'prod_1',
									packs: 2,
								},
							],
						}}
						supplier={{
							id: 'sup_1',
							name: 'Fresh Farm',
							deliveryDays: [1, 4],
						}}
						open={true}
						onOpenChange={onOpenChange}
						onCreated={onCreated}
					/>
				</MemoryRouter>
			</I18nProvider>,
		)

		fireEvent.click(screen.getByTestId('repeat-cadence-2'))
		fireEvent.click(screen.getByTestId('repeat-mode-top-up'))
		fireEvent.click(screen.getByTestId('repeat-order-submit'))

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith(
				'/repeat-orders',
				expect.objectContaining({ method: 'POST' }),
			)
		})
		expect(onCreated).toHaveBeenCalledTimes(1)
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})
})
