// @vitest-environment jsdom
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { stockItem } from '#tests/inventory-fixtures.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { SupplierForm } from './supplier-form.tsx'
import { SupplierProducts } from './supplier-products.tsx'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const originalScrollIntoView = Element.prototype.scrollIntoView

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
	toast.success.mockReset()
	toast.error.mockReset()
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

const SUPPLIER = {
	id: 's1',
	name: 'Fresh Farms',
	contactName: 'Omar',
	phone: '+966 55 000 0000',
	email: null,
	orderChannel: 'whatsapp' as const,
	deliveryDays: [1, 4],
	cutoffTime: '16:00',
	cutoffDaysBefore: 1,
	currency: 'SAR',
	paymentTerms: '30 days',
	vatNumber: null,
	notes: null,
	archived: false,
	version: 3,
	productCount: 1,
	unpaidCount: 0,
	minimumOrderMinor: 40_000,
}

function renderForm(
	element: React.ReactElement,
	request: InventoryClient['request'],
) {
	return renderInventory(
		<Sheet open>
			<SheetContent>{element}</SheetContent>
		</Sheet>,
		{ request },
	)
}

describe('Add supplier', () => {
	it('needs only a name, and sends what was typed with defaults for the rest', async () => {
		const onSaved = vi.fn()
		const request = vi.fn<InventoryClient['request']>(async () => SUPPLIER)
		renderForm(
			<SupplierForm
				mode="create"
				currency="SAR"
				layout="sheet"
				onSaved={onSaved}
			/>,
			request,
		)
		await userEvent.type(
			screen.getByTestId('supplier-form-name'),
			'Fresh Farms',
		)
		await userEvent.click(screen.getByTestId('supplier-form-day-1'))
		await userEvent.click(screen.getByTestId('supplier-form-day-4'))
		await userEvent.type(screen.getByTestId('supplier-form-minimum'), '400')
		await userEvent.click(screen.getByTestId('supplier-form-submit'))

		await waitFor(() => expect(onSaved).toHaveBeenCalled())
		expect(request.mock.calls[0]![0]).toBe('/suppliers')
		expect(request.mock.calls[0]![1]?.method).toBe('POST')
		const body = sentJson(request, 0) as Record<string, unknown>
		expect(body).toMatchObject({
			name: 'Fresh Farms',
			orderChannel: 'phone',
			deliveryDays: [1, 4],
			minimumOrderMinor: 40_000,
			currency: 'SAR',
			contactName: null,
			email: null,
		})
		expect(String(body.clientId)).toMatch(/^s-/)
		expect(toast.success).toHaveBeenCalledWith('Fresh Farms added.')
	})

	it('asks for a name and sends nothing without one', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => SUPPLIER)
		renderForm(
			<SupplierForm
				mode="create"
				currency="SAR"
				layout="sheet"
				onSaved={vi.fn()}
			/>,
			request,
		)
		await userEvent.click(screen.getByTestId('supplier-form-submit'))
		expect(
			await screen.findByText("Enter the supplier's name."),
		).toBeInTheDocument()
		expect(request).not.toHaveBeenCalled()
	})

	it('says what is wrong with an email and a half-given cut-off', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => SUPPLIER)
		renderForm(
			<SupplierForm
				mode="create"
				currency="SAR"
				layout="sheet"
				onSaved={vi.fn()}
			/>,
			request,
		)
		await userEvent.type(screen.getByTestId('supplier-form-name'), 'X')
		await userEvent.type(screen.getByTestId('supplier-form-email'), 'orders@')
		await userEvent.type(screen.getByTestId('supplier-form-cutoff-days'), '1')
		await userEvent.click(screen.getByTestId('supplier-form-submit'))
		expect(
			await screen.findByText(/Enter an email address/),
		).toBeInTheDocument()
		expect(
			screen.getByText('Give both the time and how many days before delivery.'),
		).toBeInTheDocument()
		expect(request).not.toHaveBeenCalled()
	})

	it('keeps the form and shows the reason when saving fails', async () => {
		const request = vi.fn<InventoryClient['request']>(async () => {
			throw new OperatorRequestError('no', 'forbidden', 403)
		})
		renderForm(
			<SupplierForm
				mode="create"
				currency="SAR"
				layout="sheet"
				onSaved={vi.fn()}
			/>,
			request,
		)
		await userEvent.type(screen.getByTestId('supplier-form-name'), 'X')
		await userEvent.click(screen.getByTestId('supplier-form-submit'))
		expect(await screen.findByTestId('supplier-form-error')).toHaveTextContent(
			'You do not have permission',
		)
		expect(screen.getByTestId('supplier-form-name')).toHaveValue('X')
	})
})

