// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor, within } from '@testing-library/react'
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
import { sentJson } from '#tests/inventory-render.tsx'
import { type InventoryLayoutContext } from './_layout.tsx'
import InventoryWasteRoute from './waste.tsx'

// jsdom has no layout, so Recharts would warn about a 0 x 0 chart: the test
// checks that each chart is there and what feeds it, not its pixels.
vi.mock('@repo/ui/chart', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ChartContainer: ({ 'data-testid': testId }: { 'data-testid'?: string }) => (
		<div data-testid={testId} />
	),
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

beforeEach(() => {
	vi.clearAllMocks()
})

const CONTEXT: InventoryLayoutContext = {
	orgSlug: 'acme',
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, waste: true },
	locations: [{ id: 'main', name: 'Acme' }],
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
}

const SUMMARY = {
	from: '2026-11-02',
	to: '2026-11-08',
	count: 5,
	valueMinor: 12_000,
	purchasesMinor: 240_000,
	currency: 'SAR',
	byReason: [
		{ reason: 'expired', count: 3, valueMinor: 9_000 },
		{ reason: 'dropped', count: 2, valueMinor: 3_000 },
	],
	byCategory: [{ category: 'meat', count: 5, valueMinor: 12_000 }],
	byDay: [],
	topItems: [],
}

function entry(overrides: Record<string, unknown> = {}) {
	return {
		id: 'w1',
		locationId: 'main',
		itemId: 'itm_1',
		itemName: 'Chicken thighs',
		category: 'meat',
		baseUnit: 'g',
		quantity: 2_300_000,
		reason: 'expired',
		note: 'Left out overnight',
		actor: { kind: 'operator', id: 'usr_1' },
		businessDate: '2026-11-08',
		createdAt: Date.now() - 60_000,
		undoneAt: null,
		reversesId: null,
		valueMinor: 6_440,
		currency: 'SAR',
		...overrides,
	}
}

function stripMoney<T extends Record<string, unknown>>(value: T): T {
	const copy: Record<string, unknown> = { ...value }
	for (const key of ['valueMinor', 'purchasesMinor', 'currency'])
		delete copy[key]
	return copy as T
}

function region(
	options: { cost?: boolean; entries?: unknown[]; summaryError?: Error } = {},
) {
	const withCost = options.cost ?? true
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.startsWith('/waste/summary')) {
			if (options.summaryError) throw options.summaryError
			return withCost
				? SUMMARY
				: {
						...stripMoney(SUMMARY),
						byReason: SUMMARY.byReason.map((row) => stripMoney(row)),
						byCategory: SUMMARY.byCategory.map((row) => stripMoney(row)),
					}
		}
		if (path.startsWith('/waste?')) {
			const entries = options.entries ?? [entry()]
			return {
				entries: withCost
					? entries
					: entries.map((row) => stripMoney(row as Record<string, unknown>)),
				nextCursor: null,
			}
		}
		if (path.endsWith('/undo') && init?.method === 'POST') return {}
		if (path.endsWith('/correct') && init?.method === 'POST') {
			return entry({ currentQuantity: 0, currentValueMinor: 0 })
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function renderWaste(
	request: InventoryClient['request'],
	{ route = '/acme/inventory/waste', context = CONTEXT } = {},
) {
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory',
				element: <Outlet context={context} />,
				children: [
					{
						path: 'waste',
						loader: () => ({
							memberNames: { usr_1: 'Sara Ahmed' },
							dishNames: [{ id: 'dish_shawarma', name: 'Chicken shawarma' }],
						}),
						HydrateFallback: () => null,
						element: <InventoryWasteRoute />,
					},
				],
			},
		],
		{ initialEntries: [route] },
	)
	const view = render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<InventoryChangeProvider>
					<RouterProvider router={router} />
				</InventoryChangeProvider>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
	return { router, ...view }
}

function paths(request: ReturnType<typeof region>, prefix: string) {
	return request.mock.calls
		.map(([path]) => path)
		.filter((path) => path.startsWith(prefix))
}

