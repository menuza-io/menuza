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

	it('saves per-location purchasing spending limits when user has purchasing, settings, and cost grants (#500)', async () => {
		const user = userEvent.setup()
		const request = vi.fn<InventoryClient['request']>(async (path, init) => {
			if (path === '/settings' && !init?.method) {
				return {
					targetFoodCostBp: 3000,
					unitSystem: 'metric',
					countDayOfWeek: null,
					countTime: null,
					anyStaffCanReceive: false,
					version: 1,
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
							orderLimitMinor: 50_000,
							monthlyLimitMinor: null,
							version: 4,
						},
					],
				}
			}
			if (
				path === '/settings/locations/main/limits' &&
				init?.method === 'PUT'
			) {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>
				return {
					locationId: 'main',
					timeZone: 'Asia/Riyadh',
					dayStartMinutes: 240,
					currency: 'SAR',
					currencySource: 'app',
					pricesIncludeTax: true,
					taxRateBp: 1500,
					orderLimitMinor: body.orderLimitMinor,
					monthlyLimitMinor: body.monthlyLimitMinor,
					version: 5,
				}
			}
			throw new Error(`unexpected request ${path}`)
		})

		renderSettings(request, { canManageSettings: true })

		const orderInput = await screen.findByTestId<HTMLInputElement>(
			'settings-order-limit',
		)
		const monthlyInput = screen.getByTestId<HTMLInputElement>(
			'settings-monthly-limit',
		)
		expect(orderInput.value).toBe('500.00')
		expect(monthlyInput.value).toBe('')

		await user.clear(orderInput)
		await user.type(orderInput, '750')
		await user.type(monthlyInput, '3000.50')
		await user.click(screen.getByTestId('settings-limits-save'))

		await waitFor(() => {
			expect(request).toHaveBeenCalledWith(
				'/settings/locations/main/limits',
				expect.objectContaining({ method: 'PUT' }),
			)
		})
		const putCall = request.mock.calls.find(
			([path, init]) =>
				path === '/settings/locations/main/limits' && init?.method === 'PUT',
		)
		expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
			expectedVersion: 4,
			orderLimitMinor: 75_000,
			monthlyLimitMinor: 300_050,
		})
	})

	it('hides spending limits without cost grant and makes them read-only without settings grant (#500)', async () => {
		const request = vi.fn<InventoryClient['request']>(async (path) => {
			if (path === '/settings') {
				return {
					targetFoodCostBp: 3000,
					unitSystem: 'metric',
					countDayOfWeek: null,
					countTime: null,
					anyStaffCanReceive: false,
					version: 1,
					updatedAt: null,
					locations: [],
				}
			}
			throw new Error(`unexpected request ${path}`)
		})

		const first = renderSettings(request, {
			canSeeCost: false,
			canManageSettings: true,
		})
		await screen.findByTestId('settings-target-food-cost')
		expect(screen.queryByTestId('settings-limits-form')).toBeNull()
		first.unmount()

		renderSettings(request, {
			canSeeCost: true,
			canManageSettings: false,
		})
		expect(await screen.findByTestId('settings-order-limit')).toBeDisabled()
		expect(screen.getByTestId('settings-limits-readonly')).toBeTruthy()
		expect(screen.queryByTestId('settings-limits-save')).toBeNull()
	})
})
