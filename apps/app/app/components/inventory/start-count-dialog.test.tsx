// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { StartCountDialog } from './start-count-dialog.tsx'

const COUNT = {
	id: 'cnt_9',
	locationId: 'main',
	listId: null,
	listName: null,
	status: 'counting',
	businessDate: '2026-11-09',
	startedBy: { kind: 'operator', id: 'u1' },
	itemTotal: 12,
	itemsCounted: 0,
	counters: [],
	sentForReviewAt: null,
	approvedAt: null,
	approvedBy: null,
	cancelledAt: null,
	createdAt: 1,
	version: 1,
}

function region(start: () => unknown = () => COUNT) {
	return vi.fn<InventoryClient['request']>(async (path, init) => {
		if (path.startsWith('/count-lists')) {
			return {
				lists: [
					{
						id: 'l1',
						locationId: 'main',
						name: 'Proteins daily',
						itemIds: ['a', 'b', 'c'],
						version: 1,
					},
				],
			}
		}
		if (path === '/counts' && init?.method === 'POST') return start()
		throw new Error(`unexpected request ${path}`)
	})
}

function setup(request: InventoryClient['request']) {
	const onOpenChange = vi.fn()
	renderInventory(
		<StartCountDialog
			open
			onOpenChange={onOpenChange}
			orgSlug="acme"
			locationId="main"
			search=""
		/>,
		{ request },
	)
	return { onOpenChange }
}

describe('StartCountDialog', () => {
	it('offers everything and each saved list, with how many items', async () => {
		setup(region())
		expect(await screen.findByText('Everything')).toBeInTheDocument()
		expect(await screen.findByText('Proteins daily')).toBeInTheDocument()
		expect(screen.getByText('3 items')).toBeInTheDocument()
	})

	it('starts a count of everything, asking only which list', async () => {
		const request = region()
		const { onOpenChange } = setup(request)
		await screen.findByText('Proteins daily')
		await userEvent.click(screen.getByTestId('start-count-submit'))
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
		const index = request.mock.calls.findIndex(([path]) => path === '/counts')
		expect(sentJson(request, index)).toMatchObject({
			locationId: 'main',
			listId: null,
		})
		expect(
			String((sentJson(request, index) as { clientId: string }).clientId),
		).toMatch(/^s-/)
	})

	it('starts a count of a saved list', async () => {
		const request = region()
		setup(request)
		await userEvent.click(await screen.findByTestId('start-count-list-l1'))
		await userEvent.click(screen.getByTestId('start-count-submit'))
		await waitFor(() =>
			expect(request.mock.calls.some(([path]) => path === '/counts')).toBe(
				true,
			),
		)
		const index = request.mock.calls.findIndex(([path]) => path === '/counts')
		expect(sentJson(request, index)).toMatchObject({ listId: 'l1' })
	})

	it('points to the count already in progress instead of starting a second', async () => {
		const { onOpenChange } = setup(
			region(() => {
				throw new OperatorRequestError(
					'in progress',
					'count_in_progress',
					409,
					{ error: 'count_in_progress', countId: 'cnt_open' },
				)
			}),
		)
		await screen.findByText('Proteins daily')
		await userEvent.click(screen.getByTestId('start-count-submit'))
		const note = await screen.findByTestId('start-count-in-progress')
		expect(note).toHaveTextContent('already in progress')
		expect(screen.getByText('Resume it').closest('a')).toHaveAttribute(
			'href',
			'/acme/inventory/counts/cnt_open',
		)
		expect(onOpenChange).not.toHaveBeenCalled()
	})

	it('shows why a start failed and keeps the dialog open', async () => {
		const { onOpenChange } = setup(
			region(() => {
				throw new TypeError('Failed to fetch')
			}),
		)
		await screen.findByText('Proteins daily')
		await userEvent.click(screen.getByTestId('start-count-submit'))
		expect(await screen.findByTestId('start-count-error')).toHaveTextContent(
			'We could not save this',
		)
		expect(onOpenChange).not.toHaveBeenCalled()
	})
})
