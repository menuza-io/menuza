// @vitest-environment jsdom
import { screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderInventory } from '#tests/inventory-render.tsx'
import { LastCountedText, StockList } from './stock-list.tsx'

const DAY = 24 * 60 * 60 * 1000

function item(id: string, name: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		name,
		category: 'meat',
		kind: 'bought',
		baseUnit: 'g',
		archived: false,
		version: 1,
		onHand: 4_000_000,
		countUnit: 'kg',
		units: [],
		areaIds: [],
		orderBelowQuantity: null,
		fillUpToQuantity: null,
		status: 'ok',
		lastCountedAt: Date.now() - 2 * DAY,
		...extra,
	}
}

function setup(items: unknown[], onToggleKey?: (item: { id: string }) => void) {
	return renderInventory(
		<StockList
			items={items as never}
			basePath="/acme/inventory/stock"
			search=""
			areaNames={new Map()}
			showValue={false}
			currency="SAR"
			showDaysLeft={false}
			onToggleKey={onToggleKey as never}
		/>,
		{ request: vi.fn() as never },
	)
}

describe('StockList last counted and key items (#490, #491)', () => {
	it('shows when each item was last counted and flags items over 14 days or never counted', () => {
		setup([
			item('fresh', 'Fresh chicken'),
			item('old', 'Old rice', { lastCountedAt: Date.now() - 20 * DAY }),
			item('never', 'Never lamb', { lastCountedAt: null }),
		])
		expect(
			within(screen.getByTestId('stock-last-counted-fresh')).getByTestId(
				'last-counted',
			),
		).toBeInTheDocument()
		expect(
			within(screen.getByTestId('stock-last-counted-old')).getByTestId(
				'last-counted-stale',
			),
		).toBeInTheDocument()
		expect(
			within(screen.getByTestId('stock-last-counted-never')).getByTestId(
				'last-counted-never',
			),
		).toHaveTextContent('Never counted')
	})

	it('stars and unstars an item for a member who can edit', async () => {
		const onToggleKey = vi.fn()
		setup(
			[
				item('k', 'Saffron', { isKey: true }),
				item('n', 'Rice', { isKey: false }),
			],
			onToggleKey,
		)
		const on = screen.getByTestId('stock-key-k')
		const off = screen.getByTestId('stock-key-n')
		expect(on).toHaveAttribute('aria-pressed', 'true')
		expect(off).toHaveAttribute('aria-pressed', 'false')
		await userEvent.click(off)
		expect(onToggleKey).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'n' }),
		)
	})

	it('only shows the star to a member who cannot edit', () => {
		setup([item('k', 'Saffron', { isKey: true }), item('n', 'Rice')])
		expect(screen.queryByTestId('stock-key-k')).toBeNull()
		expect(screen.getAllByLabelText('Key item').length).toBeGreaterThan(0)
	})

	it('LastCountedText marks exactly the 14 day line', () => {
		const now = 100 * DAY
		renderInventory(
			<>
				<LastCountedText lastCountedAt={now - 14 * DAY} now={now} />
				<LastCountedText lastCountedAt={now - 14 * DAY - 1} now={now} />
			</>,
			{ request: vi.fn() as never },
		)
		expect(screen.getAllByTestId('last-counted')).toHaveLength(1)
		expect(screen.getAllByTestId('last-counted-stale')).toHaveLength(1)
	})
})
