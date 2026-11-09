// @vitest-environment jsdom
import {
	putRecipeSchema,
	type Recipe,
	recipeResultSchema,
} from '@repo/inventory'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { type RecipeAccess } from '#app/hooks/use-recipe-access.ts'
import { stockItem } from '#tests/inventory-fixtures.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { OptionRecipePanel, RecipeAside, RecipePanel } from './recipe-panel.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const access = vi.hoisted(() => ({
	current: {
		enabled: true,
		canEdit: true,
		canTypeCost: true,
		locationId: 'main',
	} as RecipeAccess,
}))
vi.mock('#app/hooks/use-recipe-access.ts', () => ({
	useRecipeAccess: () => access.current,
}))

beforeEach(() => {
	vi.clearAllMocks()
	// cmdk (the item picker's list) measures with ResizeObserver; jsdom has none.
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	access.current = {
		enabled: true,
		canEdit: true,
		canTypeCost: true,
		locationId: 'main',
	}
})

const SETTINGS = {
	targetFoodCostBp: 3000,
	unitSystem: 'metric',
	countDayOfWeek: null,
	version: 1,
	updatedAt: null,
}

function recipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'r1',
		ownerKind: 'menu_item',
		ownerId: 'mi_1',
		version: 2,
		makesQuantity: null,
		multiplierBp: null,
		typedCostMinor: undefined,
		method: null,
		effectiveFrom: 0,
		createdAt: 0,
		lines: [
			{
				id: 'l1',
				itemId: 'itm_1',
				itemName: 'Chicken thighs',
				baseUnit: 'g',
				quantity: 180_000,
				usableBp: 8500,
				mode: 'add',
				replacesItemId: null,
				replacesItemName: null,
				sortOrder: 0,
				costMinor: 593,
				priced: true,
			},
			{
				id: 'l2',
				itemId: 'itm_2',
				itemName: 'Pita bread',
				baseUnit: 'piece',
				quantity: 1_000,
				usableBp: 10_000,
				mode: 'add',
				replacesItemId: null,
				replacesItemName: null,
				sortOrder: 1,
				priced: false,
			},
		],
		plate: {
			state: 'partial',
			costMinor: 593,
			currency: 'SAR',
			missingItemIds: ['itm_2'],
		},
		...overrides,
	}
}

function result(value: Recipe | null, version = value?.version ?? 0) {
	// The same parse the panel does: a fixture the contract would refuse is a bug here.
	return recipeResultSchema.parse({ recipe: value, version })
}

type Overrides = {
	get?: () => unknown
	put?: (body: unknown) => unknown
	clear?: (body: unknown) => unknown
	costs?: (body: unknown) => unknown
}

function region(overrides: Overrides = {}) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path === '/settings') return SETTINGS
		if (path.startsWith('/recipes?')) {
			return overrides.get ? overrides.get() : result(recipe())
		}
		if (path.startsWith('/items?')) {
			return {
				items: [
					stockItem({ id: 'itm_1' }),
					stockItem({
						id: 'itm_2',
						name: 'Pita bread',
						baseUnit: 'piece',
						countUnit: 'piece',
					}),
				],
				total: 2,
				nextCursor: null,
			}
		}
		const body = init?.body ? JSON.parse(String(init.body)) : undefined
		if (path === '/recipes' && init?.method === 'PUT') {
			return overrides.put
				? overrides.put(body)
				: result(recipe({ version: 3 }))
		}
		if (path === '/recipes/clear') {
			return overrides.clear ? overrides.clear(body) : result(null, 4)
		}
		if (path === '/recipes/costs') {
			return overrides.costs
				? overrides.costs(body)
				: { rows: [], targetBp: 3000 }
		}
		throw new Error(`unexpected request ${path}`)
	})
}

function panel(props: Partial<Parameters<typeof RecipePanel>[0]> = {}) {
	return (
		<RecipePanel
			orgSlug="acme"
			itemId="mi_1"
			dataRegion="ksa"
			priceMajor={22}
			{...props}
		/>
	)
}

