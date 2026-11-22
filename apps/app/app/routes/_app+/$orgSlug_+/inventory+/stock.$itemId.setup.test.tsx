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
import { stockItem } from '#tests/inventory-fixtures.ts'
import { sentJson } from '#tests/inventory-render.tsx'
import InventoryItemSheetRoute from './stock.$itemId.tsx'

/**
 * The setup tools on the item sheet: where it is used (#518), changing its
 * unit (#494), merging a duplicate (#493) and days left (#492).
 */

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@repo/ui/chart', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ChartContainer: () => <div data-testid="price-chart" />,
}))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const close = vi.fn()
const reload = vi.fn()
beforeEach(() => vi.clearAllMocks())

const CONTEXT: StockOutletContext = {
	orgSlug: 'acme',
	nav: {
		...HIDDEN_INVENTORY_NAV,
		visible: true,
		stock: true,
		recipes: true,
		editRecipes: true,
	},
	locations: [{ id: 'main', name: 'Acme Riyadh' }],
	activeLocationId: 'main',
	canSeeCost: true,
	canEdit: true,
	canManagePurchasing: false,
	purchasingEnabled: false,
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

const DETAIL = {
	...stockItem({ onHand: 5_000_000, lastCountedAt: Date.UTC(2026, 10, 1) }),
	notes: null,
	places: [],
	onHandByLocation: [{ locationId: 'main', onHand: 5_000_000 }],
	suppliers: [],
	cost: null,
	hasMovements: true,
	daysLeft: {
		state: 'ok',
		days: 2.5,
		perDay: 2_000_000,
		runsOutDate: '2026-11-18',
		useDays: 28,
		stale: false,
	},
}

const USED_IN = {
	itemId: 'itm_1',
	baseUnit: 'g',
	more: 0,
	rows: [
		{
			ownerKind: 'menu_item',
			ownerId: 'd1',
			ownerName: null,
			quantity: 120_000,
			usableBp: 10_000,
			mode: 'add',
			viaGroupItemId: null,
			viaGroupName: null,
			costMinor: 360,
			shareBp: 5_900,
		},
		{
			ownerKind: 'menu_item',
			ownerId: 'd2',
			ownerName: null,
			quantity: 200_000,
			usableBp: 10_000,
			mode: 'add',
			viaGroupItemId: null,
			viaGroupName: null,
			costMinor: 600,
			shareBp: 10_000,
		},
		{
			ownerKind: 'option',
			ownerId: 'o1',
			ownerName: null,
			quantity: 40_000,
			usableBp: 10_000,
			mode: 'add',
			viaGroupItemId: null,
			viaGroupName: null,
			costMinor: 120,
			shareBp: null,
		},
	],
}

const PLAN = {
	itemId: 'itm_1',
	itemName: 'Chicken thighs',
	fromUnit: 'g',
	toUnit: 'piece',
	factor: { num: 1, den: 180 },
	blockers: [],
	onHand: [{ locationId: 'main', before: 5_000_000, after: 27_778 }],
	packs: [
		{
			kind: 'supplier_product',
			id: 'sp1',
			name: 'Box',
			before: 10_000_000,
			after: 55_556,
		},
	],
	recipes: [
		{
			ownerKind: 'menu_item',
			ownerId: 'd1',
			lines: [{ lineId: 'l1', before: 180_000, after: 1_000 }],
			makes: null,
		},
	],
	levels: [],
	lastCount: null,
	tooSmall: false,
	canApply: true,
}

function region(overrides: Partial<Record<string, unknown>> = {}) {
	return vi.fn<InventoryClient['request']>(async (path) => {
		if (path.includes('/movements')) return { movements: [], nextCursor: null }
		if (path.endsWith('/used-in')) return overrides.usedIn ?? USED_IN
		if (path.endsWith('/unit-change/preview')) return PLAN
		if (path.endsWith('/unit-change')) return { plan: PLAN, changeId: 'c1' }
		if (path.endsWith('/merge-candidates')) {
			return {
				candidates: [
					{
						id: 'itm_2',
						name: 'Chicken thigh',
						baseUnit: 'g',
						reasons: ['name'],
					},
					{ id: 'itm_3', name: 'Rice', baseUnit: 'g', reasons: [] },
				],
			}
		}
		if (path.includes('/merge-preview')) {
			return {
				itemId: 'itm_1',
				itemName: 'Chicken thighs',
				itemVersion: 1,
				intoItemId: 'itm_2',
				intoItemName: 'Chicken thigh',
				intoItemVersion: 4,
				baseUnit: 'g',
				blockers: [],
				unitMismatch: false,
				kindMismatch: false,
				moves: {
					recipes: 2,
					supplierProducts: 1,
					places: 1,
					countLists: 0,
					prepLevels: 0,
				},
				onHand: [
					{
						locationId: 'main',
						duplicate: 5_000_000,
						kept: 3_000_000,
						after: 8_000_000,
					},
				],
				needsRecipeGrant: false,
				canApply: true,
			}
		}
		if (path.endsWith('/merge')) {
			return {
				mergeId: 'm1',
				kind: 'item',
				keptId: 'itm_2',
				mergedId: 'itm_1',
				undoUntil: Date.now() + 86_400_000,
				moves: {},
			}
		}
		if (path.endsWith('/archive')) return {}
		if (path.startsWith('/items/itm_1')) return overrides.detail ?? DETAIL
		throw new Error(`unexpected request ${path}`)
	})
}

function renderSheet(
	request: InventoryClient['request'],
	context: StockOutletContext = CONTEXT,
) {
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory/stock',
				element: (
					<Sheet open>
						<SheetContent>
							<Outlet context={context} />
						</SheetContent>
					</Sheet>
				),
				children: [
					{
						path: ':itemId',
						loader: () => ({
							memberNames: {},
							menu: {
								dishes: [
									{ id: 'd1', name: 'Margherita' },
									{ id: 'd2', name: 'Quattro formaggi' },
								],
								options: [{ id: 'o1', name: 'Extra cheese' }],
							},
						}),
						HydrateFallback: () => null,
						element: <InventoryItemSheetRoute />,
					},
				],
			},
		],
		{ initialEntries: ['/acme/inventory/stock/itm_1'] },
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

