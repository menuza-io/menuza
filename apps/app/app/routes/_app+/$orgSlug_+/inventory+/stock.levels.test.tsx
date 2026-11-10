// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { type StockOutletContext } from '#app/components/inventory/stock-context.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { sentJson } from '#tests/inventory-render.tsx'
import InventoryLevelsRoute from './stock.levels.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const close = vi.fn()
const reload = vi.fn()

beforeEach(() => {
	vi.clearAllMocks()
})

const CONTEXT: StockOutletContext = {
	orgSlug: 'acme',
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, stock: true },
	locations: [{ id: 'main', name: 'Acme' }],
	activeLocationId: 'main',
	canSeeCost: false,
	canEdit: true,
	canManagePurchasing: true,
	purchasingEnabled: true,
	transfersEnabled: false,
	transferPlaces: [],
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
	basePath: '/acme/inventory/stock',
	search: '',
	areas: [],
	reload,
	close,
}

function row(id: string, overrides: Record<string, unknown> = {}) {
	return {
		itemId: id,
		name: id === 'i1' ? 'Chicken thighs' : 'Garlic sauce',
		category: 'meat',
		baseUnit: 'g',
		countUnit: 'kg',
		units: [],
		onHand: 6_000_000,
		orderBelowQuantity: id === 'i1' ? 8_000_000 : null,
		fillUpToQuantity: id === 'i1' ? 30_000_000 : null,
		placeVersion: id === 'i1' ? 3 : 0,
		status: 'ok',
		supplierId: 's1',
		supplierName: 'Al Watania',
		packName: 'Box',
		packBaseQuantity: 10_000_000,
		...overrides,
	}
}

