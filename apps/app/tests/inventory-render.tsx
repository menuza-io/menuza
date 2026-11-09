import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render } from '@testing-library/react'
import { type ReactElement, type ReactNode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { SaveBar } from '#app/components/save-bar.tsx'

/**
 * Renders an Inventory component with an English Lingui catalog, a router and
 * a mocked regional client: `request` stands in for tenant-api, so a test says
 * what the region answers and checks what was sent.
 */
export function renderInventory(
	ui: ReactElement,
	{
		request,
		route = '/',
		wrapper,
	}: {
		request: InventoryClient['request']
		route?: string
		wrapper?: (children: ReactNode) => ReactNode
	},
) {
	i18n.load('en', {})
	i18n.activate('en')
	const wrap = wrapper ?? ((children: ReactNode) => children)
	const router = createMemoryRouter([{ path: '*', element: wrap(ui) }], {
		initialEntries: [route],
	})
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<InventoryChangeProvider>
					<RouterProvider router={router} />
				</InventoryChangeProvider>
			</InventoryClientContext.Provider>
			<SaveBar />
		</I18nProvider>,
	)
}

/** The body of a mutation as the region receives it. */
export function sentJson(
	request: { mock: { calls: unknown[][] } },
	index: number,
): unknown {
	const init = request.mock.calls[index]?.[1] as RequestInit | undefined
	return init?.body ? JSON.parse(String(init.body)) : undefined
}