describe('Inventory Waste', () => {
	it('shows what was wasted in money, as a share of purchases, and the top reason', async () => {
		renderWaste(region())
		const summary = await screen.findByTestId('waste-summary')
		expect(summary).toHaveTextContent('Wasted')
		expect(summary).toHaveTextContent('120.00')
		expect(summary).toHaveTextContent('Share of what you bought')
		expect(summary).toHaveTextContent('5%')
		expect(summary).toHaveTextContent('Times wasted')
		expect(summary).toHaveTextContent('Top reason')
		expect(summary).toHaveTextContent('Expired')
		expect(screen.getByTestId('waste-chart-reason')).toBeInTheDocument()
		expect(screen.getByTestId('waste-chart-category')).toBeInTheDocument()
	})

	it('leaves every money figure out without the cost grant', async () => {
		renderWaste(region({ cost: false }), {
			context: { ...CONTEXT, canSeeCost: false },
		})
		const summary = await screen.findByTestId('waste-summary')
		expect(summary).toHaveTextContent('Times wasted')
		expect(summary).toHaveTextContent('Top reason')
		expect(summary).not.toHaveTextContent('Wasted120')
		expect(screen.queryByText('Share of what you bought')).toBeNull()
		expect(screen.queryByText(/SAR/)).toBeNull()
		await screen.findByTestId('waste-row-w1')
		expect(screen.queryByRole('columnheader', { name: 'Cost' })).toBeNull()
	})

	it('asks the region for the period and filters by reason through the URL', async () => {
		const request = region()
		const { router } = renderWaste(request)
		await screen.findByTestId('waste-summary')
		const summaryPath = paths(request, '/waste/summary')[0]!
		const params = new URLSearchParams(summaryPath.split('?')[1])
		expect(params.get('locationId')).toBe('main')
		expect(params.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
		expect(params.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/)

		await userEvent.click(screen.getByTestId('waste-filter-reason'))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Spoiled' }),
		)
		await waitFor(() =>
			expect(router.state.location.search).toContain('reason=spoiled'),
		)
		await waitFor(() =>
			expect(
				paths(request, '/waste?').some((path) =>
					path.includes('reason=spoiled'),
				),
			).toBe(true),
		)
		// The summary covers every reason: it does not take the reason filter.
		expect(
			paths(request, '/waste/summary').every(
				(path) => !path.includes('reason'),
			),
		).toBe(true)
	})

	it('falls back, and says so, when custom dates cannot be used', async () => {
		renderWaste(region(), {
			route: '/acme/inventory/waste?range=custom&from=2026-11-09&to=2026-11-01',
		})
		expect(await screen.findByTestId('waste-range-invalid')).toBeInTheDocument()
	})

	it('lists the log with who, amount, reason and cost', async () => {
		renderWaste(region())
		const row = await screen.findByTestId('waste-row-w1')
		expect(within(row).getByText('Chicken thighs')).toBeInTheDocument()
		expect(within(row).getByText('Left out overnight')).toBeInTheDocument()
		expect(within(row).getByText('Sara Ahmed')).toBeInTheDocument()
		expect(within(row).getByText('2.3 kg')).toBeInTheDocument()
		expect(within(row).getByText('Expired')).toBeInTheDocument()
		expect(within(row).getByText(/64\.40/)).toBeInTheDocument()
	})

	it('undoes a recent entry, and not one that was already undone or is too old', async () => {
		const request = region({
			entries: [
				entry(),
				entry({ id: 'w2', undoneAt: Date.now() }),
				entry({ id: 'w3', createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000 }),
			],
		})
		renderWaste(request)
		await screen.findByTestId('waste-row-w1')
		expect(screen.queryByTestId('waste-undo-w2')).toBeNull()
		expect(screen.queryByTestId('waste-undo-w3')).toBeNull()
		expect(
			within(screen.getByTestId('waste-row-w2')).getByText('Undone'),
		).toBeInTheDocument()

		await userEvent.click(screen.getByTestId('waste-undo-w1'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Waste undone.'),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/waste/w1/undo',
		)
		expect(index).toBeGreaterThanOrEqual(0)
		expect(sentJson(request, index)).toEqual({
			clientId: expect.stringMatching(/^u-/),
		})
	})

	it('says nothing was logged, or shows the error with Try again', async () => {
		const none = renderWaste(region({ entries: [] }))
		expect(await screen.findByText('No waste logged')).toBeInTheDocument()
		none.unmount()

		renderWaste(
			region({
				summaryError: new OperatorRequestError(
					'down',
					'inventory_unavailable',
					503,
				),
			}),
		)
		expect(await screen.findByTestId('waste-summary-error')).toHaveTextContent(
			'Inventory is paused right now',
		)
		expect(
			screen.getByRole('button', { name: 'Try again' }),
		).toBeInTheDocument()
	})

	describe('a whole dish and later corrections', () => {
		const dishEntry = (overrides: Record<string, unknown> = {}) =>
			entry({
				id: 'g1',
				itemId: null,
				itemName: null,
				category: null,
				baseUnit: null,
				quantity: 2,
				note: null,
				reason: 'dropped',
				valueMinor: 1_230,
				dish: {
					groupId: 'g1',
					menuItemId: 'dish_shawarma',
					variantId: null,
					options: [],
					dishes: 2,
					basis: 'recipe',
					ingredients: 3,
				},
				...overrides,
			})

		it('reads a dish as one grouped line and undoes the whole group', async () => {
			const request = region({ entries: [dishEntry()] })
			renderWaste(request)
			const row = await screen.findByTestId('waste-row-g1')
			expect(row).toHaveTextContent('2 × Chicken shawarma')
			expect(row).toHaveTextContent('3 ingredients')
			await userEvent.click(within(row).getByTestId('waste-undo-g1'))
			await waitFor(() =>
				expect(request).toHaveBeenCalledWith('/waste/dishes/g1/undo', {
					method: 'POST',
					body: expect.stringContaining('"clientId"'),
				}),
			)
		})

		it('shows the original and its correction, and offers no undo or second correction on a reversed entry', async () => {
			renderWaste(
				region({
					entries: [
						entry({
							currentQuantity: 0,
							currentValueMinor: 0,
							corrections: [
								{
									id: 'c1',
									kind: 'reverse',
									previousQuantity: 2_300_000,
									newQuantity: 0,
									stockEffect: 'applied',
									reason: 'Logged twice',
									actor: { kind: 'operator', id: 'usr_1' },
									createdAt: Date.now() - 1000,
								},
							],
						}),
					],
				}),
			)
			const row = await screen.findByTestId('waste-row-w1')
			// Both are on the log: the original figure stays beside what it is now.
			expect(row).toHaveTextContent('2.3 kg')
			expect(row).toHaveTextContent('64.40')
			expect(within(row).getByTestId('waste-reversed-w1')).toBeVisible()
			expect(within(row).getByTestId('waste-corrections-w1')).toHaveTextContent(
				'Reversed: Logged twice',
			)
			expect(within(row).queryByTestId('waste-undo-w1')).toBeNull()
			expect(within(row).queryByTestId('waste-correct-w1')).toBeNull()
		})

		it('reverses an entry later with a reason, and says first that stock is unchanged when a later count covers it', async () => {
			const request = region({
				entries: [
					entry({
						createdAt: Date.now() - 3 * 24 * 3_600_000,
						countedSince: true,
					}),
				],
			})
			renderWaste(request)
			const row = await screen.findByTestId('waste-row-w1')
			// Older than the undo window: only a correction is offered.
			expect(within(row).queryByTestId('waste-undo-w1')).toBeNull()
			await userEvent.click(within(row).getByTestId('waste-correct-w1'))
			const dialog = await screen.findByTestId('correct-waste-dialog')
			expect(
				within(dialog).getByTestId('correct-waste-covered-note'),
			).toHaveTextContent('your stock will not change')
			// A reason is needed before anything is sent.
			await userEvent.click(within(dialog).getByTestId('correct-waste-submit'))
			expect(request.mock.calls.some(([p]) => p === '/waste/w1/correct')).toBe(
				false,
			)
			await userEvent.type(
				within(dialog).getByTestId('correct-waste-reason'),
				'Weighed wrong',
			)
			await userEvent.click(within(dialog).getByTestId('correct-waste-submit'))
			await waitFor(() =>
				expect(
					request.mock.calls.some(([p]) => p === '/waste/w1/correct'),
				).toBe(true),
			)
			const index = request.mock.calls.findIndex(
				([p]) => p === '/waste/w1/correct',
			)
			expect(sentJson(request, index)).toEqual({
				clientId: expect.stringMatching(/^c-/),
				kind: 'reverse',
				reason: 'Weighed wrong',
			})
		})

		it('says stock changes by the difference when no count covers the entry, and changes a quantity', async () => {
			const request = region({
				entries: [entry({ createdAt: Date.now() - 3 * 24 * 3_600_000 })],
			})
			renderWaste(request)
			await userEvent.click(await screen.findByTestId('waste-correct-w1'))
			const dialog = await screen.findByTestId('correct-waste-dialog')
			expect(
				within(dialog).getByTestId('correct-waste-stock-note'),
			).toHaveTextContent('Your stock changes by the difference')
			await userEvent.click(
				within(dialog).getByTestId('correct-waste-kind-quantity'),
			)
			await userEvent.type(
				within(dialog).getByTestId('correct-waste-amount'),
				'5',
			)
			await userEvent.type(
				within(dialog).getByTestId('correct-waste-reason'),
				'It was 5 g',
			)
			await userEvent.click(within(dialog).getByTestId('correct-waste-submit'))
			await waitFor(() =>
				expect(
					request.mock.calls.some(([p]) => p === '/waste/w1/correct'),
				).toBe(true),
			)
			const index = request.mock.calls.findIndex(
				([p]) => p === '/waste/w1/correct',
			)
			expect(sentJson(request, index)).toMatchObject({
				kind: 'quantity',
				amount: 5,
				reason: 'It was 5 g',
			})
		})
	})
})