function region(
	options: {
		levels?: unknown[]
		put?: () => unknown
		suggestions?: Record<string, unknown>
	} = {},
) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.startsWith('/levels/suggestions')) {
			return {
				locationId: 'main',
				days: 28,
				daysObserved: 28,
				suggestions: [
					{
						itemId: 'i2',
						usedQuantity: 44_000_000,
						weeklyUseQuantity: 11_000_000,
						orderBelowQuantity: 5_000_000,
						fillUpToQuantity: 11_000_000,
					},
				],
				...options.suggestions,
			}
		}
		if (path.startsWith('/levels?')) {
			const levels = options.levels ?? [row('i1'), row('i2')]
			return { levels, total: levels.length, nextCursor: null }
		}
		if (path === '/levels/bulk' && init?.method === 'PUT') {
			return (
				options.put?.() ?? {
					updated: [
						{
							itemId: 'i1',
							version: 4,
							orderBelowQuantity: 8_000_000,
							fillUpToQuantity: 40_000_000,
						},
					],
					refused: [],
				}
			)
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function renderLevels(request: InventoryClient['request']) {
	const router = createMemoryRouter(
		[
			{
				path: '*',
				element: (
					<Sheet open>
						<SheetContent>
							<Outlet context={CONTEXT} />
						</SheetContent>
					</Sheet>
				),
				children: [{ path: '*', element: <InventoryLevelsRoute /> }],
			},
		],
		{ initialEntries: ['/'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<InventoryChangeProvider>
					<RouterProvider router={router} />
				</InventoryChangeProvider>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('Levels sheet', () => {
	it('shows each item with its two levels in the unit it is counted in', async () => {
		renderLevels(region())
		const first = await screen.findByTestId('level-row-i1')
		expect(first).toHaveTextContent('Chicken thighs')
		expect(screen.getByTestId('level-below-i1')).toHaveValue('8')
		expect(screen.getByTestId('level-fill-i1')).toHaveValue('30')
		expect(screen.getByTestId('level-below-i2')).toHaveValue('')
		expect(within(first).getAllByText('kg')).toHaveLength(2)
		expect(screen.getByTestId('levels-save')).toBeDisabled()
	})

	it('saves only the rows that changed, with the place version it read', async () => {
		const request = region()
		renderLevels(request)
		const fill = await screen.findByTestId('level-fill-i1')
		await userEvent.clear(fill)
		await userEvent.type(fill, '40')
		expect(screen.getByTestId('levels-save')).toHaveTextContent('Save 1 change')
		await userEvent.click(screen.getByTestId('levels-save'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Levels saved for 1 item'),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/levels/bulk',
		)
		expect(sentJson(request, index)).toMatchObject({
			locationId: 'main',
			levels: [
				{
					itemId: 'i1',
					orderBelowQuantity: 8_000_000,
					fillUpToQuantity: 40_000_000,
					expectedVersion: 3,
				},
			],
		})
		expect(reload).toHaveBeenCalled()
		expect(close).toHaveBeenCalled()
	})

	it('creates a place row for an item that has none (version 0)', async () => {
		const request = region()
		renderLevels(request)
		await userEvent.type(await screen.findByTestId('level-below-i2'), '3')
		await userEvent.type(screen.getByTestId('level-fill-i2'), '10')
		await userEvent.click(screen.getByTestId('levels-save'))
		await waitFor(() =>
			expect(request.mock.calls.some(([path]) => path === '/levels/bulk')).toBe(
				true,
			),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/levels/bulk',
		)
		expect(sentJson(request, index)).toMatchObject({
			levels: [
				{
					itemId: 'i2',
					orderBelowQuantity: 3_000_000,
					fillUpToQuantity: 10_000_000,
					expectedVersion: 0,
				},
			],
		})
	})

	it('names a row that is wrong and sends nothing', async () => {
		const request = region()
		renderLevels(request)
		const below = await screen.findByTestId('level-below-i1')
		await userEvent.clear(below)
		await userEvent.type(below, '50')
		await userEvent.click(screen.getByTestId('levels-save'))
		expect(await screen.findByTestId('levels-problems')).toBeInTheDocument()
		expect(screen.getByTestId('level-row-i1')).toHaveTextContent(
			'cannot be more than',
		)
		expect(request.mock.calls.some(([path]) => path === '/levels/bulk')).toBe(
			false,
		)
	})

	it('fills a row from "suggest from use", and saves only when asked', async () => {
		const request = region()
		renderLevels(request)
		await userEvent.click(await screen.findByTestId('levels-suggest'))
		const hint = await screen.findByTestId('level-suggestion-i2')
		expect(hint).toHaveTextContent('You use about 11 kg a week.')
		expect(screen.queryByTestId('levels-history-note')).toBeNull()
		await userEvent.click(screen.getByTestId('level-use-i2'))
		expect(screen.getByTestId('level-below-i2')).toHaveValue('5')
		expect(screen.getByTestId('level-fill-i2')).toHaveValue('11')
		expect(request.mock.calls.some(([path]) => path === '/levels/bulk')).toBe(
			false,
		)
		expect(screen.getByTestId('levels-save')).toHaveTextContent('Save 1 change')
	})

	it('says when there is not enough history to suggest from', async () => {
		renderLevels(region({ suggestions: { daysObserved: 6 } }))
		await userEvent.click(await screen.findByTestId('levels-suggest'))
		expect(await screen.findByTestId('levels-history-note')).toHaveTextContent(
			'Not enough history yet',
		)
	})

	it('reports rows someone else changed first, and keeps the sheet open', async () => {
		renderLevels(
			region({
				put: () => ({
					updated: [],
					refused: [{ itemId: 'i1', code: 'stale_version' }],
				}),
			}),
		)
		const fill = await screen.findByTestId('level-fill-i1')
		await userEvent.clear(fill)
		await userEvent.type(fill, '40')
		await userEvent.click(screen.getByTestId('levels-save'))
		expect(await screen.findByTestId('levels-refused')).toHaveTextContent(
			'1 item was changed by someone else',
		)
		expect(close).not.toHaveBeenCalled()
	})

	it('shows the error and keeps what was typed when the save fails', async () => {
		renderLevels(
			region({
				put: () => {
					throw new Error('offline')
				},
			}),
		)
		const fill = await screen.findByTestId('level-fill-i1')
		await userEvent.clear(fill)
		await userEvent.type(fill, '40')
		await userEvent.click(screen.getByTestId('levels-save'))
		expect(await screen.findByTestId('levels-error')).toHaveTextContent(
			'could not save',
		)
		expect(screen.getByTestId('level-fill-i1')).toHaveValue('40')
	})

	it('filters to the items with no levels yet', async () => {
		const request = region()
		renderLevels(request)
		await screen.findByTestId('level-row-i1')
		await userEvent.click(screen.getByTestId('levels-show-unset'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([path]) => path.includes('filter=unset')),
			).toBe(true),
		)
	})
})
