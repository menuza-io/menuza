// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { stockItem } from '#tests/inventory-fixtures.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { LogWasteDialog } from './log-waste-dialog.tsx'

const showUndoToast = vi.hoisted(() => vi.fn())
vi.mock('#app/components/undo-toast.ts', () => ({ showUndoToast }))

const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
	// cmdk measures and scrolls its list; jsdom has neither API.
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
	showUndoToast.mockReset()
	window.localStorage.clear()
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

const CHICKEN = stockItem({
	costMicro: 2_800_000,
	valueMinor: 16_800,
	currency: 'SAR',
})

function region(
	handlers: {
		waste?: () => unknown
		undo?: () => unknown
	} = {},
) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.startsWith('/items?')) {
			return { items: [CHICKEN], total: 1, nextCursor: null }
		}
		if (path.startsWith('/items/itm_1')) return CHICKEN
		if (path === '/waste' && init?.method === 'POST') {
			return (
				handlers.waste?.() ?? {
					accepted: [
						{ clientId: 'x', id: 'w1', quantity: 2_300_000, valueMinor: 64 },
					],
					duplicates: [],
				}
			)
		}
		if (path === '/waste/w1/undo') return handlers.undo?.() ?? {}
		throw new Error(`unexpected request ${path}`)
	})
}

function setup(
	request: InventoryClient['request'],
	props: { canSeeCost?: boolean } = {},
) {
	const onOpenChange = vi.fn()
	renderInventory(
		<LogWasteDialog
			open
			onOpenChange={onOpenChange}
			orgSlug="acme"
			locationId="main"
			canSeeCost={props.canSeeCost ?? true}
			currency="SAR"
			userName="Sara"
		/>,
		{ request },
	)
	return { onOpenChange }
}

async function chooseChicken() {
	await userEvent.click(screen.getByTestId('log-waste-item'))
	await userEvent.click(
		await screen.findByTestId('log-waste-item-option-itm_1'),
	)
}

describe('LogWasteDialog', () => {
	it('logs an item with its amount and reason, then offers Undo', async () => {
		const request = region()
		const { onOpenChange } = setup(request)
		expect(screen.getByTestId('log-waste-actor')).toHaveTextContent(
			'Logged as Sara',
		)

		await chooseChicken()
		// The amount starts in the item's count unit.
		expect(screen.getByTestId('log-waste-unit-kg')).toHaveAttribute(
			'aria-pressed',
			'true',
		)
		await userEvent.type(screen.getByTestId('log-waste-amount'), '2.3')
		await userEvent.click(screen.getByTestId('log-waste-reason-expired'))
		expect(screen.getByTestId('log-waste-cost')).toHaveTextContent('64.40')

		await userEvent.click(screen.getByTestId('log-waste-submit'))
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))

		const call = request.mock.calls.find(([path]) => path === '/waste')!
		expect(call[1]?.method).toBe('POST')
		const body = sentJson(request, request.mock.calls.indexOf(call)) as {
			entries: Array<Record<string, unknown>>
		}
		expect(body.entries).toEqual([
			{
				clientId: expect.stringMatching(/^w-[A-Za-z0-9_-]{8,}$/),
				locationId: 'main',
				itemId: 'itm_1',
				amount: 2.3,
				unit: 'kg',
				reason: 'expired',
			},
		])

		expect(showUndoToast).toHaveBeenCalledTimes(1)
		const toastOptions = showUndoToast.mock.calls[0]![0] as {
			message: string
			onUndo: () => Promise<void>
		}
		expect(toastOptions.message).toBe('Waste logged: Chicken thighs, 2.3 kg')
		await toastOptions.onUndo()
		expect(request).toHaveBeenCalledWith(
			'/waste/w1/undo',
			expect.objectContaining({ method: 'POST' }),
		)
		const undoIndex = request.mock.calls.findIndex(
			([path]) => path === '/waste/w1/undo',
		)
		expect(sentJson(request, undoIndex)).toEqual({
			clientId: expect.stringMatching(/^u-/),
		})
	})

	it('asks for what is missing and sends nothing', async () => {
		const request = region()
		setup(request)
		await userEvent.click(screen.getByTestId('log-waste-submit'))
		expect(screen.getByText('Choose an item.')).toBeInTheDocument()
		expect(screen.getByText('Enter an amount above zero.')).toBeInTheDocument()
		expect(screen.getByText('Choose why it was wasted.')).toBeInTheDocument()
		expect(request.mock.calls.some(([path]) => path === '/waste')).toBe(false)
	})

	it('keeps the form with a retry after a failed save, and replays the same key', async () => {
		let attempts = 0
		const request = region({
			waste: () => {
				attempts += 1
				if (attempts === 1) {
					throw new OperatorRequestError('down', 'inventory_unavailable', 503)
				}
				return {
					accepted: [{ clientId: 'x', id: 'w1', quantity: 1_000_000 }],
					duplicates: [],
				}
			},
		})
		const { onOpenChange } = setup(request)
		await chooseChicken()
		await userEvent.type(screen.getByTestId('log-waste-amount'), '1')
		await userEvent.click(screen.getByTestId('log-waste-reason-spoiled'))
		await userEvent.click(screen.getByTestId('log-waste-submit'))

		expect(await screen.findByTestId('log-waste-error')).toHaveTextContent(
			'Inventory is paused right now',
		)
		expect(onOpenChange).not.toHaveBeenCalled()

		await userEvent.click(screen.getByTestId('log-waste-submit'))
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
		const posts = request.mock.calls
			.map((_, index) => index)
			.filter((index) => request.mock.calls[index]![0] === '/waste')
		expect(posts).toHaveLength(2)
		const first = sentJson(request, posts[0]!) as {
			entries: [{ clientId: string }]
		}
		const second = sentJson(request, posts[1]!) as {
			entries: [{ clientId: string }]
		}
		expect(second.entries[0].clientId).toBe(first.entries[0].clientId)
	})

	it('leaves out the cost without the cost grant', async () => {
		setup(region(), { canSeeCost: false })
		await chooseChicken()
		await userEvent.type(screen.getByTestId('log-waste-amount'), '2')
		expect(screen.queryByTestId('log-waste-cost')).toBeNull()
	})

	it('offers recent items as chips and fills the item from one', async () => {
		window.localStorage.setItem(
			'inventory-waste-recent:acme:main',
			JSON.stringify([{ id: 'itm_1', name: 'Chicken thighs' }]),
		)
		const request = region()
		setup(request)
		await userEvent.click(await screen.findByTestId('log-waste-recent-itm_1'))
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/items/itm_1?locationId=main'),
		)
		expect(await screen.findByTestId('log-waste-unit-kg')).toBeInTheDocument()
		expect(screen.getByTestId('log-waste-item')).toHaveTextContent(
			'Chicken thighs',
		)
	})
})

