// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { type Freshness } from '@repo/inventory'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FreshnessPanel } from './freshness-panel.tsx'
import {
	type InventoryClient,
	InventoryClientContext,
} from './inventory-client-provider.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const row = (over: Record<string, unknown>) => ({
	lotId: 'lot1',
	itemId: 'it1',
	itemName: 'Yoghurt',
	baseUnit: 'g' as const,
	countUnit: null,
	useByDate: '2026-11-20',
	remaining: 2000,
	daysLeft: -3,
	status: 'expired' as const,
	...over,
})

const FRESHNESS: Freshness = {
	locationId: 'main',
	date: '2026-11-23',
	expired: [row({})],
	useFirst: [
		row({
			lotId: 'lot2',
			itemName: 'Cream',
			daysLeft: 0,
			status: 'today',
			useByDate: '2026-11-23',
		}),
		row({
			lotId: 'lot3',
			itemName: 'Milk',
			daysLeft: 2,
			status: 'soon',
			useByDate: '2026-11-25',
		}),
	],
	expiredCount: 1,
	useFirstCount: 2,
}

function renderPanel(
	request: InventoryClient['request'],
	freshness: Freshness = FRESHNESS,
	canEdit = true,
) {
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<FreshnessPanel
					locationId="main"
					freshness={freshness}
					canEdit={canEdit}
					canSeeCost={false}
					currency="SAR"
				/>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('FreshnessPanel', () => {
	it('lists what expired and what to use first, soonest first', () => {
		renderPanel(vi.fn() as unknown as InventoryClient['request'])
		expect(screen.getByTestId('today-expired-lot1')).toHaveTextContent(
			'Yoghurt',
		)
		const first = screen.getByTestId('today-use-first')
		expect(first).toHaveTextContent('Cream')
		expect(first).toHaveTextContent('expires today')
		expect(first).toHaveTextContent('expires in 2 days')
	})

	it('throws an expired date away as waste in one tap, naming that lot', async () => {
		const request = vi.fn(
			async () => ({}),
		) as unknown as InventoryClient['request']
		renderPanel(request)
		fireEvent.click(screen.getByTestId('today-expired-waste-lot1'))
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith(
				'/lots/lot1/waste',
				expect.objectContaining({ method: 'POST' }),
			),
		)
		const call = (request as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
		expect(JSON.parse((call[1] as { body: string }).body)).toMatchObject({
			locationId: 'main',
		})
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
	})

	it('shows no waste button to someone who cannot edit', () => {
		renderPanel(
			vi.fn() as unknown as InventoryClient['request'],
			FRESHNESS,
			false,
		)
		expect(screen.queryByTestId('today-expired-waste-lot1')).toBeNull()
	})

	it('renders nothing while no date needs watching', () => {
		const { container } = renderPanel(
			vi.fn() as unknown as InventoryClient['request'],
			{
				...FRESHNESS,
				expired: [],
				useFirst: [],
				expiredCount: 0,
				useFirstCount: 0,
			},
		)
		expect(container).toBeEmptyDOMElement()
	})
})