describe('Edit supplier', () => {
	it('shows what is saved and sends every field with the version it saw', async () => {
		const onSaved = vi.fn()
		const request = vi.fn<InventoryClient['request']>(async () => SUPPLIER)
		renderForm(
			<SupplierForm
				mode="edit"
				supplier={SUPPLIER}
				currency="SAR"
				layout="inline"
				onSaved={onSaved}
			/>,
			request,
		)
		expect(screen.getByTestId('supplier-form-name')).toHaveValue('Fresh Farms')
		expect(screen.getByTestId('supplier-form-contact')).toHaveValue('Omar')
		expect(screen.getByTestId('supplier-form-minimum')).toHaveValue('400.00')
		expect(screen.getByTestId('supplier-form-cutoff-time')).toHaveValue('16:00')
		expect(screen.getByTestId('supplier-form-day-1')).toHaveAttribute(
			'aria-pressed',
			'true',
		)

		await userEvent.clear(screen.getByTestId('supplier-form-contact'))
		await userEvent.click(screen.getByTestId('supplier-form-submit'))
		await waitFor(() => expect(onSaved).toHaveBeenCalled())
		expect(request.mock.calls[0]![0]).toBe('/suppliers/s1')
		expect(request.mock.calls[0]![1]?.method).toBe('PATCH')
		expect(sentJson(request, 0)).toMatchObject({
			expectedVersion: 3,
			name: 'Fresh Farms',
			contactName: null,
			orderChannel: 'whatsapp',
			deliveryDays: [1, 4],
			cutoffTime: '16:00',
			cutoffDaysBefore: 1,
			minimumOrderMinor: 40_000,
			paymentTerms: '30 days',
		})
	})
})

