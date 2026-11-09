// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	recipeResultSchema,
	recordBatchSchema,
	type ItemDetail,
} from '@repo/inventory'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { type StockOutletContext } from '#app/components/inventory/stock-context.ts'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { stockItem } from '#tests/inventory-fixtures.ts'
import { sentJson } from '#tests/inventory-render.tsx'
import InventoryItemSheetRoute from './stock.$itemId.tsx'

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

const reload = vi.fn()

function context(
	overrides: Partial<StockOutletContext> = {},
): StockOutletContext {
	return {
		orgSlug: 'acme',
		nav: {
			...HIDDEN_INVENTORY_NAV,
			visible: true,
			stock: true,
			recipes: true,
			editRecipes: true,
			seeCost: true,
		},
		locations: [{ id: 'main', name: 'Acme Riyadh' }],
		activeLocationId: 'main',
		canSeeCost: true,
		canEdit: true,
		canManagePurchasing: false,
		purchasingEnabled: false,
		dataRegion: 'ksa',
		currency: 'SAR',
		userName: 'Sara',
		basePath: '/acme/inventory/stock',
		search: '',
		areas: [],
		reload,
		close: vi.fn(),
		...overrides,
	}
}

function detail(overrides: Partial<ItemDetail> = {}) {
	return {
		...stockItem({
			id: 'itm_sauce',
			name: 'Garlic sauce',
			category: 'sauces',
			kind: 'made',
			baseUnit: 'ml',
			countUnit: 'l',
			onHand: 4_000_000,
			version: 7,
			...overrides,
		}),
		notes: null,
		places: [],
		onHandByLocation: [],
		suppliers: [],
		hasMovements: false,
	}
}

const SETTINGS = {
	targetFoodCostBp: 3000,
	unitSystem: 'metric',
	countDayOfWeek: null,
	version: 1,
	updatedAt: null,
}

const SAUCE_RECIPE = recipeResultSchema.parse({
	version: 2,
	recipe: {
		id: 'r1',
		ownerKind: 'made_item',
		ownerId: 'itm_sauce',
		version: 2,
		makesQuantity: 4_000_000,
		multiplierBp: null,
		method: null,
		effectiveFrom: 0,
		createdAt: 0,
		lines: [
			{
				id: 'l1',
				itemId: 'itm_garlic',
				itemName: 'Garlic',
				baseUnit: 'g',
				quantity: 500_000,
				usableBp: 10_000,
				mode: 'add',
				replacesItemId: null,
				replacesItemName: null,
				sortOrder: 0,
				priced: true,
				costMinor: 800,
			},
		],
		plate: {
			state: 'complete',
			costMinor: 800,
			currency: 'SAR',
			missingItemIds: [],
		},
	},
})

function region(
	item: ReturnType<typeof detail>,
	extra: (path: string, init?: RequestInit) => unknown = () => undefined,
) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		const custom = extra(path, init)
		if (custom !== undefined) return custom
		if (path === '/settings') return SETTINGS
		if (path.includes('/movements')) return { movements: [], nextCursor: null }
		if (path.startsWith('/recipes?')) return SAUCE_RECIPE
		if (path.startsWith('/items?'))
			return { items: [], total: 0, nextCursor: null }
		if (path.startsWith(`/items/${item.id}?`)) return item
		if (path.startsWith(`/items/${item.id}`) && init?.method === 'PATCH')
			return {}
		throw new Error(`unexpected request ${path}`)
	})
}

function renderSheet(
	request: InventoryClient['request'],
	ctx: StockOutletContext,
	itemId = 'itm_sauce',
) {
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory/stock',
				element: (
					<Sheet open>
						<SheetContent>
							<Outlet context={ctx} />
						</SheetContent>
					</Sheet>
				),
				children: [
					{
						path: ':itemId',
						loader: () => ({ memberNames: {} }),
						HydrateFallback: () => null,
						element: <InventoryItemSheetRoute />,
					},
				],
			},
		],
		{ initialEntries: [`/acme/inventory/stock/${itemId}`] },
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

