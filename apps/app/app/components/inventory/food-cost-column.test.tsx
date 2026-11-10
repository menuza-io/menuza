// @vitest-environment jsdom
import { recipeCostsRequestSchema } from '@repo/inventory'
import { Table, TableBody, TableHeader, TableRow } from '@repo/ui/table'
import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { type RecipeAccess } from '#app/hooks/use-recipe-access.ts'
import { renderInventory } from '#tests/inventory-render.tsx'
import {
	FoodCostCell,
	FoodCostFooterCell,
	FoodCostHead,
	FoodCostProvider,
} from './food-cost-column.tsx'

const access = vi.hoisted(() => ({
	current: {
		enabled: true,
		canEdit: false,
		canTypeCost: false,
		locationId: 'main',
	} as RecipeAccess,
}))
vi.mock('#app/hooks/use-recipe-access.ts', () => ({
	useRecipeAccess: () => access.current,
}))

beforeEach(() => {
	vi.clearAllMocks()
	access.current = {
		enabled: true,
		canEdit: false,
		canTypeCost: false,
		locationId: 'main',
	}
})

const ITEMS = [
	{ id: 'a', priceMajor: 22 },
	{ id: 'b', priceMajor: 10 },
	{ id: 'c', priceMajor: 0 },
	{ id: 'd', priceMajor: 8 },
]

function table(items = ITEMS) {
	return (
		<FoodCostProvider orgSlug="acme" dataRegion="ksa" items={items}>
			<Table>
				<TableHeader>
					<TableRow>
						<FoodCostHead />
					</TableRow>
				</TableHeader>
				<TableBody>
					{items.map((item) => (
						<TableRow key={item.id}>
							<FoodCostCell itemId={item.id} />
						</TableRow>
					))}
				</TableBody>
				<tfoot>
					<tr>
						<FoodCostFooterCell>count</FoodCostFooterCell>
					</tr>
				</tfoot>
			</Table>
		</FoodCostProvider>
	)
}

function region(
	costs: (body: unknown) => unknown = () => ({ rows: [], targetBp: 3000 }),
) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path === '/settings') {
			return {
				targetFoodCostBp: 3000,
				unitSystem: 'metric',
				countDayOfWeek: null,
				version: 1,
				updatedAt: null,
			}
		}
		if (path === '/recipes/costs') {
			return costs(JSON.parse(String(init?.body)))
		}
		throw new Error(`unexpected request ${path}`)
	})
}

describe('Food cost column', () => {
	it('asks once for the whole page and joins the rows by key', async () => {
		const request = region((body) => {
			expect(recipeCostsRequestSchema.safeParse(body).success).toBe(true)
			return {
				rows: [
					{
						key: 'a',
						hasRecipe: true,
						state: 'complete',
						costMinor: 655,
						currency: 'SAR',
						foodCostBp: 2977,
						status: 'good',
					},
					{
						key: 'b',
						hasRecipe: true,
						state: 'complete',
						costMinor: 500,
						currency: 'SAR',
						foodCostBp: 5000,
						status: 'high',
					},
					{ key: 'c', hasRecipe: false, state: 'none' },
					{ key: 'd', hasRecipe: true, state: 'unknown' },
				],
				targetBp: 3000,
			}
		})
		renderInventory(table(), { request })
		await waitFor(() =>
			expect(screen.getByTestId('food-cost-a')).toHaveTextContent('29.8%'),
		)
		expect(screen.getByTestId('food-cost-dot-good')).toBeInTheDocument()
		expect(screen.getByTestId('food-cost-b')).toHaveTextContent('50%')
		expect(screen.getByTestId('food-cost-dot-high')).toBeInTheDocument()
		// No recipe: a dash. A recipe with nothing priced: no number.
		expect(screen.getByTestId('food-cost-c')).toHaveTextContent('—')
		expect(screen.getByTestId('food-cost-d')).toHaveTextContent('Recipe set')
		expect(screen.getByTestId('food-cost-head')).toBeInTheDocument()

		const calls = request.mock.calls.filter(
			([path]) => path === '/recipes/costs',
		)
		expect(calls).toHaveLength(1)
		// Ids and the prices as shown: never names. A free dish sends no price.
		expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({
			refs: [
				{ key: 'a', itemId: 'a', priceMinor: 2200 },
				{ key: 'b', itemId: 'b', priceMinor: 1000 },
				{ key: 'c', itemId: 'c' },
				{ key: 'd', itemId: 'd', priceMinor: 800 },
			],
			currency: 'SAR',
		})
		// A POST that only reads must use the read token.
		expect(calls[0]![1]).toMatchObject({ readOnly: true })
	})

	it('shows nothing it was not given', async () => {
		const request = region(() => ({
			rows: [{ key: 'a', hasRecipe: true, state: 'complete' }],
			targetBp: 3000,
		}))
		renderInventory(table(ITEMS.slice(0, 1)), { request })
		await waitFor(() =>
			expect(screen.getByTestId('food-cost-a')).toHaveTextContent('Recipe set'),
		)
		expect(screen.queryByText(/SAR|%/)).toBeNull()
	})

	it('is hidden entirely, with no request, while recipes are off', () => {
		access.current = { ...access.current, enabled: false }
		const request = region()
		renderInventory(table(), { request })
		expect(screen.queryByTestId('food-cost-head')).toBeNull()
		expect(screen.queryByTestId('food-cost-a')).toBeNull()
		expect(request).not.toHaveBeenCalled()
	})

	it('goes away when the region says recipes are not available', async () => {
		const request = region(() => {
			throw new OperatorRequestError('no', 'feature_disabled', 404)
		})
		renderInventory(table(), { request })
		await waitFor(() =>
			expect(screen.queryByTestId('food-cost-head')).toBeNull(),
		)
		expect(screen.queryByTestId('food-cost-a')).toBeNull()
	})

	it('splits only beyond 200 dishes', async () => {
		const many = Array.from({ length: 250 }, (_, index) => ({
			id: `i${index}`,
			priceMajor: 5,
		}))
		const request = region()
		renderInventory(table(many), { request })
		await waitFor(() =>
			expect(
				request.mock.calls.filter(([path]) => path === '/recipes/costs'),
			).toHaveLength(2),
		)
		const sizes = request.mock.calls
			.filter(([path]) => path === '/recipes/costs')
			.map(
				([, init]) =>
					(JSON.parse(String(init?.body)) as { refs: unknown[] }).refs.length,
			)
		expect(sizes).toEqual([200, 50])
	})
})
