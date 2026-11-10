// @vitest-environment jsdom
import { createItemSchema, type ItemDetail } from '@repo/inventory'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { ItemForm } from './item-form.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
	vi.clearAllMocks()
})

const AREAS = [
	{
		id: 'a1',
		locationId: 'main',
		name: 'Walk-in fridge',
		sortOrder: 0,
		itemCount: 0,
		version: 1,
	},
]

function renderForm(
	request: InventoryClient['request'],
	props: Partial<React.ComponentProps<typeof ItemForm>> = {},
) {
	const onSaved = vi.fn()
	const onCancel = vi.fn()
	renderInventory(
		<Sheet open>
			<SheetContent>
				<ItemForm
					mode="create"
					locationId="main"
					areas={AREAS}
					currency="SAR"
					canManagePurchasing
					basePath="/acme/inventory/stock"
					search=""
					onSaved={onSaved}
					onCancel={onCancel}
					{...props}
				/>
			</SheetContent>
		</Sheet>,
		{ request },
	)
	return { onSaved, onCancel }
}

function region(create: () => unknown = () => ({ id: 'itm_new' })) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path === '/suppliers') {
			return {
				suppliers: [
					{
						id: 's1',
						name: 'Al Watania',
						contactName: null,
						phone: null,
						email: null,
						orderChannel: 'phone',
						deliveryDays: [],
						cutoffTime: null,
						cutoffDaysBefore: null,
						currency: 'SAR',
						paymentTerms: null,
						vatNumber: null,
						notes: null,
						archived: false,
						version: 1,
						productCount: 0,
						unpaidCount: 0,
					},
				],
			}
		}
		if (path === '/items' && init?.method === 'POST') return create()
		throw new Error(`unexpected request ${path}`)
	})
}

async function chooseCategory(name: string) {
	await userEvent.click(screen.getByTestId('item-form-category'))
	await userEvent.click(await screen.findByRole('option', { name }))
}

describe('ItemForm (add)', () => {
	it('needs only a name and a category, and says what is missing', async () => {
		const request = region()
		renderForm(request)
		await userEvent.click(screen.getByTestId('item-form-submit'))
		expect(await screen.findByText('Enter a name.')).toBeInTheDocument()
		expect(screen.getByText('Choose a category.')).toBeInTheDocument()
		expect(request.mock.calls.some(([path]) => path === '/items')).toBe(false)
	})

	it('saves a minimal item with a valid payload', async () => {
		const request = region()
		const { onSaved } = renderForm(request)
		await userEvent.type(screen.getByTestId('item-form-name'), 'Chicken thighs')
		await chooseCategory('Meat')
		await userEvent.click(screen.getByTestId('item-form-submit'))
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))

		const index = request.mock.calls.findIndex(([path]) => path === '/items')
		const body = sentJson(request, index)
		expect(createItemSchema.safeParse(body).success).toBe(true)
		expect(body).toMatchObject({
			name: 'Chicken thighs',
			category: 'meat',
			kind: 'bought',
			baseUnit: 'g',
			place: { locationId: 'main', countUnit: 'kg', areaIds: [] },
		})
		// One plain name: no per-language fields anywhere.
		expect(
			Object.keys(body as object).filter((key) => /ar|locale|lang/i.test(key)),
		).toEqual([])
	})

	it('measures in litres or pieces, keeps where it is kept, and counts by a pack', async () => {
		const request = region()
		const { onSaved } = renderForm(request)
		await userEvent.type(screen.getByTestId('item-form-name'), 'Olive oil')
		await chooseCategory('Dry goods')
		await userEvent.click(screen.getByTestId('item-form-measured-volume'))
		await userEvent.type(screen.getByTestId('item-form-pack-name'), 'Case')
		await userEvent.type(screen.getByTestId('item-form-pack-size'), '6')
		await userEvent.click(screen.getByTestId('item-form-count-pack'))
		await userEvent.click(screen.getByTestId('item-form-area-a1'))
		await userEvent.click(screen.getByTestId('item-form-submit'))
		await waitFor(() => expect(onSaved).toHaveBeenCalled())

		const index = request.mock.calls.findIndex(([path]) => path === '/items')
		const body = sentJson(request, index) as Record<string, unknown>
		expect(createItemSchema.safeParse(body).success).toBe(true)
		expect(body).toMatchObject({
			baseUnit: 'ml',
			// a pack size typed in litres is stored in millilitre thousandths
			units: [{ name: 'Case', baseQuantity: 6_000_000 }],
			place: { countUnit: 'new:0', areaIds: ['a1'] },
		})
	})

	it('asks for a price when a supplier is chosen', async () => {
		const request = region()
		renderForm(request)
		await userEvent.type(screen.getByTestId('item-form-name'), 'Rice')
		await chooseCategory('Dry goods')
		await userEvent.type(screen.getByTestId('item-form-pack-name'), 'Sack')
		await userEvent.type(screen.getByTestId('item-form-pack-size'), '20')
		await userEvent.click(await screen.findByTestId('item-form-supplier'))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Al Watania' }),
		)
		await userEvent.click(screen.getByTestId('item-form-submit'))
		expect(
			await screen.findByText(
				'Enter the price of one pack, for example 28.50.',
			),
		).toBeInTheDocument()
		expect(request.mock.calls.some(([path]) => path === '/items')).toBe(false)
	})

	it('hides the supplier question without the purchasing grant', () => {
		renderForm(region(), { canManagePurchasing: false })
		expect(screen.queryByTestId('item-form-supplier')).toBeNull()
	})

	it('keeps the form with the error after a failed save and retries with the same key', async () => {
		let attempts = 0
		const request = region(() => {
			attempts += 1
			if (attempts === 1)
				throw new OperatorRequestError('down', 'request_failed', 500)
			return { id: 'itm_new' }
		})
		const { onSaved } = renderForm(request)
		await userEvent.type(screen.getByTestId('item-form-name'), 'Rice')
		await chooseCategory('Dry goods')
		await userEvent.click(screen.getByTestId('item-form-submit'))
		expect(await screen.findByTestId('item-form-error')).toHaveTextContent(
			'We could not save this',
		)
		expect(onSaved).not.toHaveBeenCalled()

		await userEvent.click(screen.getByTestId('item-form-submit'))
		await waitFor(() => expect(onSaved).toHaveBeenCalled())
		const posts = request.mock.calls
			.map(([path], index) => (path === '/items' ? index : -1))
			.filter((index) => index >= 0)
		expect(posts).toHaveLength(2)
		expect(
			(sentJson(request, posts[0]!) as { clientId: string }).clientId,
		).toBe((sentJson(request, posts[1]!) as { clientId: string }).clientId)
	})
})