describe('Item sheet: recipes for made items', () => {
	it('shows the recipe of a made item with what a batch makes and its cost', async () => {
		const request = region(detail())
		renderSheet(request, context())
		expect(await screen.findByTestId('item-sheet-recipe')).toBeInTheDocument()
		expect(await screen.findByTestId('made-recipe-line-0')).toBeInTheDocument()
		expect(request).toHaveBeenCalledWith(
			'/recipes?ownerKind=made_item&ownerId=itm_sauce',
		)
		expect(await screen.findByTestId('made-recipe-makes-amount')).toHaveValue(
			'4',
		)
		expect(await screen.findByTestId('made-recipe-cost')).toHaveTextContent(
			'8.00',
		)
	})

	it('saves the recipe of a made item with what it makes', async () => {
		const request = region(detail())
		renderSheet(request, context())
		const amount = await screen.findByTestId('made-recipe-line-0-amount')
		await userEvent.clear(amount)
		await userEvent.type(amount, '600')
		await userEvent.click(screen.getByTestId('made-recipe-save'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([, init]) => init?.method === 'PUT'),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/recipes' && init?.method === 'PUT',
		)
		expect(sentJson(request, index)).toEqual({
			ownerKind: 'made_item',
			ownerId: 'itm_sauce',
			expectedVersion: 2,
			lines: [
				{
					itemId: 'itm_garlic',
					amount: 600,
					unit: 'g',
					usableBp: 10_000,
					mode: 'add',
				},
			],
			makes: { amount: 4, unit: 'l' },
		})
	})

	it('turns "we make this in batches" on with the item version', async () => {
		const request = region(detail())
		renderSheet(request, context())
		await userEvent.click(await screen.findByTestId('item-sheet-batch-counted'))
		await waitFor(() => expect(reload).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/items/itm_sauce' && init?.method === 'PATCH',
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 7,
			batchCounted: true,
		})
	})

	it('turns on marking dishes sold out only with the recipe grant', async () => {
		const request = region(detail())
		const { unmount } = renderSheet(request, context())
		await userEvent.click(await screen.findByTestId('item-sheet-auto-sold-out'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([, init]) => init?.method === 'PATCH'),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([, init]) => init?.method === 'PATCH',
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 7,
			autoSoldOut: true,
		})
		expect(
			screen.getByText(
				/counted in the last 7 days. You can undo it from Today/,
			),
		).toBeInTheDocument()
		unmount()

		renderSheet(
			region(detail()),
			context({
				nav: {
					...HIDDEN_INVENTORY_NAV,
					visible: true,
					stock: true,
					recipes: true,
					editRecipes: false,
				},
			}),
		)
		expect(
			await screen.findByTestId('item-sheet-auto-sold-out'),
		).toHaveAttribute('aria-disabled', 'true')
		expect(screen.queryByTestId('made-recipe-save')).toBeNull()
	})

	it('shows the sold-out switch for a bought item but no recipe or batch pieces', async () => {
		renderSheet(
			region(detail({ id: 'itm_1', name: 'Chicken', kind: 'bought' })),
			context(),
			'itm_1',
		)
		expect(
			await screen.findByTestId('item-sheet-auto-sold-out'),
		).toBeInTheDocument()
		expect(screen.queryByTestId('item-sheet-recipe')).toBeNull()
		expect(screen.queryByTestId('item-sheet-batch-counted')).toBeNull()
		expect(screen.queryByTestId('item-sheet-record-batch')).toBeNull()
	})

	it('hides every recipe piece while the recipes flag is off', async () => {
		const request = region(detail())
		renderSheet(
			request,
			context({
				nav: { ...HIDDEN_INVENTORY_NAV, visible: true, stock: true },
			}),
		)
		await screen.findByTestId('item-sheet-on-hand')
		expect(screen.queryByTestId('item-sheet-recipe')).toBeNull()
		expect(screen.queryByTestId('item-sheet-sales-use')).toBeNull()
		expect(
			request.mock.calls.some(([path]) => path.startsWith('/recipes')),
		).toBe(false)
	})

	it('removes the recipe section when the region says it is not available', async () => {
		renderSheet(
			region(detail(), (path) => {
				if (path.startsWith('/recipes?')) {
					throw new OperatorRequestError('no', 'feature_disabled', 404)
				}
				return undefined
			}),
			context(),
		)
		await screen.findByTestId('item-sheet-on-hand')
		await waitFor(() =>
			expect(screen.queryByTestId('item-sheet-recipe')).toBeNull(),
		)
		expect(screen.queryByTestId('item-sheet-sales-use')).toBeNull()
	})
})

