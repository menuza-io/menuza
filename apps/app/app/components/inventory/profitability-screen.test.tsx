// @vitest-environment jsdom
import { dishProfitabilityRequestSchema } from '@repo/inventory'
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderInventory } from '#tests/inventory-render.tsx'
import { ProfitabilityScreen } from './profitability-screen.tsx'

const DISHES = [
	{
		id: 'star',
		name: 'Burger',
		price: 15,
		categoryKey: 'mains',
		categoryName: 'Mains',
	},
	{
		id: 'work',
		name: 'Pasta',
		price: 10,
		categoryKey: 'mains',
		categoryName: 'Mains',
	},
	{
		id: 'none',
		name: 'Soup',
		price: 6,
		categoryKey: 'starters',
		categoryName: 'Starters',
	},
]

const row = (
	itemId: string,
	group: 'keep' | 'reprice' | 'promote' | 'rethink',
	over: Record<string, unknown> = {},
) => ({
	itemId,
	categoryKey: 'mains',
	quantity: 40,
	salesMinor: 60000,
	priceMinor: 1500,
	costMinor: 500,
	unitMarginMinor: 1000,
	marginMinor: 40000,
	popularityPercent: 50,
	popular: true,
	earnsWell: true,
	group,
	suggestion: {
		foodCostBp: 3333,
		targetBp: 3000,
		priceForTargetMinor: 1667,
		overTarget: true,
	},
	...over,
})

const result = {
	currency: 'USD',
	targetBp: 3000,
	fromDate: '2026-11-01',
	toDate: '2026-11-30',
	dishes: [
		row('star', 'keep', {
			suggestion: {
				foodCostBp: 2500,
				targetBp: 3000,
				priceForTargetMinor: 1667,
				overTarget: false,
			},
		}),
		row('work', 'reprice', { marginMinor: 8000, unitMarginMinor: 200 }),
	],
	unlisted: [
		{ itemId: 'none', quantity: 7, salesMinor: 4200, reason: 'no_recipe' },
	],
	totals: { quantity: 80, salesMinor: 120000, marginMinor: 48000 },
	truncated: false,
}

describe('ProfitabilityScreen (#519)', () => {
	it('labels each dish with a recipe in one of four groups, with a suggestion, and lists the rest apart', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			expect(path).toBe('/recipes/profitability')
			expect(
				dishProfitabilityRequestSchema.safeParse(JSON.parse(String(init?.body)))
					.success,
			).toBe(true)
			return result
		})
		renderInventory(
			<ProfitabilityScreen locationId="loc_1" currency="USD" dishes={DISHES} />,
			{ request },
		)
		await screen.findByTestId('profitability-screen')
		expect(screen.getByTestId('profit-group-star')).toHaveTextContent('Keep')
		expect(screen.getByTestId('profit-group-work')).toHaveTextContent(
			'Re-price',
		)
		// Over its target food cost: the price that hits the target.
		expect(screen.getByTestId('profit-row-work')).toHaveTextContent(
			'Food cost 33%, target 30%: the price that hits target is $16.67.',
		)
		expect(screen.getByTestId('profit-row-star')).toHaveTextContent(
			'Popular and earns well. Keep it as it is.',
		)
		// A dish with no recipe is listed apart and never labelled.
		const unlisted = screen.getByTestId('profit-unlisted')
		expect(unlisted).toHaveTextContent('Soup')
		expect(unlisted).toHaveTextContent('7 sold')
		expect(screen.queryByTestId('profit-group-none')).toBeNull()
		// The dishes sent carry ids, prices and categories, never names.
		const body = JSON.parse(String(request.mock.calls[0]![1]!.body))
		expect(JSON.stringify(body)).not.toContain('Burger')
	})

	it('says why, and shows no figures, when the region refuses (no cost grant)', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => {
			throw new OperatorRequestError('forbidden', 'forbidden', 403, {
				code: 'forbidden',
			})
		})
		renderInventory(
			<ProfitabilityScreen locationId="loc_1" currency="USD" dishes={DISHES} />,
			{ request },
		)
		await waitFor(() =>
			expect(screen.getByTestId('profitability-error')).toBeInTheDocument(),
		)
		expect(screen.queryByTestId('profit-row-star')).toBeNull()
	})
})
