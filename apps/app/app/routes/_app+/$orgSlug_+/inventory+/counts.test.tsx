// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { InventoryChrome } from '#app/components/inventory/inventory-chrome.tsx'
import {
	type InventoryClient,
	InventoryClientContext,
} from '#app/components/inventory/inventory-client-provider.tsx'
import { InventoryChangeProvider } from '#app/components/inventory/inventory-prefs.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { HIDDEN_INVENTORY_NAV } from '#app/utils/inventory/nav.ts'
import { type InventoryLayoutContext } from './_layout.tsx'
import InventoryCountsRoute from './counts.tsx'

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
	nav: { ...HIDDEN_INVENTORY_NAV, visible: true, counts: true },
	locations: [{ id: 'main', name: 'Acme' }],
	activeLocationId: 'main',
	canSeeCost: true,
	canEdit: true,
	canManagePurchasing: true,
	purchasingEnabled: false,
	transfersEnabled: false,
	transferPlaces: [],
	dataRegion: 'ksa',
	currency: 'SAR',
	userName: 'Sara',
}

function count(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		locationId: 'main',
		listId: null,
		listName: 'Weekly count',
		status: 'counting',
		businessDate: '2026-11-01',
		startedBy: { kind: 'operator', id: 'u1' },
		itemTotal: 48,
		itemsCounted: 32,
		counters: [],
		sentForReviewAt: null,
		approvedAt: null,
		approvedBy: null,
		cancelledAt: null,
		createdAt: Date.UTC(2026, 10, 1, 9, 12),
		version: 1,
		...overrides,
	}
}

function region(options: { open?: unknown[]; closed?: unknown[] } = {}) {
	return vi.fn<InventoryClient['request']>(async (path) => {
		if (path.includes('status=open')) {
			return { counts: options.open ?? [count('c1')], nextCursor: null }
		}
		if (path.includes('status=closed')) {
			return {
				counts: options.closed ?? [
					count('c2', {
						status: 'approved',
						itemsCounted: 48,
						approvedBy: { kind: 'operator', id: 'u2' },
						differenceValueMinor: -21_200,
						currency: 'SAR',
					}),
				],
				nextCursor: null,
			}
		}
		if (path.startsWith('/count-lists')) return { lists: [] }
		throw new Error(`unexpected request ${path}`)
	})
}

function renderCounts(
	request: InventoryClient['request'],
	context: Partial<InventoryLayoutContext> = {},
	route = '/acme/inventory/counts',
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
						path: 'counts',
						element: <InventoryCountsRoute />,
						HydrateFallback: () => null,
						loader: () => ({
							memberNames: { u1: 'Sara', u2: 'Omar' },
						}),
					},
				],
			},
		],
		{ initialEntries: [route] },
	)
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<InventoryChangeProvider>
					<RouterProvider router={router} />
				</InventoryChangeProvider>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('Inventory Counts', () => {
	it('shows a count in progress with who started it, how far it got and Resume', async () => {
		renderCounts(region())
		const card = await screen.findByTestId('count-card-c1')
		expect(card).toHaveTextContent('Weekly count')
		expect(card).toHaveTextContent('by Sara')
		expect(card).toHaveTextContent('Counting')
		expect(screen.getByTestId('count-card-progress-c1')).toHaveTextContent(
			'32 of 48',
		)
		expect(screen.getByTestId('count-card-open-c1')).toHaveAttribute(
			'href',
			'/acme/inventory/counts/c1',
		)
		expect(screen.getByTestId('count-card-open-c1')).toHaveTextContent('Resume')
	})

	it('a count in review leads to its review', async () => {
		renderCounts(region({ open: [count('c1', { status: 'in_review' })] }))
		const link = await screen.findByTestId('count-card-open-c1')
		expect(link).toHaveAttribute('href', '/acme/inventory/counts/c1/review')
		expect(link).toHaveTextContent('Review')
	})

	it('someone who cannot edit only gets to look', async () => {
		renderCounts(region(), { canEdit: false })
		const link = await screen.findByTestId('count-card-open-c1')
		expect(link).toHaveTextContent('View')
		expect(screen.queryByTestId('counts-start')).toBeNull()
	})

	it('lists past counts with who approved them and the difference in money', async () => {
		renderCounts(region())
		const row = await screen.findByTestId('count-row-c2')
		expect(row).toHaveTextContent('Weekly count')
		expect(row).toHaveTextContent('Omar')
		expect(row).toHaveTextContent('48')
		expect(row).toHaveTextContent('212')
		expect(row).toHaveTextContent('Approved')
	})

	it('shows no difference column without the cost grant', async () => {
		renderCounts(
			region({
				closed: [
					count('c2', {
						status: 'approved',
						itemsCounted: 48,
						approvedBy: { kind: 'operator', id: 'u2' },
					}),
				],
			}),
			{ canSeeCost: false },
		)
		const row = await screen.findByTestId('count-row-c2')
		expect(row.textContent).not.toMatch(/SAR|212/)
		expect(screen.queryByText('Difference')).toBeNull()
	})

	it('past counts open read-only', async () => {
		renderCounts(region())
		const row = await screen.findByTestId('count-row-c2')
		expect(row.querySelector('a')).toHaveAttribute(
			'href',
			'/acme/inventory/counts/c2',
		)
	})

	it('has a calm empty state with a way to start the first count', async () => {
		renderCounts(region({ open: [], closed: [] }))
		expect(await screen.findByText('No counts yet')).toBeInTheDocument()
		expect(screen.getByTestId('counts-none-open')).toBeInTheDocument()
	})

	it('opens the start dialog from the header and from ?start=1', async () => {
		renderCounts(region())
		await userEvent.click(await screen.findByTestId('counts-start'))
		expect(await screen.findByTestId('start-count-dialog')).toBeInTheDocument()
	})

	it('?start=1 opens the dialog once and leaves the address clean', async () => {
		renderCounts(region(), {}, '/acme/inventory/counts?start=1')
		expect(await screen.findByTestId('start-count-dialog')).toBeInTheDocument()
	})

	it('?start=1 does nothing for someone who cannot start a count', async () => {
		renderCounts(region(), { canEdit: false }, '/acme/inventory/counts?start=1')
		await screen.findByTestId('count-card-c1')
		expect(screen.queryByTestId('start-count-dialog')).toBeNull()
	})

	it('shows the error with Try again for each list', async () => {
		renderCounts(
			vi.fn<InventoryClient['request']>(async () => {
				throw new OperatorRequestError('down', 'inventory_unavailable', 503)
			}),
		)
		expect(await screen.findByTestId('counts-open-error')).toBeInTheDocument()
		expect(await screen.findByTestId('counts-past-error')).toBeInTheDocument()
	})
})