describe('RecipePanel visibility', () => {
	it('renders nothing and calls nothing while recipes are off or not permitted', () => {
		access.current = { ...access.current, enabled: false }
		const request = region()
		const { container } = renderInventory(panel(), { request })
		expect(container.querySelector('[data-testid="recipe-panel"]')).toBeNull()
		expect(request).not.toHaveBeenCalled()
	})

	it('explains that ingredients come after saving a new item', async () => {
		const request = region()
		renderInventory(panel({ itemId: null }), { request })
		expect(
			await screen.findByTestId('recipe-panel-new-note'),
		).toHaveTextContent('Save this item first')
		expect(request).not.toHaveBeenCalled()
	})

	it.each([
		['forbidden', 403],
		['feature_disabled', 404],
		['not_found', 404],
	])('disappears when the region answers %s (%i)', async (code, status) => {
		const request = region({
			get: () => {
				throw new OperatorRequestError('no', code, status)
			},
		})
		renderInventory(panel(), { request })
		await waitFor(() => expect(screen.queryByTestId('recipe-panel')).toBeNull())
		expect(screen.queryByText(/could not load/i)).toBeNull()
	})

	it('shows an error with a retry for any other failure', async () => {
		let attempts = 0
		const request = region({
			get: () => {
				attempts += 1
				if (attempts === 1) throw new Error('network')
				return result(recipe())
			},
		})
		renderInventory(panel(), { request })
		await userEvent.click(
			await screen.findByRole('button', { name: 'Try again' }),
		)
		expect(await screen.findByTestId('recipe-line-0')).toBeInTheDocument()
	})

	it('is read-only without the recipe grant', async () => {
		access.current = { ...access.current, canEdit: false }
		renderInventory(panel(), { request: region() })
		expect(await screen.findByTestId('recipe-line-0')).toBeInTheDocument()
		expect(screen.queryByTestId('recipe-save')).toBeNull()
		expect(screen.queryByTestId('recipe-add')).toBeNull()
		expect(screen.queryByTestId('recipe-clear')).toBeNull()
		expect(screen.queryByTestId('recipe-line-0-remove')).toBeNull()
		expect(screen.getByTestId('recipe-line-0-usable')).toBeDisabled()
	})
})

describe('RecipePanel cost and states', () => {
	it('shows cost, price, food cost, target and the price for the target', async () => {
		const full = recipe({
			lines: recipe().lines.map((line) => ({ ...line, priced: true })),
			plate: {
				state: 'complete',
				costMinor: 655,
				currency: 'SAR',
				missingItemIds: [],
			},
		})
		renderInventory(panel(), { request: region({ get: () => result(full) }) })
		const summary = await screen.findByTestId('recipe-summary')
		await waitFor(() =>
			expect(within(summary).getByText('Target')).toBeInTheDocument(),
		)
		expect(screen.getByTestId('recipe-cost')).toHaveTextContent('6.55')
		expect(screen.getByTestId('recipe-price')).toHaveTextContent('22.00')
		expect(screen.getByTestId('recipe-food-cost')).toHaveTextContent('29.8%')
		expect(screen.getByTestId('food-cost-dot-good')).toBeInTheDocument()
		expect(screen.getByTestId('recipe-price-for-target')).toHaveTextContent(
			'21.83',
		)
	})

	it('says how many ingredients have no price yet', async () => {
		renderInventory(panel(), { request: region() })
		expect(await screen.findByTestId('recipe-unpriced')).toHaveTextContent(
			'1 ingredient has no price yet: add a delivery to price it.',
		)
		expect(screen.getByText('Cost to make (at least)')).toBeInTheDocument()
		expect(screen.getByTestId('recipe-line-1-cost')).toHaveTextContent(
			'No price yet',
		)
	})

	it('shows no money at all when the region left it out', async () => {
		const noMoney = recipe({
			lines: recipe().lines.map(({ costMinor, ...line }) => {
				void costMinor
				return line
			}),
			plate: undefined,
		})
		renderInventory(panel(), {
			request: region({ get: () => result(noMoney) }),
		})
		await screen.findByTestId('recipe-line-0')
		expect(screen.queryByTestId('recipe-summary')).toBeNull()
		expect(screen.queryByTestId('recipe-line-0-cost')).toHaveTextContent('')
		expect(screen.queryByText(/SAR|\$|0\.00/)).toBeNull()
	})

	it('invites the first ingredient when there is no recipe yet', async () => {
		renderInventory(panel(), {
			request: region({ get: () => result(null, 0) }),
		})
		expect(await screen.findByTestId('recipe-none')).toHaveTextContent(
			'No ingredients yet.',
		)
		expect(screen.queryByTestId('recipe-clear')).toBeNull()
		expect(screen.getByTestId('recipe-save')).toBeDisabled()
	})
})

