// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { type InventoryLayoutContext } from './_layout.tsx'
import InventoryTodayRoute from './today.tsx'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
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

function renderToday(request: InventoryClient['request']) {
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory',
				element: <Outlet context={CONTEXT} />,
				children: [{ path: 'today', element: <InventoryTodayRoute /> }],
			},
		],
		{ initialEntries: ['/acme/inventory/today'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<RouterProvider router={router} />
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('Inventory Today', () => {
	it('shows a skeleton until the region answers, then the checklist', async () => {
		let resolve: (value: unknown) => void = () => {}
		const request = vi.fn(
			() => new Promise<unknown>((done) => (resolve = done)),
		)
		renderToday(request)
		expect(screen.getByTestId('inventory-today-loading')).toBeInTheDocument()
		expect(request).toHaveBeenCalledWith('/status?locationId=main')

		resolve({
			locationId: 'main',
			items: 4,
			storageAreas: 0,
			approvedCounts: 0,
			deliveries: 0,
		})
		await screen.findByTestId('inventory-setup-checklist')
		expect(screen.getByTestId('inventory-setup-progress')).toHaveTextContent(
			'1 of 4 done',
		)
		expect(
			screen.getByTestId('inventory-setup-step-items').dataset.status,
		).toBe('done')
		expect(
			screen.getByTestId('inventory-setup-go-storage').getAttribute('href'),
		).toBe('/acme/inventory/stock')
		expect(
			screen.getByTestId('inventory-setup-go-delivery').getAttribute('href'),
		).toBe('/acme/inventory/purchasing')
	})

	it('shows the error with Try again, never made-up progress', async () => {
		const request = vi
			.fn<InventoryClient['request']>()
			.mockRejectedValueOnce(
				new OperatorRequestError('down', 'inventory_unavailable', 503),
			)
			.mockResolvedValueOnce({
				locationId: 'main',
				items: 1,
				storageAreas: 1,
				approvedCounts: 1,
				deliveries: 1,
			})
		renderToday(request)
		const alert = await screen.findByTestId('inventory-today-error')
		expect(alert).toHaveTextContent('Inventory is paused right now')
		expect(screen.queryByTestId('inventory-setup-checklist')).toBeNull()

		fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
		await screen.findByTestId('inventory-setup-complete')
		await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
	})

	it('treats a malformed answer as an error', async () => {
		renderToday(vi.fn(async () => ({ items: 'lots' })))
		expect(
			await screen.findByTestId('inventory-today-error'),
		).toHaveTextContent('We could not load your inventory')
	})
})
