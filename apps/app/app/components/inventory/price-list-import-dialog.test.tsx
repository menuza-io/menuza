// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { PriceListImportDialog } from '#app/components/inventory/price-list-import-dialog.tsx'
import { sentJson } from '#tests/inventory-render.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
})

function makeCsvFile(
	name = 'prices.csv',
	content = 'Name,Pack,Price\nTomato,Box 5kg,40',
) {
	const file = new File([content], name, { type: 'text/csv' })
	if (!file.arrayBuffer) {
		Object.defineProperty(file, 'arrayBuffer', {
			value: async () => new TextEncoder().encode(content).buffer,
		})
	}
	return file
}

describe('PriceListImportDialog (#505)', () => {
	it('parses a price list, lets you edit/skip/accept-all, and saves nothing until Apply', async () => {
		const onImported = vi.fn()
		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path === '/suppliers/s1/price-list/parse') {
				return {
					supplierId: 's1',
					fileName: 'prices.csv',
					fileKind: 'csv',
					currency: 'SAR',
					truncated: false,
					totalParsed: 2,
					readerConfigured: true,
					lines: [
						{
							lineKey: 'l1',
							rawText: 'Tomatoes · Box 5kg · 45.00',
							sku: 'TOM-5',
							name: 'Tomatoes',
							packName: 'Box',
							packBaseQuantity: 5_000_000,
							baseUnit: 'g',
							category: 'produce',
							priceMinor: 4500,
							pricedByWeight: false,
							matchKind: 'matched_item',
							existingProductId: null,
							matchedItemId: 'itm_1',
							matchedItemName: 'Tomatoes',
							changeKind: 'new',
							previousPriceMinor: null,
							warnings: [],
						},
						{
							lineKey: 'l2',
							rawText: 'Onions · Bag 10kg · 30.00',
							sku: null,
							name: 'Onions',
							packName: 'Bag',
							packBaseQuantity: 10_000_000,
							baseUnit: 'g',
							category: 'produce',
							priceMinor: 3000,
							pricedByWeight: false,
							matchKind: 'new_item',
							existingProductId: null,
							matchedItemId: null,
							matchedItemName: null,
							changeKind: 'new',
							previousPriceMinor: null,
							warnings: [],
						},
					],
					goneProducts: [],
				}
			}
			if (path === '/suppliers/s1/price-list/apply') {
				return {
					createdItems: 1,
					createdProducts: 2,
					updatedProducts: 0,
					archivedProducts: 0,
					recordedPrices: 2,
				}
			}
			throw new Error(`unexpected ${path}`)
		})

		render(
			<I18nProvider i18n={i18n}>
				<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
					<InventoryChangeProvider>
						<PriceListImportDialog
							open
							onOpenChange={vi.fn()}
							supplierId="s1"
							supplierName="Fresh Farms"
							currency="SAR"
							locationId="main"
							onImported={onImported}
						/>
					</InventoryChangeProvider>
				</InventoryClientContext.Provider>
			</I18nProvider>,
		)

		const input = screen.getByTestId(
			'price-list-file-input',
		) as HTMLInputElement
		await userEvent.upload(input, makeCsvFile())

		expect(
			await screen.findByTestId('price-list-review-lines'),
		).toBeInTheDocument()
		expect(request).toHaveBeenCalledTimes(1)

		// Edit price on line 1
		const priceInput = screen.getByTestId('price-list-line-price-l1')
		await userEvent.clear(priceInput)
		await userEvent.type(priceInput, '48.00')

		// Uncheck line 2, then toggle Accept all
		await userEvent.click(screen.getByTestId('price-list-line-accept-l2'))
		expect(screen.getByTestId('price-list-apply')).toHaveTextContent(
			'Apply 1 line',
		)
		await userEvent.click(screen.getByTestId('price-list-accept-all'))
		expect(screen.getByTestId('price-list-apply')).toHaveTextContent(
			'Apply 2 lines',
		)

		await userEvent.click(screen.getByTestId('price-list-apply'))
		await waitFor(() => expect(onImported).toHaveBeenCalled())
		const applyIdx = request.mock.calls.findIndex(
			([p]) => p === '/suppliers/s1/price-list/apply',
		)
		expect(applyIdx).toBeGreaterThan(0)
		const payload = sentJson(request, applyIdx) as {
			lines: Array<{ priceMinor: number; action: string }>
		}
		expect(payload.lines[0]?.priceMinor).toBe(4800)
		expect(payload.lines[1]?.action).toBe('upsert')
	})

	it('collapses unchanged lines by default on re-import and lets you archive gone products', async () => {
		const onImported = vi.fn()
		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path === '/suppliers/s1/price-list/parse') {
				return {
					supplierId: 's1',
					fileName: 'prices.xlsx',
					fileKind: 'xlsx',
					currency: 'SAR',
					truncated: false,
					totalParsed: 2,
					readerConfigured: true,
					lines: [
						{
							lineKey: 'l_changed',
							rawText: 'Chicken · Box 10kg · 120.00',
							sku: 'CHK-10',
							name: 'Chicken',
							packName: 'Box',
							packBaseQuantity: 10_000_000,
							baseUnit: 'g',
							category: 'meat',
							priceMinor: 12000,
							pricedByWeight: false,
							matchKind: 'matched_product',
							existingProductId: 'sp1',
							matchedItemId: 'itm_chk',
							matchedItemName: 'Chicken',
							changeKind: 'price_changed',
							previousPriceMinor: 10000,
							warnings: [],
						},
						{
							lineKey: 'l_same',
							rawText: 'Salt · Bag 1kg · 5.00',
							sku: 'SLT-1',
							name: 'Salt',
							packName: 'Bag',
							packBaseQuantity: 1_000_000,
							baseUnit: 'g',
							category: 'dry_goods',
							priceMinor: 500,
							pricedByWeight: false,
							matchKind: 'matched_product',
							existingProductId: 'sp2',
							matchedItemId: 'itm_slt',
							matchedItemName: 'Salt',
							changeKind: 'unchanged',
							previousPriceMinor: 500,
							warnings: [],
						},
					],
					goneProducts: [
						{
							productId: 'sp_old',
							itemId: 'itm_old',
							itemName: 'Old Spice',
							packName: 'Jar',
							sku: null,
							priceMinor: 1500,
						},
					],
				}
			}
			if (path === '/suppliers/s1/price-list/apply') {
				return {
					createdItems: 0,
					createdProducts: 0,
					updatedProducts: 2,
					archivedProducts: 1,
					recordedPrices: 2,
				}
			}
			throw new Error(`unexpected ${path}`)
		})

		render(
			<I18nProvider i18n={i18n}>
				<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
					<InventoryChangeProvider>
						<PriceListImportDialog
							open
							onOpenChange={vi.fn()}
							supplierId="s1"
							supplierName="Fresh Farms"
							currency="SAR"
							locationId="main"
							onImported={onImported}
						/>
					</InventoryChangeProvider>
				</InventoryClientContext.Provider>
			</I18nProvider>,
		)

		await userEvent.upload(
			screen.getByTestId('price-list-file-input'),
			makeCsvFile('prices.xlsx', 'xlsx'),
		)

		expect(
			await screen.findByTestId('price-list-line-l_changed'),
		).toBeInTheDocument()
		// Unchanged line is collapsed by default
		expect(screen.queryByTestId('price-list-line-l_same')).toBeNull()
		expect(screen.getByTestId('price-list-toggle-unchanged')).toHaveTextContent(
			'1 unchanged line',
		)
		// Gone product can be ticked to archive
		await userEvent.click(screen.getByTestId('price-list-gone-sp_old'))
		await userEvent.click(screen.getByTestId('price-list-apply'))
		await waitFor(() => expect(onImported).toHaveBeenCalled())
		const applyIdx = request.mock.calls.findIndex(
			([p]) => p === '/suppliers/s1/price-list/apply',
		)
		expect(sentJson(request, applyIdx)).toMatchObject({
			archiveGoneProductIds: ['sp_old'],
		})
	})
})
