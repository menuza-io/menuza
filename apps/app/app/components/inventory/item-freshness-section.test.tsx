// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type ItemDetail } from '@repo/inventory'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from './inventory-client-provider.tsx'
import {
	ItemFreshnessSection,
	shelfLifeParts,
	shelfLifeToHours,
} from './item-freshness-section.tsx'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

describe('shelf life', () => {
	it('shows whole days as days and anything else as hours', () => {
		expect(shelfLifeParts(72)).toEqual({ amount: '3', unit: 'days' })
		expect(shelfLifeParts(36)).toEqual({ amount: '36', unit: 'hours' })
		expect(shelfLifeParts(null)).toEqual({ amount: '', unit: 'days' })
	})

	it('reads what was typed, and refuses what the region would refuse', () => {
		expect(shelfLifeToHours('3', 'days')).toBe(72)
		expect(shelfLifeToHours('1,5', 'days')).toBe(36)
		expect(shelfLifeToHours('12', 'hours')).toBe(12)
		expect(shelfLifeToHours('0', 'days')).toBeNull()
		expect(shelfLifeToHours('abc', 'hours')).toBeNull()
		expect(shelfLifeToHours('99999', 'days')).toBeNull()
	})
})

const ITEM = {
	id: 'it1',
	version: 4,
	name: 'Garlic sauce',
	trackByDate: false,
	shelfLifeHours: 72,
	storageNote: null,
	nameAr: null,
} as unknown as ItemDetail

function renderSection(
	request: InventoryClient['request'],
	over: Partial<ItemDetail> = {},
	onChanged = vi.fn(),
) {
	render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<ItemFreshnessSection
					item={{ ...ITEM, ...over } as ItemDetail}
					locationId="main"
					canEdit
					onChanged={onChanged}
				/>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
	return onChanged
}

describe('ItemFreshnessSection', () => {
	it('saves the shelf life, storage note and Arabic name with the version it read', async () => {
		const request = vi.fn(
			async () => ({}),
		) as unknown as InventoryClient['request']
		const changed = renderSection(request)
		fireEvent.change(screen.getByTestId('item-shelf-life'), {
			target: { value: '2' },
		})
		fireEvent.change(screen.getByTestId('item-storage-note'), {
			target: { value: 'Keep at 4 C' },
		})
		fireEvent.change(screen.getByTestId('item-name-ar'), {
			target: { value: 'صلصة الثوم' },
		})
		fireEvent.click(screen.getByTestId('item-freshness-save'))
		await waitFor(() => expect(changed).toHaveBeenCalled())
		const call = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
		expect(call[0]).toBe('/items/it1')
		expect(JSON.parse((call[1] as { body: string }).body)).toEqual({
			expectedVersion: 4,
			shelfLifeHours: 48,
			storageNote: 'Keep at 4 C',
			nameAr: 'صلصة الثوم',
		})
	})

	it('turns tracking by date on in one tap', async () => {
		const request = vi.fn(
			async () => ({}),
		) as unknown as InventoryClient['request']
		renderSection(request)
		fireEvent.click(screen.getByTestId('item-track-by-date'))
		await waitFor(() => expect(request).toHaveBeenCalled())
		const call = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
		expect(JSON.parse((call[1] as { body: string }).body)).toEqual({
			expectedVersion: 4,
			trackByDate: true,
		})
	})

	it('will not save a shelf life the region would refuse', () => {
		const request = vi.fn() as unknown as InventoryClient['request']
		renderSection(request)
		fireEvent.change(screen.getByTestId('item-shelf-life'), {
			target: { value: 'soon' },
		})
		expect(screen.getByTestId('item-freshness-save')).toBeDisabled()
	})

	it('lists the stock by use-by date, oldest first, for a tracked item', async () => {
		const request = vi.fn(async (path: string) =>
			path.startsWith('/items/it1/lots')
				? {
						itemId: 'it1',
						locationId: 'main',
						date: '2026-11-27',
						trackByDate: true,
						baseUnit: 'g',
						countUnit: null,
						onHand: 5000,
						undated: 1000,
						lots: [
							{
								id: 'lot1',
								useByDate: '2026-11-25',
								remaining: 2000,
								daysLeft: -2,
								status: 'expired',
								source: 'delivery',
							},
							{
								id: 'lot2',
								useByDate: '2026-12-02',
								remaining: 2000,
								daysLeft: 5,
								status: 'ok',
								source: 'batch',
							},
						],
					}
				: {},
		) as unknown as InventoryClient['request']
		renderSection(request, { trackByDate: true })
		expect(await screen.findByTestId('item-lot-lot1')).toHaveTextContent(
			'Expired',
		)
		expect(screen.getByTestId('item-lot-lot2')).toBeInTheDocument()
		expect(screen.getByTestId('item-lots')).toHaveTextContent(
			'No date (used first)',
		)
		expect(screen.getByTestId('item-confirm-dates')).toBeInTheDocument()
	})
})