describe('LogWasteDialog: dishes (#517)', () => {
	const DISHES = [
		{
			id: 'dish_shawarma',
			name: 'Chicken shawarma',
			variants: [{ id: 'var_large', label: 'Large' }],
			groups: [
				{
					id: 'grp_extras',
					name: 'Extras',
					options: [{ id: 'opt_cheese', name: 'Extra cheese' }],
				},
			],
		},
		{ id: 'dish_falafel', name: 'Falafel wrap', variants: [], groups: [] },
	]

	function setupDishes(
		request: InventoryClient['request'],
		props: { dishesEnabled?: boolean } = {},
	) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ dishes: DISHES })),
		)
		const onOpenChange = vi.fn()
		renderInventory(
			<LogWasteDialog
				open
				onOpenChange={onOpenChange}
				orgSlug="acme"
				locationId="main"
				dishesEnabled={props.dishesEnabled ?? true}
				canSeeCost
				currency="SAR"
				userName="Sara"
			/>,
			{ request },
		)
		return { onOpenChange }
	}

	it('has no Dishes filter without recipes', () => {
		setupDishes(region(), { dishesEnabled: false })
		expect(screen.queryByTestId('log-waste-mode-dishes')).toBeNull()
	})

	it('logs a dish with its size and options as one grouped waste and offers Undo for the whole group', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			if (path === '/waste/dishes' && init?.method === 'POST') {
				return {
					id: 'grp1',
					entries: 3,
					basis: 'recipe',
					duplicate: false,
					valueMinor: 2460,
					currency: 'SAR',
				}
			}
			if (path === '/waste/dishes/grp1/undo') return { id: 'grp1', entries: 3 }
			throw new Error(`unexpected request ${path}`)
		})
		const { onOpenChange } = setupDishes(request)
		await userEvent.click(screen.getByTestId('log-waste-mode-dishes'))
		await userEvent.type(await screen.findByTestId('log-dish-search'), 'shaw')
		// Only dishes that match are offered.
		expect(screen.queryByTestId('log-dish-option-dish_falafel')).toBeNull()
		await userEvent.click(
			await screen.findByTestId('log-dish-option-dish_shawarma'),
		)
		await userEvent.click(screen.getByTestId('log-dish-variant-var_large'))
		await userEvent.click(screen.getByTestId('log-dish-extra-opt_cheese'))
		const quantity = screen.getByTestId('log-dish-quantity')
		await userEvent.clear(quantity)
		await userEvent.type(quantity, '2')
		await userEvent.click(screen.getByTestId('log-dish-reason-dropped'))
		await userEvent.click(screen.getByTestId('log-dish-submit'))
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))

		const index = request.mock.calls.findIndex(([p]) => p === '/waste/dishes')
		expect(sentJson(request, index)).toEqual({
			clientId: expect.stringMatching(/^wd-/),
			locationId: 'main',
			menuItemId: 'dish_shawarma',
			variantId: 'var_large',
			options: [{ optionId: 'opt_cheese' }],
			quantity: 2,
			reason: 'dropped',
		})
		// The toast reads "2 x Chicken shawarma" and its Undo takes the whole group back.
		const toastArgs = showUndoToast.mock.calls[0]![0] as {
			message: string
			onUndo: () => Promise<void>
		}
		expect(toastArgs.message).toContain('2 x Chicken shawarma')
		await toastArgs.onUndo()
		expect(request).toHaveBeenCalledWith('/waste/dishes/grp1/undo', {
			method: 'POST',
			body: expect.stringContaining('"clientId"'),
		})
	})

	it('says to add a recipe first when the dish has none, and keeps the form', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => {
			throw new OperatorRequestError('nope', 'recipe_missing', 409)
		})
		const { onOpenChange } = setupDishes(request)
		await userEvent.click(screen.getByTestId('log-waste-mode-dishes'))
		await userEvent.click(
			await screen.findByTestId('log-dish-option-dish_falafel'),
		)
		await userEvent.click(screen.getByTestId('log-dish-reason-spoiled'))
		await userEvent.click(screen.getByTestId('log-dish-submit'))
		expect(await screen.findByTestId('log-dish-error')).toHaveTextContent(
			'Add a recipe first',
		)
		expect(onOpenChange).not.toHaveBeenCalledWith(false)
	})
})
