// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InventoryChrome } from '#app/components/inventory/inventory-chrome.tsx'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { type InventoryLayoutContext } from './_layout.tsx'
import InventoryTodayRoute from './today.tsx'

// jsdom has no layout, so Recharts would warn about a 0 x 0 chart: the test
// checks that the chart is there and what feeds it, not its pixels.
vi.mock('@repo/ui/chart', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ChartContainer: ({ 'data-testid': testId }: { 'data-testid'?: string }) => (
		<div data-testid={testId} />
	),
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
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, today: true },
	locations: [{ id: 'main', name: 'Acme' }],
	activeLocationId: 'main',
	canSeeCost: false,
	canEdit: false,
	canManagePurchasing: false,
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
}

function renderToday(
	request: InventoryClient['request'],
	context: Partial<InventoryLayoutContext> = {},
) {
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory',
				element: <Outlet context={{ ...CONTEXT, ...context }} />,
				children: [{ path: 'today', element: <InventoryTodayRoute /> }],
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

function renderTodayInChrome(
	request: InventoryClient['request'],
	context: Partial<InventoryLayoutContext>,
) {
	const merged = { ...CONTEXT, ...context }
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory',
				element: (
					<InventoryChrome
						orgSlug="acme"
						nav={{ ...HIDDEN_INVENTORY_NAV, visible: true, today: true }}
						locations={merged.locations}
						selectedLocationId="main"
						onLocationChange={() => {}}
						canLogWaste={merged.canEdit}
						canSeeCost={merged.canSeeCost}
						currency="SAR"
						userName="Sara"
					>
						<Outlet context={merged} />
					</InventoryChrome>
				),
				children: [{ path: 'today', element: <InventoryTodayRoute /> }],
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

const SETUP_DONE = {
	items: 12,
	storageAreas: 3,
	approvedCounts: 2,
	deliveries: 4,
}

function today(
	overrides: {
		metrics?: object
		attention?: unknown[]
		week?: unknown[]
		setup?: object
	} = {},
) {
	return {
		locationId: 'main',
		date: '2026-11-09',
		metrics: {
			lastCountAt: Date.now() - 3 * 86_400_000,
			wasteWeekCount: 4,
			lowItems: 3,
			outItems: 1,
			...overrides.metrics,
		},
		attention: overrides.attention ?? [],
		week: overrides.week ?? [],
		setup: overrides.setup ?? SETUP_DONE,
	}
}

const WITH_MONEY = {
	stockValueMinor: 1_842_000,
	currency: 'SAR',
	wasteWeekMinor: 64_000,
	wasteWeekShareBp: 240,
	foodCost: {
		state: 'ok',
		from: '2026-11-01',
		to: '2026-11-08',
		targetBp: 3000,
		bp: 3120,
	},
}

const SUMMARY = {
	from: '2026-11-03',
	to: '2026-11-09',
	count: 3,
	valueMinor: 64_000,
	purchasesMinor: 2_000_000,
	currency: 'SAR',
	byReason: [
		{ reason: 'expired', count: 2, valueMinor: 40_000 },
		{ reason: 'dropped', count: 1, valueMinor: 24_000 },
	],
	byCategory: [],
	byDay: [],
	topItems: [],
}

function region(data: unknown, summary: unknown = SUMMARY) {
	return vi.fn<InventoryClient['request']>(async (path) => {
		if (path.startsWith('/today')) return data
		if (path.startsWith('/waste/summary')) return summary
		throw new Error(`unexpected request ${path}`)
	})
}

describe('Inventory Today', () => {
	it('shows a skeleton until the region answers', async () => {
		let resolve: (value: unknown) => void = () => {}
		const request = vi.fn(
			(path: string) =>
				new Promise<unknown>((done) => {
					if (path.startsWith('/today')) resolve = done
					else done(SUMMARY)
				}),
		)
		renderToday(request)
		expect(screen.getByTestId('inventory-today-loading')).toBeInTheDocument()
		expect(request).toHaveBeenCalledWith('/today?locationId=main')
		resolve(today())
		await screen.findByTestId('inventory-today')
	})

	it('shows the error with Try again, never made-up numbers', async () => {
		const request = vi
			.fn<InventoryClient['request']>()
			.mockRejectedValueOnce(
				new OperatorRequestError('down', 'inventory_unavailable', 503),
			)
			.mockImplementation(async (path) =>
				path.startsWith('/today') ? today() : SUMMARY,
			)
		renderToday(request)
		const alert = await screen.findByTestId('inventory-today-error')
		expect(alert).toHaveTextContent('Inventory is paused right now')
		expect(screen.queryByTestId('inventory-today')).toBeNull()
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
		await screen.findByTestId('inventory-today')
	})

	it('treats a malformed answer as an error', async () => {
		renderToday(vi.fn(async () => ({ items: 'lots' })))
		expect(
			await screen.findByTestId('inventory-today-error'),
		).toHaveTextContent('We could not load your inventory')
	})

	describe('setup checklist for a new organization', () => {
		it('shows the four steps with links to their screens', async () => {
			renderToday(
				region(
					today({
						setup: {
							items: 4,
							storageAreas: 0,
							approvedCounts: 0,
							deliveries: 0,
						},
					}),
				),
			)
			await screen.findByTestId('inventory-setup-checklist')
			expect(screen.getByTestId('inventory-setup-progress')).toHaveTextContent(
				'1 of 4 done',
			)
			expect(
				screen.getByTestId('inventory-setup-go-storage').getAttribute('href'),
			).toBe('/acme/inventory/stock')
			expect(
				screen.getByTestId('inventory-setup-go-count').getAttribute('href'),
			).toBe('/acme/inventory/counts')
			expect(
				screen.getByTestId('inventory-setup-go-delivery').getAttribute('href'),
			).toBe('/acme/inventory/purchasing')
		})

		it('shows no numbers before there is a single item', async () => {
			renderToday(
				region(
					today({
						setup: {
							items: 0,
							storageAreas: 0,
							approvedCounts: 0,
							deliveries: 0,
						},
					}),
				),
			)
			await screen.findByTestId('inventory-setup-checklist')
			expect(screen.queryByText('Items low')).toBeNull()
			expect(screen.queryByText('Stock value')).toBeNull()
			expect(screen.queryByTestId('today-attention')).toBeNull()
		})

		it('can be dismissed once complete', async () => {
			renderToday(region(today()))
			await screen.findByTestId('inventory-setup-complete')
			fireEvent.click(screen.getByTestId('inventory-setup-dismiss'))
			await waitFor(() =>
				expect(screen.queryByTestId('inventory-setup-complete')).toBeNull(),
			)
		})
	})

	describe('with the cost grant', () => {
		const ctx = { canSeeCost: true, canEdit: true, canManagePurchasing: true }

		it('shows stock value, food cost, waste and what to order', async () => {
			renderToday(region(today({ metrics: WITH_MONEY })), ctx)
			await screen.findByTestId('inventory-today')
			expect(screen.getByText('Stock value')).toBeInTheDocument()
			expect(screen.getByText(/18,420/)).toBeInTheDocument()
			expect(screen.getByText('Food cost')).toBeInTheDocument()
			expect(screen.getByText('31.2%')).toBeInTheDocument()
			expect(screen.getByText(/Target/)).toHaveTextContent('30%')
			expect(screen.getByText(/640/)).toBeInTheDocument()
			expect(screen.getByText(/2.4%/)).toBeInTheDocument()
			expect(screen.getByText('To order')).toBeInTheDocument()
			expect(screen.getByText('4 items')).toBeInTheDocument()
			// The quantity-only metrics are for people without the grant.
			expect(screen.queryByText('Items low')).toBeNull()
		})

		it('says in plain words why food cost is not there yet', async () => {
			renderToday(
				region(
					today({
						metrics: {
							...WITH_MONEY,
							foodCost: {
								state: 'need_two_counts',
								from: null,
								to: null,
								targetBp: 3000,
							},
						},
					}),
				),
				ctx,
			)
			await screen.findByTestId('inventory-today')
			expect(
				screen.getByText('Shows after two approved counts.'),
			).toBeInTheDocument()
		})

		it('says in plain words when there were no sales to compare', async () => {
			renderToday(
				region(
					today({
						metrics: {
							...WITH_MONEY,
							foodCost: {
								state: 'no_sales',
								from: '2026-11-01',
								to: '2026-11-08',
								targetBp: 3000,
							},
						},
					}),
				),
				ctx,
			)
			await screen.findByTestId('inventory-today')
			expect(
				screen.getByText('No sales between your last two counts.'),
			).toBeInTheDocument()
		})

		it('offers Start count and Record delivery in the header', async () => {
			renderTodayInChrome(region(today({ metrics: WITH_MONEY })), ctx)
			expect(await screen.findByTestId('today-start-count')).toHaveAttribute(
				'href',
				'/acme/inventory/counts?start=1',
			)
			expect(screen.getByTestId('today-record-delivery')).toHaveAttribute(
				'href',
				'/acme/inventory/purchasing/deliveries/new',
			)
		})

		it('offers no Record delivery without the cost grant, and no Start count without the update grant', async () => {
			renderTodayInChrome(region(today()), { canSeeCost: false, canEdit: true })
			await screen.findByTestId('today-start-count')
			expect(screen.queryByTestId('today-record-delivery')).toBeNull()
		})
	})

	describe('without the cost grant', () => {
		it('shows quantities only, and no money anywhere', async () => {
			renderToday(region(today()), { canSeeCost: false })
			await screen.findByTestId('inventory-today')
			expect(screen.getByText('Items low')).toBeInTheDocument()
			expect(screen.getByText('Out of stock')).toBeInTheDocument()
			expect(screen.getByText('Times wasted this week')).toBeInTheDocument()
			expect(screen.getByText('Last count')).toBeInTheDocument()
			expect(screen.queryByText('Stock value')).toBeNull()
			expect(screen.queryByText('Food cost')).toBeNull()
			expect(screen.queryByText(/SAR/)).toBeNull()
			expect(screen.getByText('Last count 3 days ago')).toBeInTheDocument()
		})

		it('says there is no count yet', async () => {
			renderToday(region(today({ metrics: { lastCountAt: null } })), {
				canSeeCost: false,
			})
			await screen.findByTestId('inventory-today')
			expect(screen.getByText('No count yet')).toBeInTheDocument()
		})

		it('ignores money the region should not have sent', async () => {
			renderToday(region(today({ metrics: WITH_MONEY })), {
				canSeeCost: false,
			})
			await screen.findByTestId('inventory-today')
			expect(screen.queryByText('Stock value')).toBeNull()
		})
	})

	describe('needs attention', () => {
		const ctx = { canSeeCost: true, canEdit: true, canManagePurchasing: true }

		const attention = [
			{
				kind: 'low_stock',
				itemId: 'i1',
				itemName: 'Chicken thighs',
				onHand: 2_000_000,
				countUnit: 'kg',
				baseUnit: 'g',
				status: 'low',
				supplierId: null,
				supplierName: null,
				more: 4,
			},
			{
				kind: 'low_stock',
				itemId: 'i2',
				itemName: 'Pita bread',
				onHand: 0,
				countUnit: null,
				baseUnit: 'piece',
				status: 'out',
				supplierId: null,
				supplierName: null,
				more: 0,
			},
			{ kind: 'count_due', date: '2026-11-09' },
			{ kind: 'count_due', date: '2026-11-08' },
			{
				kind: 'count_in_progress',
				countId: 'c1',
				itemsCounted: 32,
				itemTotal: 48,
			},
			{ kind: 'count_in_review', countId: 'c2' },
			{
				kind: 'price_rise',
				itemId: 'i3',
				itemName: 'Tomatoes',
				changeBp: 1400,
				deliveryId: 'd1',
				supplierName: 'Fresh Farms',
			},
			{
				kind: 'price_rise',
				itemId: 'i4',
				itemName: 'Onions',
				changeBp: 800,
				deliveryId: 'd2',
				supplierName: null,
			},
			{
				kind: 'unpaid_deliveries',
				count: 2,
				amountMinor: 421_000,
				currency: 'SAR',
			},
		]

		async function renderAttention(
			rows: unknown[],
			context: Partial<InventoryLayoutContext> = ctx,
		) {
			renderToday(region(today({ attention: rows })), context)
			return screen.findByTestId('today-attention')
		}

		it('says what is low in one sentence with one link', async () => {
			const list = await renderAttention([attention[0]])
			const row = within(list).getByTestId('today-attention-low_stock')
			expect(row).toHaveTextContent('Chicken thighs is running low: 2 kg left.')
			expect(row).toHaveTextContent('And 4 more items are low.')
			expect(
				within(row).getByTestId('today-attention-link-low_stock'),
			).toHaveAttribute('href', '/acme/inventory/stock?low=1')
		})

		it('says an item is out of stock', async () => {
			const list = await renderAttention([attention[1]])
			expect(list).toHaveTextContent('Pita bread is out of stock.')
		})

		it('a count due today points to starting one', async () => {
			const list = await renderAttention([attention[2]])
			expect(list).toHaveTextContent('A count is due today.')
			expect(
				screen.getByTestId('today-attention-link-count_due'),
			).toHaveAttribute('href', '/acme/inventory/counts?start=1')
		})

		it('a count that was due earlier says when', async () => {
			const list = await renderAttention([attention[3]])
			expect(list).toHaveTextContent('A count was due on')
		})

		it('a count due only offers to look to someone who cannot start one', async () => {
			await renderAttention([attention[2]], { ...ctx, canEdit: false })
			expect(
				screen.getByTestId('today-attention-link-count_due'),
			).toHaveAttribute('href', '/acme/inventory/counts')
			expect(
				screen.getByTestId('today-attention-link-count_due'),
			).toHaveTextContent('See counts')
		})

		it('a count in progress shows how far it got and resumes it', async () => {
			const list = await renderAttention([attention[4]])
			expect(list).toHaveTextContent(
				'A count is in progress: 32 of 48 items counted.',
			)
			expect(
				screen.getByTestId('today-attention-link-count_in_progress'),
			).toHaveAttribute('href', '/acme/inventory/counts/c1')
		})

		it('a count in review leads to its review', async () => {
			const list = await renderAttention([attention[5]])
			expect(list).toHaveTextContent('A count is waiting for review.')
			expect(
				screen.getByTestId('today-attention-link-count_in_review'),
			).toHaveAttribute('href', '/acme/inventory/counts/c2/review')
		})

		it('a price rise names the item, the percent and the supplier, and opens the delivery', async () => {
			const list = await renderAttention([attention[6], attention[7]])
			expect(list).toHaveTextContent(
				'Tomatoes went up 14% on the last delivery from Fresh Farms.',
			)
			expect(list).toHaveTextContent('Onions went up 8% on the last delivery.')
			expect(
				within(list).getAllByTestId('today-attention-link-price_rise')[0],
			).toHaveAttribute('href', '/acme/inventory/purchasing/deliveries/d1')
		})

		it('unpaid deliveries say what you owe, only with the cost grant', async () => {
			const list = await renderAttention([attention[8]])
			expect(list).toHaveTextContent('2 deliveries are unpaid.')
			expect(list).toHaveTextContent('You owe')
			expect(list).toHaveTextContent('4,210')
			expect(
				screen.getByTestId('today-attention-link-unpaid_deliveries'),
			).toHaveAttribute('href', '/acme/inventory/purchasing')
		})

		it('unpaid deliveries never show money to someone without the grant', async () => {
			const list = await renderAttention(
				[{ ...attention[8], amountMinor: undefined, currency: undefined }],
				{ ...ctx, canSeeCost: false },
			)
			expect(list).toHaveTextContent('2 deliveries are unpaid.')
			expect(list).not.toHaveTextContent('You owe')
		})

		it('keeps the location on every link when there are several', async () => {
			renderToday(region(today({ attention: [attention[0]] })), {
				...ctx,
				locations: [
					{ id: 'main', name: 'Olaya' },
					{ id: 'other', name: 'Malaz' },
				],
			})
			const link = await screen.findByTestId('today-attention-link-low_stock')
			expect(link.getAttribute('href')).toBe('/acme/inventory/stock?low=1')
		})

		it('says nothing needs you when there is nothing to do', async () => {
			renderToday(region(today({ attention: [] })), ctx)
			await screen.findByText('Nothing needs you right now')
			expect(screen.queryByTestId('today-attention')).toBeNull()
		})

		it('shows the count of rows in the title', async () => {
			renderToday(region(today({ attention: attention.slice(0, 3) })), ctx)
			await screen.findByTestId('today-attention')
			expect(screen.getByText('Needs attention (3)')).toBeInTheDocument()
		})
	})

	describe('this week and waste', () => {
		it('lists the next seven days', async () => {
			renderToday(
				region(
					today({
						week: [
							{
								date: '2026-11-12',
								kind: 'delivery',
								supplierId: 's1',
								supplierName: 'Al Watania',
							},
							{
								date: '2026-11-14',
								kind: 'count',
								supplierId: null,
								supplierName: null,
							},
						],
					}),
				),
			)
			const list = await screen.findByTestId('today-week')
			expect(list).toHaveTextContent('Delivery · Al Watania')
			expect(list).toHaveTextContent('Count')
		})

		it('says the week is quiet', async () => {
			renderToday(region(today()))
			await screen.findByTestId('today-week-empty')
		})

		it('draws waste by reason for the last seven days', async () => {
			const request = region(today())
			renderToday(request)
			await screen.findByTestId('today-waste-chart')
			const call = request.mock.calls.find(([path]) =>
				path.startsWith('/waste/summary'),
			)
			const params = new URLSearchParams(call![0].split('?')[1])
			const days =
				(Date.parse(params.get('to')!) - Date.parse(params.get('from')!)) /
				86_400_000
			expect(days).toBe(6)
		})

		it('says nothing was wasted, and survives the waste summary failing', async () => {
			renderToday(region(today(), { ...SUMMARY, count: 0, byReason: [] }))
			expect(await screen.findByTestId('today-waste-empty')).toBeInTheDocument()
		})

		it('keeps the page when only the waste summary fails', async () => {
			renderToday(
				vi.fn<InventoryClient['request']>(async (path) => {
					if (path.startsWith('/today')) return today()
					throw new OperatorRequestError('down', 'inventory_unavailable', 503)
				}),
			)
			await screen.findByTestId('inventory-today')
			await waitFor(() =>
				expect(screen.queryByTestId('today-waste-chart')).toBeNull(),
			)
			expect(screen.queryByTestId('inventory-today-error')).toBeNull()
		})
	})
})
