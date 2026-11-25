// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { renderInventory } from '#tests/inventory-render.tsx'
import { VarianceScreen } from './variance-screen.tsx'

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
	window.localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

const row = (over: Record<string, unknown> = {}) => ({
	itemId: 'flour',
	name: 'Flour',
	baseUnit: 'g',
	countUnit: 'kg',
	units: [],
	opening: 10_000_000,
	delivered: 5_000_000,
	transfers: 0,
	batchMade: 0,
	waste: 500_000,
	closing: 6_000_000,
	actualUse: 9_000_000,
	expectedUse: 8_000_000,
	gapQuantity: 1_000_000,
	noRecipe: false,
	actualUseMinor: 2700,
	expectedUseMinor: 2400,
	gapMinor: 300,
	gapBpOfSales: 150,
	trend: [
		{ closingCountId: 'v1', to: '2026-10-08', gapQuantity: 0, gapMinor: 0 },
		{
			closingCountId: 'v2',
			to: '2026-10-15',
			gapQuantity: 1_000_000,
			gapMinor: 300,
		},
	],
	...over,
})

const VARIANCE = {
	state: 'ok',
	period: {
		openingCountId: 'v1',
		closingCountId: 'v2',
		from: '2026-10-08',
		to: '2026-10-15',
		openingAt: 1,
		closingAt: 2,
	},
	periods: [
		{ closingCountId: 'v2', from: '2026-10-08', to: '2026-10-15' },
		{ closingCountId: 'v1', from: '2026-10-01', to: '2026-10-08' },
	],
	rows: [
		row(),
		row({
			itemId: 'spice',
			name: 'Secret spice',
			actualUse: 300_000,
			expectedUse: null,
			gapQuantity: null,
			noRecipe: true,
			actualUseMinor: 1500,
			expectedUseMinor: undefined,
			gapMinor: undefined,
			gapBpOfSales: undefined,
		}),
	],
	salesMinor: 200_000,
	totals: {
		actualMinor: 4200,
		expectedMinor: 2400,
		gapMinor: 1800,
		gapBpOfSales: 90,
		noRecipeUseMinor: 1500,
		wasteMinor: 150,
	},
	currency: 'SAR',
}

function region(over: Record<string, unknown> = {}) {
	return vi.fn<InventoryClient['request']>(async (path) => {
		if (path.startsWith('/variance/movements')) {
			return {
				itemId: 'flour',
				movements: [
					{
						id: 'm1',
						kind: 'waste',
						quantity: -500_000,
						valueMinor: -150,
						currency: 'SAR',
						reason: 'spoiled',
						sourceType: 'waste',
						businessDate: '2026-10-12',
						createdAt: 5,
					},
				],
				truncated: false,
			}
		}
		if (path.startsWith('/variance')) return { ...VARIANCE, ...over }
		throw new Error(`unexpected request ${path}`)
	})
}

const draw = (
	request: InventoryClient['request'],
	props: Partial<React.ComponentProps<typeof VarianceScreen>> = {},
) =>
	renderInventory(
		<VarianceScreen
			locationId="main"
			canSeeCost
			currency="SAR"
			closingCountId={null}
			onPeriodChange={vi.fn()}
			{...props}
		/>,
		{ request },
	)

describe('VarianceScreen (#509)', () => {
	it('shows each item its expected and actual use and the gap in quantity and money, and the totals', async () => {
		draw(region())
		const flour = await screen.findByTestId('variance-row-flour')
		expect(flour).toHaveTextContent('Flour')
		// 9 kg actual against 8 kg expected: a gap of 1 kg and SAR 3.00.
		expect(flour).toHaveTextContent('9 kg')
		expect(flour).toHaveTextContent('8 kg')
		expect(flour).toHaveTextContent('1 kg')
		expect(flour).toHaveTextContent('3.00')
		expect(flour).toHaveTextContent('1.5%')
		const totals = screen.getByTestId('variance-totals')
		expect(totals).toHaveTextContent('Actual food cost')
		expect(totals).toHaveTextContent('42.00')
		expect(totals).toHaveTextContent('Expected food cost')
		expect(totals).toHaveTextContent('24.00')
		// Total gap = actual - expected.
		expect(totals).toHaveTextContent('18.00')
	})

	it('shows an item no recipe uses with actual use only, marked "No recipe"', async () => {
		draw(region())
		const spice = await screen.findByTestId('variance-row-spice')
		expect(
			within(spice).getByTestId('variance-norecipe-spice'),
		).toHaveTextContent('No recipe')
		expect(spice).toHaveTextContent('0.3 kg')
		// The worst gap is first.
		const rows = screen.getAllByTestId(/^variance-row-/)
		expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
			'variance-row-flour',
			'variance-row-spice',
		])
	})

	it('opens the movements behind a row', async () => {
		const request = region()
		draw(request)
		await userEvent.click(await screen.findByTestId('variance-row-flour'))
		const list = await screen.findByTestId('variance-movements-flour')
		expect(list).toHaveTextContent('Waste')
		expect(list).toHaveTextContent('0.5 kg')
		expect(request.mock.calls.some(([p]) => p.includes('itemId=flour'))).toBe(
			true,
		)
	})

	it('leaves money out without the cost grant', async () => {
		const noMoney = {
			totals: undefined,
			salesMinor: undefined,
			currency: undefined,
			rows: [
				row({
					actualUseMinor: undefined,
					expectedUseMinor: undefined,
					gapMinor: undefined,
					gapBpOfSales: undefined,
					trend: [],
				}),
			],
		}
		draw(region(noMoney), { canSeeCost: false })
		const flour = await screen.findByTestId('variance-row-flour')
		expect(flour).toHaveTextContent('1 kg')
		expect(screen.queryByTestId('variance-totals')).toBeNull()
		expect(screen.queryByText(/SAR/)).toBeNull()
		expect(
			screen.queryByRole('columnheader', { name: 'Gap in money' }),
		).toBeNull()
	})

	it('changes the period, and asks for two counts when there are fewer', async () => {
		const onPeriodChange = vi.fn()
		draw(region(), { onPeriodChange })
		await screen.findByTestId('variance-table')
		await userEvent.click(screen.getByTestId('variance-period'))
		await userEvent.click(
			await screen.findByRole('option', { name: /Oct 1, 2026/ }),
		)
		await waitFor(() => expect(onPeriodChange).toHaveBeenCalledWith('v1'))
	})

	it('asks for two approved counts first', async () => {
		draw(
			region({ state: 'need_two_counts', period: null, periods: [], rows: [] }),
		)
		expect(await screen.findByText('Two counts are needed')).toBeVisible()
	})
})