describe('RecipePanel saving', () => {
	it('saves the edit with the loaded version, ids and numbers only', async () => {
		const request = region()
		renderInventory(panel(), { request })
		const amount = await screen.findByTestId('recipe-line-0-amount')
		await userEvent.clear(amount)
		await userEvent.type(amount, '200')
		const usable = screen.getByTestId('recipe-line-0-usable')
		await userEvent.clear(usable)
		await userEvent.type(usable, '90')
		await userEvent.click(screen.getByTestId('recipe-save'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Ingredients saved.'),
		)
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/recipes' && init?.method === 'PUT',
		)
		const sent = sentJson(request, index)
		expect(sent).toEqual({
			ownerKind: 'menu_item',
			ownerId: 'mi_1',
			expectedVersion: 2,
			lines: [
				{
					itemId: 'itm_1',
					amount: 200,
					unit: 'g',
					usableBp: 9000,
					mode: 'add',
				},
				{
					itemId: 'itm_2',
					amount: 1,
					unit: 'piece',
					usableBp: 10_000,
					mode: 'add',
				},
			],
		})
		expect(putRecipeSchema.safeParse(sent).success).toBe(true)
		expect(JSON.stringify(sent)).not.toMatch(/Chicken|Pita/)
	})

	it('adds an ingredient from the item picker', async () => {
		const request = region({ get: () => result(null, 0) })
		renderInventory(panel(), { request })
		await userEvent.click(await screen.findByTestId('recipe-add'))
		await userEvent.click(screen.getByTestId('recipe-line-0-item'))
		await userEvent.click(
			await screen.findByTestId('recipe-line-0-item-option-itm_1'),
		)
		await userEvent.type(screen.getByTestId('recipe-line-0-amount'), '150')
		await userEvent.click(screen.getByTestId('recipe-save'))
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/recipes' && init?.method === 'PUT',
		)
		expect(sentJson(request, index)).toEqual({
			ownerKind: 'menu_item',
			ownerId: 'mi_1',
			expectedVersion: 0,
			lines: [
				{
					itemId: 'itm_1',
					amount: 150,
					unit: 'g',
					usableBp: 10_000,
					mode: 'add',
				},
			],
		})
	})

	it('refuses to save an incomplete row and says why', async () => {
		const request = region({ get: () => result(null, 0) })
		renderInventory(panel(), { request })
		await userEvent.click(await screen.findByTestId('recipe-add'))
		await userEvent.click(screen.getByTestId('recipe-save'))
		expect(
			await screen.findAllByText('Choose an ingredient.'),
		).not.toHaveLength(0)
		expect(request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(
			false,
		)
	})

	it('saves a typed cost when the member may type one', async () => {
		const request = region({ get: () => result(null, 0) })
		renderInventory(panel(), { request })
		await userEvent.click(await screen.findByTestId('recipe-use-typed'))
		await userEvent.type(screen.getByTestId('recipe-typed-cost'), '4.50')
		await userEvent.click(screen.getByTestId('recipe-save'))
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/recipes' && init?.method === 'PUT',
		)
		expect(sentJson(request, index)).toMatchObject({
			lines: [],
			typedCost: { minor: 450, currency: 'SAR' },
		})
	})

	it('does not offer a typed cost without the cost grant', async () => {
		access.current = { ...access.current, canTypeCost: false }
		renderInventory(panel(), {
			request: region({ get: () => result(null, 0) }),
		})
		await screen.findByTestId('recipe-add')
		expect(screen.queryByTestId('recipe-use-typed')).toBeNull()
	})

	it('reloads when someone saved first and says so', async () => {
		let gets = 0
		const request = region({
			get: () => {
				gets += 1
				return gets === 1 ? result(recipe()) : result(recipe({ version: 5 }))
			},
			put: () => {
				throw new OperatorRequestError('stale', 'stale_version', 409)
			},
		})
		renderInventory(panel(), { request })
		const amount = await screen.findByTestId('recipe-line-0-amount')
		await userEvent.clear(amount)
		await userEvent.type(amount, '210')
		await userEvent.click(screen.getByTestId('recipe-save'))
		expect(await screen.findByTestId('recipe-stale')).toHaveTextContent(
			'Someone changed this while you were editing',
		)
		await waitFor(() => expect(gets).toBe(2))
		// The next save uses the version that was just loaded.
		await waitFor(() =>
			expect(screen.getByTestId('recipe-line-0-amount')).toHaveValue('180'),
		)
	})

	it('maps a loop to a friendly sentence', async () => {
		const request = region({
			put: () => {
				throw new OperatorRequestError('cycle', 'recipe_cycle', 400)
			},
		})
		renderInventory(panel(), { request })
		const amount = await screen.findByTestId('recipe-line-0-amount')
		await userEvent.clear(amount)
		await userEvent.type(amount, '210')
		await userEvent.click(screen.getByTestId('recipe-save'))
		expect(await screen.findByTestId('recipe-save-error')).toHaveTextContent(
			'it loops',
		)
		expect(screen.getByTestId('recipe-panel')).toBeInTheDocument()
	})

	it('clears the recipe only after a confirmation', async () => {
		const request = region()
		renderInventory(panel(), { request })
		await userEvent.click(await screen.findByTestId('recipe-clear'))
		expect(screen.getByText('Clear this recipe?')).toBeInTheDocument()
		expect(request.mock.calls.some(([path]) => path === '/recipes/clear')).toBe(
			false,
		)
		await userEvent.click(screen.getByTestId('recipe-clear-confirm'))
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith('Recipe cleared.'),
		)
		const index = request.mock.calls.findIndex(
			([path]) => path === '/recipes/clear',
		)
		expect(sentJson(request, index)).toEqual({
			ownerKind: 'menu_item',
			ownerId: 'mi_1',
			expectedVersion: 2,
		})
	})

	it('does not submit the surrounding form on Enter', async () => {
		const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
		renderInventory(<form onSubmit={onSubmit}>{panel()}</form>, {
			request: region(),
		})
		const usable = await screen.findByTestId('recipe-line-0-usable')
		await userEvent.type(usable, '{Enter}')
		expect(onSubmit).not.toHaveBeenCalled()
	})
})

