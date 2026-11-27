// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { toast } from 'sonner'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
	type InventoryClient,
	InventoryClientContext,
} from './inventory-client-provider.tsx'
import { RoutinesScreen } from './routines-screen.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const lowStockRun = {
	key: 'count_low_stock' as const,
	id: 'run1',
	locationId: 'main',
	runKey: 'count:c1',
	status: 'done' as const,
	alerted: true,
	createdAt: 1_700_000_000_000,
	summary: {
		countId: 'c1',
		drafted: [
			{ orderId: 'ord1', number: 7, supplierName: 'Fresh Co', lineCount: 3 },
		],
		draftExisted: [],
		unsourced: 0,
	},
}

function routines(over: { morningEnabled?: boolean } = {}) {
	return {
		locationId: 'main',
		routines: [
			{
				key: 'count_low_stock',
				enabled: true,
				enabledAt: 1,
				version: 2,
				blocked: null,
				lastRuns: [lowStockRun],
			},
			{
				key: 'weekly_waste',
				enabled: false,
				enabledAt: null,
				version: 0,
				blocked: null,
				lastRuns: [],
			},
			{
				key: 'morning_brief',
				enabled: over.morningEnabled ?? false,
				enabledAt: null,
				version: 0,
				blocked: null,
				lastRuns: [],
			},
			{
				key: 'supplier_cutoff',
				enabled: false,
				enabledAt: null,
				version: 0,
				blocked: 'purchasing_off',
				lastRuns: [],
			},
		],
	}
}

function renderScreen(request: InventoryClient['request'], canEdit = true) {
	return render(
		<I18nProvider i18n={i18n}>
			<MemoryRouter>
				<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
					<RoutinesScreen
						locationId="main"
						orgSlug="acme"
						canEdit={canEdit}
						canSeeCost={false}
						currency="SAR"
					/>
				</InventoryClientContext.Provider>
			</MemoryRouter>
		</I18nProvider>,
	)
}

describe('RoutinesScreen', () => {
	it('lists the four templates, what the last run did, and a link to review the draft', async () => {
		const request = vi.fn(async () =>
			routines(),
		) as unknown as InventoryClient['request']
		renderScreen(request)
		expect(
			await screen.findByTestId('routine-count_low_stock'),
		).toBeInTheDocument()
		expect(screen.getByTestId('routine-weekly_waste')).toBeInTheDocument()
		expect(screen.getByTestId('routine-morning_brief')).toBeInTheDocument()
		expect(screen.getByTestId('routine-supplier_cutoff')).toBeInTheDocument()
		expect(
			screen.getByTestId('routine-runs-count_low_stock'),
		).toHaveTextContent('Drafted 1 order for you to review.')
		expect(screen.getByText('Review').closest('a')).toHaveAttribute(
			'href',
			'/acme/inventory/purchasing/orders/ord1',
		)
		// It says plainly that nothing is sent.
		expect(screen.getByTestId('routines')).toHaveTextContent(
			'never send anything',
		)
	})

	it('turns a routine on with the version it read', async () => {
		const request = vi.fn(async (path: string) =>
			path.startsWith('/routines?') ? routines() : {},
		) as unknown as InventoryClient['request']
		renderScreen(request)
		fireEvent.click(await screen.findByTestId('routine-toggle-morning_brief'))
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith(
				'/routines/morning_brief',
				expect.objectContaining({ method: 'PUT' }),
			),
		)
		const put = (
			request as unknown as ReturnType<typeof vi.fn>
		).mock.calls.find((call) => call[0] === '/routines/morning_brief')!
		expect(JSON.parse((put[1] as { body: string }).body)).toEqual({
			locationId: 'main',
			enabled: true,
			expectedVersion: 0,
		})
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
	})

	it('cannot turn on an order routine while Purchasing is off', async () => {
		const request = vi.fn(async () =>
			routines(),
		) as unknown as InventoryClient['request']
		renderScreen(request)
		const toggle = await screen.findByTestId('routine-toggle-supplier_cutoff')
		expect(toggle).toBeDisabled()
		expect(screen.getByTestId('routine-supplier_cutoff')).toHaveTextContent(
			'needs Purchasing',
		)
	})

	it('shows no switches to someone who cannot edit', async () => {
		const request = vi.fn(async () =>
			routines(),
		) as unknown as InventoryClient['request']
		renderScreen(request, false)
		await screen.findByTestId('routine-count_low_stock')
		expect(screen.queryByTestId('routine-toggle-morning_brief')).toBeNull()
	})
})