describe('Used in (#518)', () => {
	it('lists an ingredient in three recipes with their quantities and cost share', async () => {
		renderSheet(region())
		const list = await screen.findByTestId('used-in-list')
		expect(within(list).getAllByRole('listitem')).toHaveLength(3)
		expect(screen.getByTestId('used-in-row-d1')).toHaveTextContent('Margherita')
		expect(screen.getByTestId('used-in-row-d1')).toHaveTextContent('120 g')
		expect(screen.getByTestId('used-in-row-d1')).toHaveTextContent('59%')
		expect(screen.getByTestId('used-in-row-d2')).toHaveTextContent(
			'Quattro formaggi',
		)
		expect(screen.getByTestId('used-in-row-d2')).toHaveTextContent('200 g')
		expect(screen.getByTestId('used-in-row-o1')).toHaveTextContent(
			'Extra cheese',
		)
		// Each row leads to its recipe.
		expect(
			within(screen.getByTestId('used-in-row-d1')).getByRole('link'),
		).toHaveAttribute('href', '/acme/menu/items/d1')
		expect(
			within(screen.getByTestId('used-in-row-o1')).getByRole('link'),
		).toHaveAttribute('href', '/acme/menu/options/o1')
	})

	it('shows no cost share without the cost grant', async () => {
		renderSheet(region(), { ...CONTEXT, canSeeCost: false })
		const list = await screen.findByTestId('used-in-list')
		expect(list).not.toHaveTextContent('%')
	})

	it('says so when nothing uses the item', async () => {
		renderSheet(region({ usedIn: { ...USED_IN, rows: [] } }))
		expect(await screen.findByTestId('item-used-in-empty')).toBeInTheDocument()
	})

	it('shows the list before archiving and can be cancelled', async () => {
		const request = region()
		const user = userEvent.setup()
		renderSheet(request)
		await user.click(await screen.findByTestId('item-sheet-archive'))
		const list = await screen.findByTestId('archive-used-in-list')
		expect(within(list).getAllByRole('listitem')).toHaveLength(3)
		expect(list).toHaveTextContent('Margherita')
		await user.click(screen.getByRole('button', { name: 'Cancel' }))
		await waitFor(() =>
			expect(screen.queryByTestId('archive-used-in')).not.toBeInTheDocument(),
		)
		expect(
			request.mock.calls.some(([path]) => String(path).endsWith('/archive')),
		).toBe(false)
		// Archiving after the list was seen still works.
		await user.click(screen.getByTestId('item-sheet-archive'))
		await user.click(await screen.findByTestId('item-sheet-archive-confirm'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([path]) => String(path).endsWith('/archive')),
			).toBe(true),
		)
	})
})