describe('RecipePanel sizes', () => {
	const variants = [
		{ id: 'v_s', label: 'Small', priceMajor: 15 },
		{ id: 'v_l', label: 'Large', priceMajor: 25 },
	]

	it('costs every size in one call and edits a size as a multiple', async () => {
		const request = region({
			costs: (body) => {
				expect(body).toMatchObject({
					refs: [
						{ key: 'v_s', itemId: 'mi_1', variantId: 'v_s' },
						{ key: 'v_l', itemId: 'mi_1', variantId: 'v_l' },
					],
				})
				return {
					rows: [
						{
							key: 'v_s',
							hasRecipe: true,
							state: 'complete',
							costMinor: 400,
							currency: 'SAR',
						},
						{
							key: 'v_l',
							hasRecipe: true,
							state: 'complete',
							costMinor: 800,
							currency: 'SAR',
						},
					],
					targetBp: 3000,
				}
			},
			get: () => result(recipe()),
		})
		// Sizes read their own recipe only when opened.
		const original = request.getMockImplementation()!
		request.mockImplementation(async (path, init) => {
			if (path.includes('ownerKind=variant')) return result(null, 0)
			return original(path, init)
		})
		renderInventory(panel({ variants }), { request })
		const small = await screen.findByTestId('recipe-size-v_s')
		await waitFor(() => expect(small).toHaveTextContent('4.00'))
		expect(
			request.mock.calls.filter(([path]) => path === '/recipes/costs'),
		).toHaveLength(1)
		expect(
			request.mock.calls.some(([path]) => path.includes('ownerKind=variant')),
		).toBe(false)

		await userEvent.click(screen.getByTestId('recipe-size-v_s-toggle'))
		const multiplier = await screen.findByTestId('recipe-size-v_s-multiplier')
		expect(multiplier).toHaveValue('1')
		await userEvent.clear(multiplier)
		await userEvent.type(multiplier, '1.5')
		await userEvent.click(screen.getByTestId('recipe-size-v_s-save'))
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/recipes' && init?.method === 'PUT',
		)
		const sent = sentJson(request, index)
		expect(sent).toEqual({
			ownerKind: 'variant',
			ownerId: 'v_s',
			expectedVersion: 0,
			lines: [],
			multiplierBp: 15_000,
		})
		expect(putRecipeSchema.safeParse(sent).success).toBe(true)
	})
})

