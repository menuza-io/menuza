// @vitest-environment jsdom
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { type StockOutletContext } from '#app/components/inventory/stock-context.ts'
import AddManyRoute from '#app/routes/_app+/$orgSlug_+/inventory+/stock.add-many.tsx'
import AreasRoute from '#app/routes/_app+/$orgSlug_+/inventory+/stock.areas.tsx'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { sentJson } from '#tests/inventory-render.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
	vi.clearAllMocks()
})

const close = vi.fn()
const reload = vi.fn()

const CONTEXT: StockOutletContext = {
	orgSlug: 'acme',
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, stock: true },
	locations: [{ id: 'main', name: 'Acme' }],
	activeLocationId: 'main',
	canSeeCost: false,
	canEdit: true,
	canManagePurchasing: false,
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
	basePath: '/acme/inventory/stock',
	search: '',
	areas: [],
	reload,
	close,
}

function renderSheet(
	element: React.ReactElement,
	request: InventoryClient['request'],
) {
	i18n.load('en', {})
	i18n.activate('en')
	const router = createMemoryRouter(
		[
			{
				path: '*',
				element: (
					<Sheet open>
						<SheetContent>
							<Outlet context={CONTEXT} />
						</SheetContent>
					</Sheet>
				),
				children: [{ path: '*', element }],
			},
		],
		{ initialEntries: ['/'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<RouterProvider router={router} />
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('Add many items', () => {
	function bulkRegion(
		result: unknown = { created: [], skipped: [], areasCreated: 0 },
	) {
		return vi.fn<InventoryClient['request']>(async () => result)
	}

	it('adds a starter list in the language in use, as plain text', async () => {
		const request = bulkRegion({
			created: [{ id: 'i1', name: 'Chicken' }],
			skipped: [{ name: 'Beef', reason: 'exists' }],
			areasCreated: 2,
		})
		renderSheet(<AddManyRoute />, request)
		// Starter list is the first choice; untick one item.
		const list = screen.getByTestId('add-many-starter-list')
		expect(
			within(list).getByRole('checkbox', { name: 'Chicken' }),
		).toBeChecked()
		await userEvent.click(within(list).getByRole('checkbox', { name: 'Lamb' }))
		await userEvent.click(screen.getByTestId('add-many-starter-submit'))

		expect(await screen.findByTestId('add-many-summary')).toHaveTextContent(
			'1 added, 1 skipped',
		)
		expect(request).toHaveBeenCalledTimes(1)
		const body = sentJson(request, 0) as {
			clientId: string
			locationId: string
			items: Array<{ name: string; areaName: string; baseUnit: string }>
		}
		expect(request.mock.calls[0]![0]).toBe('/items/bulk')
		expect(body.locationId).toBe('main')
		expect(body.items.map((item) => item.name)).toContain('Chicken')
		expect(body.items.map((item) => item.name)).not.toContain('Lamb')
		expect(body.items.find((item) => item.name === 'Chicken')).toMatchObject({
			areaName: 'Walk-in fridge',
			baseUnit: 'g',
		})
		expect(reload).toHaveBeenCalled()
	})

	it('previews a pasted list, lets you fix a row, and adds only the good ones', async () => {
		const request = bulkRegion({
			created: [{ id: 'i1', name: 'Chicken thighs' }],
			skipped: [],
			areasCreated: 0,
		})
		renderSheet(<AddManyRoute />, request)
		await userEvent.click(screen.getByTestId('add-many-source-paste'))
		const box = screen.getByTestId('add-many-text')
		await userEvent.click(box)
		await userEvent.paste(
			'Name, Category, Unit, Price\nChicken thighs, Meat, kg, 28\nSalt, Dry goods, sack, 2',
		)
		await userEvent.click(screen.getByTestId('add-many-review'))

		// The second row's unit was not understood: it needs a fix and is skipped.
		expect(await screen.findByText(/1 ready, 1 need a fix/)).toBeInTheDocument()
		expect(screen.getByText('Choose a unit.')).toBeInTheDocument()
		await userEvent.click(screen.getByTestId('add-many-confirm'))

		await screen.findByTestId('add-many-summary')
		const body = sentJson(request, 0) as {
			items: Array<Record<string, unknown>>
		}
		expect(body.items).toEqual([
			{
				name: 'Chicken thighs',
				category: 'meat',
				kind: 'bought',
				baseUnit: 'g',
				countUnit: 'kg',
				costMicro: 2_800_000,
				currency: 'SAR',
			},
		])
	})

	it('asks for something to paste', async () => {
		const request = bulkRegion()
		renderSheet(<AddManyRoute />, request)
		await userEvent.click(screen.getByTestId('add-many-source-paste'))
		await userEvent.click(screen.getByTestId('add-many-review'))
		expect(
			await screen.findByText('Paste at least one item to continue.'),
		).toBeInTheDocument()
		expect(request).not.toHaveBeenCalled()
	})

	it('shows a failed save with the list kept for a retry', async () => {
		const request = vi
			.fn<InventoryClient['request']>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce({ created: [], skipped: [], areasCreated: 0 })
		renderSheet(<AddManyRoute />, request)
		await userEvent.click(screen.getByTestId('add-many-starter-submit'))
		expect(await screen.findByTestId('add-many-error')).toHaveTextContent(
			'We could not save this',
		)
		await userEvent.click(screen.getByTestId('add-many-starter-submit'))
		await screen.findByTestId('add-many-summary')
		expect((sentJson(request, 0) as { clientId: string }).clientId).toBe(
			(sentJson(request, 1) as { clientId: string }).clientId,
		)
	})
})

describe('Storage areas', () => {
	const AREAS = [
		{
			id: 'a1',
			locationId: 'main',
			name: 'Walk-in fridge',
			sortOrder: 0,
			itemCount: 4,
			version: 2,
		},
		{
			id: 'a2',
			locationId: 'main',
			name: 'Dry store',
			sortOrder: 1,
			itemCount: 1,
			version: 1,
		},
	]

	function areasRegion() {
		return vi.fn<InventoryClient['request']>(async (path) => {
			if (path.startsWith('/storage-areas?')) return { areas: AREAS }
			return {}
		})
	}

	function mutations(request: ReturnType<typeof areasRegion>) {
		return request.mock.calls
			.map(([path, init], index) => ({ path, method: init?.method, index }))
			.filter((call) => call.method !== undefined)
	}

	it('lists areas in walking order with item counts', async () => {
		renderSheet(<AreasRoute />, areasRegion())
		const first = await screen.findByTestId('area-a1')
		expect(first).toHaveTextContent('Walk-in fridge')
		expect(first).toHaveTextContent('4 items')
		expect(screen.getByTestId('area-a2')).toHaveTextContent('1 item')
		expect(
			screen.getByRole('button', { name: 'Move Walk-in fridge up' }),
		).toBeDisabled()
		expect(
			screen.getByRole('button', { name: 'Move Dry store down' }),
		).toBeDisabled()
	})

	it('adds, reorders, renames and archives', async () => {
		const request = areasRegion()
		renderSheet(<AreasRoute />, request)
		await screen.findByTestId('area-a1')

		await userEvent.type(screen.getByTestId('areas-new-name'), 'Freezer')
		await userEvent.click(screen.getByTestId('areas-add'))
		await waitFor(() => expect(mutations(request)).toHaveLength(1))
		expect(mutations(request)[0]).toMatchObject({
			path: '/storage-areas',
			method: 'POST',
		})
		expect(sentJson(request, mutations(request)[0]!.index)).toEqual({
			locationId: 'main',
			name: 'Freezer',
		})

		await userEvent.click(
			screen.getByRole('button', { name: 'Move Dry store up' }),
		)
		await waitFor(() => expect(mutations(request)).toHaveLength(2))
		expect(sentJson(request, mutations(request)[1]!.index)).toEqual({
			locationId: 'main',
			areaIds: ['a2', 'a1'],
		})

		await userEvent.click(
			screen.getByRole('button', { name: 'Rename Walk-in fridge' }),
		)
		const input = screen.getByLabelText('Storage area name')
		await userEvent.clear(input)
		await userEvent.type(input, 'Cold room')
		await userEvent.click(screen.getByRole('button', { name: 'Save' }))
		await waitFor(() => expect(mutations(request)).toHaveLength(3))
		expect(mutations(request)[2]).toMatchObject({
			path: '/storage-areas/a1',
			method: 'PATCH',
		})
		expect(sentJson(request, mutations(request)[2]!.index)).toEqual({
			expectedVersion: 2,
			name: 'Cold room',
		})

		await userEvent.click(
			screen.getByRole('button', { name: 'Archive Dry store' }),
		)
		await userEvent.click(await screen.findByTestId('areas-archive-confirm'))
		await waitFor(() => expect(mutations(request)).toHaveLength(4))
		expect(mutations(request)[3]).toMatchObject({
			path: '/storage-areas/a2/archive',
			method: 'POST',
		})
		expect(sentJson(request, mutations(request)[3]!.index)).toEqual({
			expectedVersion: 1,
		})
	})

	it('shows a failed change on screen', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			if (init?.method === 'POST') throw new Error('offline')
			return { areas: AREAS }
		})
		renderSheet(<AreasRoute />, request)
		await screen.findByTestId('area-a1')
		await userEvent.type(screen.getByTestId('areas-new-name'), 'Freezer')
		await userEvent.click(screen.getByTestId('areas-add'))
		expect(await screen.findByTestId('areas-error')).toBeInTheDocument()
		// The typed name stays for a retry.
		expect(screen.getByTestId('areas-new-name')).toHaveValue('Freezer')
	})
})