describe('Record a batch', () => {
	it('records a number of batches with a client id and says what was added', async () => {
		const request = region(detail(), (path, init) => {
			if (path === '/items/itm_sauce/batch' && init?.method === 'POST') {
				return {
					id: 'mv1',
					madeQuantity: 4_000_000,
					used: [],
				}
			}
			return undefined
		})
		renderSheet(request, context())
		await userEvent.click(await screen.findByTestId('item-sheet-record-batch'))
		expect(screen.getByTestId('record-batch-count')).toHaveValue('1')
		await userEvent.clear(screen.getByTestId('record-batch-count'))
		await userEvent.type(screen.getByTestId('record-batch-count'), '2')
		await userEvent.click(screen.getByTestId('record-batch-submit'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				'Batch recorded: 4 L of Garlic sauce added.',
			),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/items/itm_sauce/batch',
		)
		const sent = sentJson(request, index)
		expect(sent).toEqual({
			clientId: expect.stringMatching(/^b-/),
			locationId: 'main',
			made: { kind: 'batches', count: 2 },
		})
		expect(recordBatchSchema.safeParse(sent).success).toBe(true)
		expect(reload).toHaveBeenCalled()
	})

	it('records the amount that came out in a chosen unit', async () => {
		const request = region(detail(), (path, init) => {
			if (path === '/items/itm_sauce/batch' && init?.method === 'POST') {
				return { id: 'mv1', madeQuantity: 3_500_000, used: [] }
			}
			return undefined
		})
		renderSheet(request, context())
		await userEvent.click(await screen.findByTestId('item-sheet-record-batch'))
		await userEvent.click(screen.getByTestId('record-batch-kind-amount'))
		await userEvent.type(screen.getByTestId('record-batch-amount'), '3.5')
		await userEvent.click(screen.getByTestId('record-batch-unit-l'))
		await userEvent.click(screen.getByTestId('record-batch-submit'))
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path]) => path === '/items/itm_sauce/batch',
		)
		expect(sentJson(request, index)).toMatchObject({
			made: { kind: 'amount', amount: 3.5, unit: 'l' },
		})
	})

	it('explains a missing recipe and keeps the dialog open', async () => {
		renderSheet(
			region(detail(), (path, init) => {
				if (path === '/items/itm_sauce/batch' && init?.method === 'POST') {
					throw new OperatorRequestError('empty', 'recipe_empty', 409)
				}
				return undefined
			}),
			context(),
		)
		await userEvent.click(await screen.findByTestId('item-sheet-record-batch'))
		await userEvent.click(screen.getByTestId('record-batch-submit'))
		expect(await screen.findByTestId('record-batch-error')).toHaveTextContent(
			'This item has no recipe yet',
		)
		expect(screen.getByTestId('record-batch-dialog')).toBeInTheDocument()
		expect(toast.success).not.toHaveBeenCalled()
	})

	it('is not offered without the inventory edit grant', async () => {
		renderSheet(region(detail()), context({ canEdit: false }))
		await screen.findByTestId('item-sheet-auto-sold-out')
		expect(screen.queryByTestId('item-sheet-record-batch')).toBeNull()
		expect(screen.getByTestId('item-sheet-batch-counted')).toHaveAttribute(
			'aria-disabled',
			'true',
		)
	})
})