describe('Supplier products', () => {
	const PRODUCT = {
		id: 'sp_1',
		supplierId: 's1',
		itemId: 'itm_1',
		itemName: 'Chicken thighs',
		packName: 'Box',
		packBaseQuantity: 10_000_000,
		pricedByWeight: true,
		sku: null,
		preferred: true,
		version: 2,
		priceMinor: 28_000,
		currency: 'SAR',
	}

	function region() {
		return vi.fn<InventoryClient['request']>(async (path, init) => {
			if (path.startsWith('/items?')) {
				return {
					items: [stockItem({ costMicro: 2_800_000 })],
					total: 1,
					nextCursor: null,
				}
			}
			if (path.startsWith('/items/')) return stockItem()
			if (init?.method === 'POST' && path.endsWith('/products')) return PRODUCT
			if (init?.method === 'POST' && path.endsWith('/archive')) return PRODUCT
			if (init?.method === 'PATCH') return PRODUCT
			throw new Error(`unexpected request ${path}`)
		})
	}

	function renderProducts(
		request: InventoryClient['request'],
		props: {
			products?: unknown[]
			canManage?: boolean
			canSeeCost?: boolean
		} = {},
	) {
		const onChanged = vi.fn()
		renderForm(
			<SupplierProducts
				supplierId="s1"
				products={(props.products ?? [PRODUCT]) as never}
				canManage={props.canManage ?? true}
				canSeeCost={props.canSeeCost ?? true}
				currency="SAR"
				locationId="main"
				onChanged={onChanged}
			/>,
			request,
		)
		return { onChanged }
	}

	it('lists each pack with its size and price', async () => {
		renderProducts(region())
		const row = await screen.findByTestId('supplier-product-sp_1')
		await waitFor(() => expect(row).toHaveTextContent('Box · 10 kg'))
		expect(row).toHaveTextContent('280')
		expect(row).toHaveTextContent('Preferred')
		expect(row).toHaveTextContent('Priced by weight')
	})

	it('shows no price to someone who may not see costs, and does not let them add', async () => {
		const { products } = { products: [{ ...PRODUCT, priceMinor: undefined }] }
		renderProducts(region(), { products, canSeeCost: false })
		const row = await screen.findByTestId('supplier-product-sp_1')
		expect(row.textContent).not.toMatch(/280|SAR/)
		expect(screen.queryByTestId('supplier-product-add')).toBeNull()
	})

	it('a reader sees the packs and no editing buttons', async () => {
		renderProducts(region(), { canManage: false })
		await screen.findByTestId('supplier-product-sp_1')
		expect(screen.queryByTestId('supplier-product-add')).toBeNull()
		expect(screen.queryByTestId('supplier-product-remove-sp_1')).toBeNull()
	})

	it('adds a pack: the item, its name, size and price', async () => {
		const request = region()
		const { onChanged } = renderProducts(request, { products: [] })
		expect(
			await screen.findByTestId('supplier-products-empty'),
		).toBeInTheDocument()
		await userEvent.click(screen.getByTestId('supplier-product-add'))
		await userEvent.click(screen.getByTestId('supplier-product-item'))
		await userEvent.click(
			await screen.findByTestId('supplier-product-item-option-itm_1'),
		)
		await userEvent.type(screen.getByTestId('supplier-product-pack'), 'Box')
		await userEvent.type(screen.getByTestId('supplier-product-size'), '10')
		await userEvent.type(screen.getByTestId('supplier-product-price'), '280')
		await userEvent.click(screen.getByTestId('supplier-product-save'))

		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(([path]) =>
			path.endsWith('/suppliers/s1/products'),
		)
		expect(sentJson(request, index)).toEqual({
			itemId: 'itm_1',
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			priceMinor: 28_000,
			pricedByWeight: false,
			preferred: false,
		})
	})

	it('names what is missing on a new pack and sends nothing', async () => {
		const request = region()
		renderProducts(request, { products: [] })
		await userEvent.click(await screen.findByTestId('supplier-product-add'))
		await userEvent.click(screen.getByTestId('supplier-product-save'))
		expect(await screen.findByText('Choose an item.')).toBeInTheDocument()
		expect(
			screen.getByText('Enter the price of one pack, for example 28.50.'),
		).toBeInTheDocument()
		expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
			false,
		)
	})

	it('changes the price of a pack but never its size', async () => {
		const request = region()
		const { onChanged } = renderProducts(request)
		await userEvent.click(await screen.findByLabelText('Edit Chicken thighs'))
		expect(screen.queryByTestId('supplier-product-size')).toBeNull()
		const price = screen.getByTestId('supplier-product-price')
		await userEvent.clear(price)
		await userEvent.type(price, '300')
		await userEvent.click(screen.getByTestId('supplier-product-save'))
		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(
			([path, init]) =>
				path === '/supplier-products/sp_1' && init?.method === 'PATCH',
		)
		expect(sentJson(request, index)).toEqual({
			expectedVersion: 2,
			packName: 'Box',
			priceMinor: 30_000,
			pricedByWeight: true,
			preferred: true,
		})
	})

	it('removes a pack from the supplier with the version it saw', async () => {
		const request = region()
		const { onChanged } = renderProducts(request)
		await userEvent.click(
			await screen.findByTestId('supplier-product-remove-sp_1'),
		)
		await waitFor(() => expect(onChanged).toHaveBeenCalled())
		const index = request.mock.calls.findIndex(([path]) =>
			path.endsWith('/supplier-products/sp_1/archive'),
		)
		expect(sentJson(request, index)).toEqual({ expectedVersion: 2 })
	})
})