describe('Days left (#492)', () => {
	it('shows the number and the use rate behind it', async () => {
		renderSheet(region())
		expect(await screen.findByTestId('item-sheet-days-left')).toHaveTextContent(
			'2.5 days',
		)
		expect(screen.getByTestId('item-sheet-use-rate')).toHaveTextContent('2 kg')
	})

	it('says not enough history', async () => {
		renderSheet(
			region({
				detail: {
					...DETAIL,
					daysLeft: { state: 'not_enough_history', useDays: 3, stale: true },
				},
			}),
		)
		expect(await screen.findByTestId('days-left-not-enough')).toHaveTextContent(
			'Not enough history',
		)
	})
})

describe('Change unit (#494)', () => {
	it('previews the conversion and applies exactly what it previewed', async () => {
		const request = region()
		const user = userEvent.setup()
		renderSheet(request)
		await user.click(await screen.findByTestId('item-sheet-change-unit'))
		await user.click(await screen.findByTestId('change-unit-to-piece'))
		await user.type(screen.getByTestId('change-unit-old'), '180')
		const preview = await screen.findByTestId('change-unit-preview')
		expect(preview).toHaveTextContent('On hand')
		expect(preview).toHaveTextContent('Box')
		expect(preview).toHaveTextContent('A recipe line')
		const previewCall = request.mock.calls.findIndex(([path]) =>
			String(path).endsWith('/unit-change/preview'),
		)
		const body = {
			toUnit: 'piece',
			oldAmount: '180',
			newAmount: '1',
			expectedVersion: 1,
		}
		expect(sentJson(request, previewCall)).toEqual(body)
		await user.click(screen.getByTestId('change-unit-apply'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(
					([path]) => path === '/items/itm_1/unit-change',
				),
			).toBe(true),
		)
		const applied = request.mock.calls.findIndex(
			([path]) => path === '/items/itm_1/unit-change',
		)
		expect(sentJson(request, applied)).toEqual(body)
		expect(toast.success).toHaveBeenCalled()
	})

	it('turns Apply off the moment the typed numbers differ from what was previewed', async () => {
		const request = region()
		const user = userEvent.setup()
		renderSheet(request)
		await user.click(await screen.findByTestId('item-sheet-change-unit'))
		await user.click(await screen.findByTestId('change-unit-to-piece'))
		await user.type(screen.getByTestId('change-unit-old'), '180')
		await screen.findByTestId('change-unit-preview')
		expect(screen.getByTestId('change-unit-apply')).toBeEnabled()
		await user.type(screen.getByTestId('change-unit-old'), '0')
		// Not applied against the old preview: it goes away until the new one is in.
		expect(screen.getByTestId('change-unit-apply')).toBeDisabled()
		expect(screen.queryByTestId('change-unit-preview')).not.toBeInTheDocument()
		await screen.findByTestId('change-unit-preview')
		expect(screen.getByTestId('change-unit-apply')).toBeEnabled()
	})

	it('lists what blocks the change and keeps Apply off', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			if (path.endsWith('/unit-change/preview')) {
				return {
					...PLAN,
					blockers: [
						{
							kind: 'open_count',
							id: 'c9',
							locationId: 'main',
							reference: '2026-11-20',
						},
						{ kind: 'open_order', id: 'o9', locationId: null, reference: '12' },
					],
					canApply: false,
				}
			}
			return region()(path, init)
		})
		const user = userEvent.setup()
		renderSheet(request)
		await user.click(await screen.findByTestId('item-sheet-change-unit'))
		await user.click(await screen.findByTestId('change-unit-to-piece'))
		await user.type(screen.getByTestId('change-unit-old'), '180')
		expect(await screen.findByTestId('blocker-open_count')).toBeInTheDocument()
		expect(screen.getByTestId('blocker-open_order')).toHaveTextContent('#12')
		expect(screen.getByTestId('change-unit-apply')).toBeDisabled()
	})
})

