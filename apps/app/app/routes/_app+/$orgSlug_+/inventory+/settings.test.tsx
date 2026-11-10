// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InventoryChrome } from '#app/components/inventory/inventory-chrome.tsx'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { type InventoryLayoutContext } from './_layout.tsx'
import InventorySettingsRoute from './settings.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

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
})

const CONTEXT: InventoryLayoutContext = {
	orgSlug: 'acme',
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, today: true, stock: true },
	locations: [{ id: 'main', name: 'Olaya branch' }],
	activeLocationId: 'main',
	canSeeCost: true,
	canEdit: true,
	canManagePurchasing: true,
	purchasingEnabled: true,
	transfersEnabled: false,
	transferPlaces: [],
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
}

function renderSettings(
	request: InventoryClient['request'],
	context: Partial<InventoryLayoutContext> = {},
) {
	const merged = { ...CONTEXT, ...context }
	const router = createMemoryRouter(
		[
			{
				path: '/acme/inventory',
				element: (
					<InventoryChrome
						orgSlug="acme"
						nav={merged.nav}
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
				children: [
					{
						path: 'settings',
						element: <InventorySettingsRoute />,
					},
				],
			},
		],
		{ initialEntries: ['/acme/inventory/settings'] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider
				value={{
					orgSlug: 'acme',
					request,
				}}
			>
				<InventoryChangeProvider>
					<RouterProvider router={router} />
				</InventoryChangeProvider>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('InventorySettingsRoute', () => {
	it('loads organization settings and location defaults, then saves updates with expectedVersion', async () => {
		const user = userEvent.setup()
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			if (path === '/settings' && !init?.method) {
				return {
					targetFoodCostBp: 3000,
					unitSystem: 'metric',
					countDayOfWeek: 0,
					countTime: '22:00',
					anyStaffCanReceive: false,
					version: 2,
					updatedAt: 1_700_000_000_000,
					locations: [
						{
							locationId: 'main',
							timeZone: 'Asia/Riyadh',
							dayStartMinutes: 240,
							currency: 'SAR',
							currencySource: 'app',
							pricesIncludeTax: true,
							taxRateBp: 1500,
						},
					],
				}
			}
			if (path === '/settings' && init?.method === 'PUT') {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>
				return {
					targetFoodCostBp: body.targetFoodCostBp,
					unitSystem: body.unitSystem,
					countDayOfWeek: body.countDayOfWeek,
					countTime: body.countTime,
					anyStaffCanReceive: body.anyStaffCanReceive,
					version: 3,
					updatedAt: 1_700_000_100_000,
					locations: [],
				}
			}
			throw new Error(`unexpected request ${path}`)
		})

		renderSettings(request)

		await screen.findByTestId('settings-target-food-cost')
		expect(
			screen.getByTestId<HTMLInputElement>('settings-target-food-cost').value,
		).toBe('30')
		expect(screen.getByText('Asia/Riyadh')).toBeTruthy()
		expect(screen.getByText('SAR')).toBeTruthy()

		const targetInput = screen.getByTestId('settings-target-food-cost')
		await user.clear(targetInput)
		await user.type(targetInput, '28.5')

		const anyStaffCheckbox = screen.getByTestId('settings-any-staff-receive')
		await user.click(anyStaffCheckbox)

		const saveButton = screen.getByTestId('settings-save')
		await user.click(saveButton)

		await waitFor(() => {
			expect(request).toHaveBeenCalledWith(
				'/settings',
				expect.objectContaining({
					method: 'PUT',
				}),
			)
		})

		const putCall = request.mock.calls.find(
			([path, init]) => path === '/settings' && init?.method === 'PUT',
		)
		expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
			expectedVersion: 2,
			unitSystem: 'metric',
			targetFoodCostBp: 2850,
			countDayOfWeek: 0,
			countTime: '22:00',
			anyStaffCanReceive: true,
		})
	})
})