describe('OptionRecipePanel', () => {
	it('saves a replace line with what it replaces and notes the pizza halves', async () => {
		const request = region({ get: () => result(null, 0) })
		renderInventory(
			<OptionRecipePanel
				orgSlug="acme"
				optionId="opt_1"
				dataRegion="ksa"
				isTopping
			/>,
			{ request },
		)
		expect(
			await screen.findByText('Half pizzas use half of this.'),
		).toBeInTheDocument()
		await userEvent.click(
			await screen.findByTestId('option-recipe-add-replace'),
		)
		await userEvent.click(screen.getByTestId('option-recipe-line-0-replaces'))
		await userEvent.click(
			await screen.findByTestId('option-recipe-line-0-replaces-option-itm_1'),
		)
		await userEvent.click(screen.getByTestId('option-recipe-line-0-item'))
		await userEvent.click(
			await screen.findByTestId('option-recipe-line-0-item-option-itm_2'),
		)
		await userEvent.type(screen.getByTestId('option-recipe-line-0-amount'), '1')
		await userEvent.click(screen.getByTestId('option-recipe-save'))
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path, init]) => path === '/recipes' && init?.method === 'PUT',
		)
		const sent = sentJson(request, index)
		expect(sent).toEqual({
			ownerKind: 'option',
			ownerId: 'opt_1',
			expectedVersion: 0,
			lines: [
				{
					itemId: 'itm_2',
					amount: 1,
					unit: 'piece',
					usableBp: 10_000,
					mode: 'replace',
					replacesItemId: 'itm_1',
				},
			],
		})
		expect(putRecipeSchema.safeParse(sent).success).toBe(true)
	})

	it('has no pizza note for a plain option and nothing while off', async () => {
		const { unmount } = renderInventory(
			<OptionRecipePanel
				orgSlug="acme"
				optionId="opt_1"
				dataRegion="ksa"
				isTopping={false}
			/>,
			{ request: region({ get: () => result(null, 0) }) },
		)
		await screen.findByTestId('option-recipe-add')
		expect(screen.queryByText('Half pizzas use half of this.')).toBeNull()
		unmount()
		access.current = { ...access.current, enabled: false }
		const request = region()
		renderInventory(
			<OptionRecipePanel
				orgSlug="acme"
				optionId="opt_1"
				dataRegion="ksa"
				isTopping={false}
			/>,
			{ request },
		)
		expect(screen.queryByTestId('option-recipe-panel')).toBeNull()
		expect(request).not.toHaveBeenCalled()
	})
})

describe('RecipeAside', () => {
	it('shows cost and the food cost for the price as typed, from one costs call', async () => {
		const request = region({
			costs: () => ({
				rows: [
					{
						key: 'item',
						hasRecipe: true,
						state: 'complete',
						costMinor: 655,
						currency: 'SAR',
					},
				],
				targetBp: 3000,
			}),
		})
		renderInventory(
			<RecipeAside
				itemId="mi_1"
				dataRegion="ksa"
				priceMajor={22}
				hasSizes={false}
			/>,
			{ request },
		)
		expect(await screen.findByTestId('recipe-aside-cost')).toHaveTextContent(
			'6.55',
		)
		expect(screen.getByTestId('recipe-aside-food-cost')).toHaveTextContent(
			'29.8%',
		)
		expect(
			request.mock.calls.filter(([path]) => path === '/recipes/costs'),
		).toHaveLength(1)
	})

	it('renders nothing when the region sends no money or no recipe', async () => {
		const request = region({
			costs: () => ({
				rows: [{ key: 'item', hasRecipe: true, state: 'complete' }],
				targetBp: 3000,
			}),
		})
		renderInventory(
			<RecipeAside
				itemId="mi_1"
				dataRegion="ksa"
				priceMajor={22}
				hasSizes={false}
			/>,
			{ request },
		)
		await waitFor(() =>
			expect(
				request.mock.calls.some(([path]) => path === '/recipes/costs'),
			).toBe(true),
		)
		expect(screen.queryByTestId('recipe-aside')).toBeNull()
	})
})
