// @vitest-environment jsdom

import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { toast } from 'sonner'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import {
	type InventoryClient,
	InventoryClientContext,
} from './inventory-client-provider.tsx'
import { SoldOutPanel } from './sold-out-panel.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const ENTRY = {
	id: 'so1',
	locationId: 'main',
	entityType: 'item' as const,
	entityId: 'dish1',
	causeItemId: 'it1',
	causeItemName: 'Pita bread',
	state: 'out' as const,
	soldAt: 1,
}

function renderPanel(
	request: InventoryClient['request'],
	props: { canEdit?: boolean } = {},
) {
	return render(
		<I18nProvider i18n={i18n}>
			<InventoryClientContext.Provider value={{ orgSlug: 'acme', request }}>
				<SoldOutPanel
					locationId="main"
					canEdit={props.canEdit ?? true}
					dishes={[{ id: 'dish1', name: 'Shawarma' }]}
					options={[{ id: 'opt1', name: 'Extra cheese' }]}
				/>
			</InventoryClientContext.Provider>
		</I18nProvider>,
	)
}

describe('SoldOutPanel', () => {
	it('lists what stock took off, by name and cause, and puts one back', async () => {
		let entries = [
			ENTRY,
			{
				...ENTRY,
				id: 'so2',
				entityType: 'modifier_option' as const,
				entityId: 'opt1',
			},
		]
		const request = vi.fn(async (path: string) => {
			if (path.startsWith('/sold-out?')) {
				return { locationId: 'main', entries }
			}
			entries = entries.filter((entry) => entry.id !== 'so1')
			return {}
		}) as unknown as InventoryClient['request']
		renderPanel(request)
		const row = await screen.findByTestId('today-sold-out-dish1')
		expect(row).toHaveTextContent('Shawarma')
		expect(row).toHaveTextContent('Pita bread ran out')
		expect(screen.getByTestId('today-sold-out-opt1')).toHaveTextContent(
			'Extra cheese',
		)
		fireEvent.click(screen.getByTestId('today-sold-out-undo-dish1'))
		await waitFor(() =>
			expect(request).toHaveBeenCalledWith('/sold-out/so1/undo', {
				method: 'POST',
				body: '{}',
			}),
		)
		await waitFor(() => expect(toast.success).toHaveBeenCalled())
		await waitFor(() =>
			expect(screen.queryByTestId('today-sold-out-dish1')).toBeNull(),
		)
	})

	it('offers no undo to someone who cannot edit, and shows nothing when nothing is off', async () => {
		const request = vi.fn(async () => ({
			locationId: 'main',
			entries: [ENTRY],
		})) as unknown as InventoryClient['request']
		const { unmount } = renderPanel(request, { canEdit: false })
		await screen.findByTestId('today-sold-out-dish1')
		expect(screen.queryByTestId('today-sold-out-undo-dish1')).toBeNull()
		unmount()

		const empty = vi.fn(async () => ({
			locationId: 'main',
			entries: [{ ...ENTRY, state: 'undone' as const }],
		})) as unknown as InventoryClient['request']
		renderPanel(empty)
		await waitFor(() => expect(empty).toHaveBeenCalled())
		await waitFor(() =>
			expect(screen.queryByTestId('today-sold-out')).toBeNull(),
		)
	})

	it('goes away quietly when the region says recipes are not available', async () => {
		const request = vi.fn(async () => {
			throw new OperatorRequestError('no', 'feature_disabled', 403)
		}) as unknown as InventoryClient['request']
		renderPanel(request)
		await waitFor(() => expect(request).toHaveBeenCalled())
		expect(screen.queryByTestId('today-sold-out')).toBeNull()
	})
})