describe('Merge into (#493)', () => {
	it('lists likely matches first, previews what moves and merges with both versions', async () => {
		const request = region()
		const user = userEvent.setup()
		renderSheet(request)
		await user.click(await screen.findByTestId('item-sheet-merge'))
		const candidates = await screen.findByTestId('merge-candidates')
		const rows = within(candidates).getAllByRole('button')
		expect(rows[0]).toHaveTextContent('Chicken thigh')
		expect(rows[0]).toHaveTextContent('Similar name')
		await user.click(screen.getByTestId('merge-candidate-itm_2'))
		const preview = await screen.findByTestId('merge-preview')
		expect(preview).toHaveTextContent('2 recipes move over')
		expect(preview).toHaveTextContent('1 supplier product moves over')
		await user.click(screen.getByTestId('merge-apply'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([path]) => path === '/items/itm_1/merge'),
			).toBe(true),
		)
		const sent = request.mock.calls.findIndex(
			([path]) => path === '/items/itm_1/merge',
		)
		expect(sentJson(request, sent)).toEqual({
			intoItemId: 'itm_2',
			expectedVersion: 1,
			intoExpectedVersion: 4,
		})
		// A toast offers the undo.
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		expect(toast.success.mock.calls[0]![1]).toMatchObject({
			action: { label: 'Undo' },
		})
		expect(close).toHaveBeenCalled()
	})

	it('does not merge into the previous target while the new one is still being checked', async () => {
		let release: (value: unknown) => void = () => {}
		const base = region()
		let previews = 0
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			if (path.includes('/merge-preview')) {
				previews += 1
				if (previews === 2) {
					await new Promise((resolve) => {
						release = resolve
					})
				}
			}
			return base(path, init)
		})
		const user = userEvent.setup()
		renderSheet(request)
		await user.click(await screen.findByTestId('item-sheet-merge'))
		await user.click(await screen.findByTestId('merge-candidate-itm_2'))
		await screen.findByTestId('merge-preview')
		expect(screen.getByTestId('merge-apply')).toBeEnabled()
		await user.click(screen.getByTestId('merge-candidate-itm_3'))
		expect(screen.getByTestId('merge-apply')).toBeDisabled()
		expect(screen.queryByTestId('merge-preview')).not.toBeInTheDocument()
		release(null)
	})

	it('shows an undo for a merge still inside its day', async () => {
		const request = region({
			detail: {
				...DETAIL,
				archived: true,
				mergedInto: {
					mergeId: 'm7',
					id: 'itm_2',
					name: 'Chicken thigh',
					undoUntil: Date.now() + 3_600_000,
					undone: false,
				},
			},
		})
		const user = userEvent.setup()
		renderSheet(request)
		const banner = await screen.findByTestId('item-merge-banners')
		expect(banner).toHaveTextContent('Merged into Chicken thigh')
		await user.click(screen.getByTestId('merge-undo-m7'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([path]) => path === '/merges/m7/undo'),
			).toBe(true),
		)
	})
})
