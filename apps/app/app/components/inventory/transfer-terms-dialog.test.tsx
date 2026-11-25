// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { TransferTermsDialog } from './transfer-terms-dialog.tsx'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	Element.prototype.scrollIntoView = vi.fn()
	window.localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

const PLACES = [
	{ id: 'central', name: 'Central kitchen' },
	{ id: 'branch', name: 'Downtown' },
]

const term = (over: Record<string, unknown> = {}) => ({
	itemId: 'flour',
	itemName: 'Flour',
	baseUnit: 'g',
	branchRequestable: true,
	version: 0,
	...over,
})

function region(withCost: boolean) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.startsWith('/transfer-terms?')) {
			return {
				terms: [
					withCost
						? term({
								priceMode: 'none',
								fixedPriceMicro: null,
								markupBp: null,
								costMicro: 300_000,
								effectivePriceMicro: 300_000,
								currency: 'SAR',
							})
						: term(),
				],
			}
		}
		if (path === '/transfer-terms/flour' && init?.method === 'PUT') {
			return term({ version: 1, branchRequestable: false })
		}
		if (path.startsWith('/transfers/owed')) {
			return {
				from: '2026-10-01',
				to: '2026-10-30',
				rows: [
					{
						toLocationId: 'branch',
						transfers: 2,
						lines: 3,
						owedMinor: 4500,
						costMinor: 3000,
						currency: 'SAR',
					},
				],
				owedMinor: 4500,
				costMinor: 3000,
				currency: 'SAR',
			}
		}
		throw new Error(`unexpected request ${path}`)
	})
}

const draw = (request: InventoryClient['request'], canSeeCost: boolean) =>
	renderInventory(
		<TransferTermsDialog
			locationId="central"
			places={PLACES}
			canSeeCost={canSeeCost}
			currency="SAR"
			open
			onOpenChange={vi.fn()}
		/>,
		{ request },
	)

describe('TransferTermsDialog (#526)', () => {
	it('switches an item off for branches with the version it read, without needing the cost grant', async () => {
		const request = region(false)
		draw(request, false)
		const row = await screen.findByTestId('term-flour')
		// No price, no price button, and no owed tab without the cost grant.
		expect(row).not.toHaveTextContent(/SAR/)
		expect(screen.queryByTestId('term-price-flour')).toBeNull()
		expect(screen.queryByTestId('terms-owed-tab')).toBeNull()
		await userEvent.click(within(row).getByTestId('term-requestable-flour'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([p]) => p === '/transfer-terms/flour'),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([p]) => p === '/transfer-terms/flour',
		)
		expect(sentJson(request, index)).toEqual({
			locationId: 'central',
			expectedVersion: 0,
			branchRequestable: false,
		})
	})

	it('sets a fixed price per kilo with the cost grant', async () => {
		const request = region(true)
		draw(request, true)
		const row = await screen.findByTestId('term-flour')
		expect(row).toHaveTextContent('No price (they pay cost)')
		await userEvent.click(within(row).getByTestId('term-price-flour'))
		await userEvent.click(within(row).getByTestId('term-mode-flour'))
		await userEvent.click(
			await screen.findByRole('option', { name: 'Fixed price' }),
		)
		await userEvent.type(within(row).getByTestId('term-fixed-flour'), '5.00')
		await userEvent.click(within(row).getByTestId('term-save-flour'))
		await waitFor(() =>
			expect(
				request.mock.calls.some(([p]) => p === '/transfer-terms/flour'),
			).toBe(true),
		)
		const index = request.mock.calls.findIndex(
			([p]) => p === '/transfer-terms/flour',
		)
		expect(sentJson(request, index)).toEqual({
			locationId: 'central',
			expectedVersion: 0,
			priceMode: 'fixed',
			fixedPrice: { priceMinor: 500, per: 'kg', currency: 'SAR' },
		})
	})

	it('lists what each branch owes, at the transfer price and at cost', async () => {
		draw(region(true), true)
		await userEvent.click(await screen.findByTestId('terms-owed-tab'))
		const row = await screen.findByTestId('owed-branch')
		expect(row).toHaveTextContent('Downtown')
		expect(row).toHaveTextContent('45.00')
		expect(row).toHaveTextContent('30.00')
	})
})
