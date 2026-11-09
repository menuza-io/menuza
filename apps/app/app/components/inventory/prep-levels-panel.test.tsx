// @vitest-environment jsdom
import { type PrepLevels } from '@repo/inventory'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { PrepLevelsPanel } from './prep-levels-panel.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
	vi.clearAllMocks()
})

const levels = (): PrepLevels => ({
	locationId: 'main',
	stations: [
		{ id: 'kitchen', name: 'Kitchen' },
		{ id: 'grill', name: 'Grill' },
	],
	items: [
		{
			itemId: 'i1',
			name: 'Garlic sauce',
			baseUnit: 'ml',
			countUnit: 'l',
			units: [],
			stationId: null,
			weekdays: [null, null, null, null, null, 8_000_000, null],
			usual: null,
			batchSize: 4_000_000,
			version: 2,
		},
		{
			itemId: 'i2',
			name: 'Dough',
			baseUnit: 'g',
			countUnit: 'kg',
			units: [],
			stationId: null,
			weekdays: [null, null, null, null, null, null, null],
			usual: 5_000_000,
			batchSize: null,
			version: 0,
		},
		{
			itemId: 'i3',
			name: 'Pickles',
			baseUnit: 'g',
			countUnit: 'kg',
			units: [],
			stationId: null,
			weekdays: [null, null, null, null, null, null, null],
			usual: null,
			batchSize: null,
			version: 0,
		},
	],
})

const region = () =>
	vi.fn<InventoryClient['request']>(async (path, init) =>
		init?.method === 'PUT' ? levels().items[0]! : levels(),
	)

describe('PrepLevelsPanel', () => {
	it('lists made items and what is set for each', async () => {
		renderInventory(<PrepLevelsPanel locationId="main" canEdit />, {
			request: region(),
		})
		expect(await screen.findByTestId('prep-level-i1')).toHaveTextContent(
			'Set for 1 of 7 days',
		)
		expect(screen.getByTestId('prep-level-i2')).toHaveTextContent(
			'Every day: 5 kg',
		)
		expect(screen.getByTestId('prep-level-i3')).toHaveTextContent(
			'Not planned. Set a level to plan it.',
		)
	})

	it('saves the weekdays in the count unit with the version it read', async () => {
		const request = region()
		renderInventory(<PrepLevelsPanel locationId="main" canEdit />, { request })
		fireEvent.click(await screen.findByTestId('prep-level-edit-i1'))
		const dialog = await screen.findByTestId('prep-levels-dialog')
		// Friday (5) was 8 L; set Sunday (0) to 6 L.
		expect(within(dialog).getByTestId('prep-level-day-5')).toHaveValue('8')
		fireEvent.change(within(dialog).getByTestId('prep-level-day-0'), {
			target: { value: '6' },
		})
		fireEvent.click(within(dialog).getByTestId('prep-levels-save'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([, init]) => init?.method === 'PUT'),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([, init]) => init?.method === 'PUT',
		)
		expect(sentJson(request, index)).toEqual({
			locationId: 'main',
			itemId: 'i1',
			stationId: null,
			weekdays: [6_000_000, null, null, null, null, 8_000_000, null],
			expectedVersion: 2,
		})
	})

	it('sends nothing while a weekday is not a number', async () => {
		const request = region()
		renderInventory(<PrepLevelsPanel locationId="main" canEdit />, { request })
		fireEvent.click(await screen.findByTestId('prep-level-edit-i1'))
		const dialog = await screen.findByTestId('prep-levels-dialog')
		fireEvent.change(within(dialog).getByTestId('prep-level-day-1'), {
			target: { value: 'lots' },
		})
		fireEvent.click(within(dialog).getByTestId('prep-levels-save'))
		expect(
			await within(dialog).findByText('Enter a number.'),
		).toBeInTheDocument()
		expect(request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(
			false,
		)
	})

	it('offers no editing to someone who cannot change stock', async () => {
		renderInventory(<PrepLevelsPanel locationId="main" canEdit={false} />, {
			request: region(),
		})
		await screen.findByTestId('prep-level-i1')
		expect(screen.queryByTestId('prep-level-edit-i1')).toBeNull()
	})
})
