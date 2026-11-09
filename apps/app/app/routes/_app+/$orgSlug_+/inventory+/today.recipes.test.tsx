// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { dishesWithoutRecipeResultSchema } from '@repo/inventory'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { type InventoryLayoutContext } from './_layout.tsx'
import InventoryTodayRoute from './today.tsx'

vi.mock('@repo/ui/chart', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ChartContainer: () => <div />,
}))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	window.localStorage.clear()
})

const CONTEXT: InventoryLayoutContext = {
	orgSlug: 'acme',
	nav: {
		...HIDDEN_INVENTORY_NAV,
		visible: true,
		today: true,
		recipes: true,
		editRecipes: true,
	},
	locations: [{ id: 'main', name: 'Acme' }],
	activeLocationId: 'main',
	canSeeCost: true,
	canEdit: true,
	canManagePurchasing: false,
	purchasingEnabled: false,
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
}

const DISHES = [
	{ id: 'mi_1', name: 'Chicken shawarma', price: 22 },
	{ id: 'mi_2', name: 'Falafel wrap', price: 14 },
]

const TODAY = {
	locationId: 'main',
	date: '2026-11-09',
	metrics: {
		lastCountAt: Date.now() - 3 * 86_400_000,
		wasteWeekCount: 0,
		lowItems: 0,
		outItems: 0,
	},
	attention: [],
	week: [],
	setup: { items: 12, storageAreas: 3, approvedCounts: 2, deliveries: 4 },
}

function missing(value: unknown) {
	return dishesWithoutRecipeResultSchema.parse(value)
}

function region(answer: () => unknown) {
	return vi.fn<InventoryClient['request']>(async (path) => {
		if (path.startsWith('/today')) return TODAY
		if (path.startsWith('/waste/summary')) {
			return {
				from: '2026-11-03',
				to: '2026-11-09',
				count: 0,
				currency: 'SAR',
				byReason: [],
				byCategory: [],
				byDay: [],
				topItems: [],
			}
		}
		if (path.startsWith('/recipes/missing')) return answer()
		throw new Error(`unexpected request ${path}`)
	})
}

function renderToday(
	request: InventoryClient['request'],
	context: Partial<InventoryLayoutContext> = {},
	dishes = DISHES,
) {
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory',
				element: <Outlet context={{ ...CONTEXT, ...context }} />,
				children: [
					{
						path: 'today',
						loader: () => ({ dishes }),
						HydrateFallback: () => null,
						element: <InventoryTodayRoute />,
					},
				],
			},
		],
		{ initialEntries: ['/acme/inventory/today'] },
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

describe('Today: dishes without a recipe', () => {
	it('joins dish names in the browser and links each row to its editor', async () => {
		const request = region(() =>
			missing({
				days: 30,
				total: 3,
				truncated: false,
				dishes: [
					{
						itemId: 'mi_2',
						quantity: 48,
						netSalesMinor: 67_200,
						currency: 'SAR',
					},
					{
						itemId: 'mi_1',
						quantity: 12,
						netSalesMinor: 26_400,
						currency: 'SAR',
					},
					// Not on the menu any more: no editor to open, so no row.
					{ itemId: 'mi_gone', quantity: 5 },
				],
			}),
		)
		renderToday(request)
		const list = await screen.findByTestId('today-missing-recipes-list')
		expect(request).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\/recipes\/missing\?locationId=main&days=30&limit=10$/,
			),
		)
		expect(screen.getByTestId('today-missing-recipe-mi_2')).toHaveTextContent(
			'Falafel wrap',
		)
		expect(screen.getByTestId('today-missing-recipe-mi_2')).toHaveTextContent(
			'48 sold',
		)
		expect(screen.getByTestId('today-missing-recipe-mi_2')).toHaveTextContent(
			'672.00',
		)
		const links = Array.from(list.querySelectorAll('a')).map((a) =>
			a.getAttribute('href'),
		)
		expect(links).toEqual(['/acme/menu/items/mi_2', '/acme/menu/items/mi_1'])
		expect(screen.queryByText(/mi_gone/)).toBeNull()
		expect(screen.getByTestId('today-missing-recipes-more')).toHaveTextContent(
			'and 1 more dish without a recipe',
		)
	})

	it('shows no sales money when the region left it out', async () => {
		renderToday(
			region(() =>
				missing({
					days: 30,
					total: 1,
					truncated: false,
					dishes: [{ itemId: 'mi_1', quantity: 12 }],
				}),
			),
			{ canSeeCost: false },
		)
		const row = await screen.findByTestId('today-missing-recipe-mi_1')
		expect(row).toHaveTextContent('12 sold')
		expect(row).not.toHaveTextContent('SAR')
	})

	it('says every dish has a recipe when none are missing', async () => {
		renderToday(
			region(() =>
				missing({ days: 30, total: 0, truncated: false, dishes: [] }),
			),
		)
		expect(
			await screen.findByText('Every dish you sell has a recipe.'),
		).toBeInTheDocument()
	})

	it('is not on the page, and asks nothing, while recipes are off', async () => {
		const request = region(() =>
			missing({ days: 30, total: 0, truncated: false, dishes: [] }),
		)
		renderToday(request, {
			nav: { ...HIDDEN_INVENTORY_NAV, visible: true, today: true },
		})
		await screen.findByTestId('inventory-today')
		expect(screen.queryByTestId('today-missing-recipes')).toBeNull()
		expect(
			request.mock.calls.some(([path]) => path.startsWith('/recipes/missing')),
		).toBe(false)
	})

	it('goes away when the region says recipes are not available', async () => {
		renderToday(
			region(() => {
				throw new OperatorRequestError('no', 'feature_disabled', 404)
			}),
		)
		await screen.findByTestId('inventory-today')
		await waitFor(() =>
			expect(screen.queryByTestId('today-missing-recipes')).toBeNull(),
		)
	})

	it('offers Try again after another failure', async () => {
		let attempts = 0
		renderToday(
			region(() => {
				attempts += 1
				if (attempts === 1) throw new Error('network')
				return missing({ days: 30, total: 0, truncated: false, dishes: [] })
			}),
		)
		await userEvent.click(
			await screen.findByRole('button', { name: 'Try again' }),
		)
		expect(
			await screen.findByText('Every dish you sell has a recipe.'),
		).toBeInTheDocument()
	})
})