describe('ItemForm (edit)', () => {
	const ITEM = {
		id: 'itm_1',
		name: 'Chicken thighs',
		category: 'meat',
		kind: 'bought',
		baseUnit: 'g',
		archived: false,
		version: 3,
		onHand: 6_000_000,
		countUnit: 'kg',
		units: [],
		areaIds: [],
		orderBelowQuantity: null,
		fillUpToQuantity: null,
		status: 'ok',
		lastCountedAt: null,
		notes: null,
		places: [
			{
				locationId: 'main',
				countUnit: 'kg',
				areaIds: [],
				orderBelowQuantity: null,
				fillUpToQuantity: null,
				version: 5,
			},
		],
		onHandByLocation: [{ locationId: 'main', onHand: 6_000_000 }],
		suppliers: [],
		hasMovements: true,
	} as unknown as ItemDetail

	it('renames with the item version, keeps the unit once stock has moved, and leaves an untouched place alone', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => ({}))
		const { onSaved } = renderForm(request, { mode: 'edit', item: ITEM })
		expect(screen.getByTestId('item-form-measured-weight')).toBeDisabled()
		expect(screen.queryByTestId('item-form-pack-name')).toBeNull()

		const name = screen.getByTestId('item-form-name')
		await userEvent.clear(name)
		await userEvent.type(name, 'Chicken breast')
		await userEvent.click(screen.getByTestId('item-form-submit'))
		await waitFor(() => expect(onSaved).toHaveBeenCalled())

		expect(request).toHaveBeenCalledTimes(1)
		expect(request).toHaveBeenCalledWith(
			'/items/itm_1',
			expect.objectContaining({ method: 'PATCH' }),
		)
		expect(sentJson(request, 0)).toEqual({
			expectedVersion: 3,
			name: 'Chicken breast',
			category: 'meat',
		})
	})

	it('saves where it is kept and its levels with the place version', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => ({}))
		const { onSaved } = renderForm(request, { mode: 'edit', item: ITEM })
		await userEvent.click(screen.getByTestId('item-form-area-a1'))
		await userEvent.type(screen.getByTestId('item-form-order-below'), '8')
		await userEvent.type(screen.getByTestId('item-form-fill-up-to'), '30')
		await userEvent.click(screen.getByTestId('item-form-submit'))
		await waitFor(() => expect(onSaved).toHaveBeenCalled())

		expect(request).toHaveBeenCalledTimes(1)
		expect(request).toHaveBeenCalledWith(
			'/items/itm_1/places/main',
			expect.objectContaining({ method: 'PUT' }),
		)
		expect(sentJson(request, 0)).toEqual({
			expectedVersion: 5,
			countUnit: 'kg',
			areaIds: ['a1'],
			orderBelowQuantity: 8_000_000,
			fillUpToQuantity: 30_000_000,
		})
	})
})
