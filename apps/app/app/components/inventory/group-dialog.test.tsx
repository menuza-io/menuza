// @vitest-environment jsdom
import { type ItemGroup } from '@repo/inventory'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { renderInventory, sentJson } from '#tests/inventory-render.tsx'
import { GroupDialog } from './group-dialog.tsx'

const GROUP: ItemGroup = {
	id: 'g1',
	name: 'Olive oil',
	category: 'sauces',
	baseUnit: 'ml',
	version: 3,
	autoSoldOut: false,
	archived: false,
	onHand: 500_000,
	members: [
		{
			itemId: 'a',
			name: 'Oil A',
			rank: 0,
			baseUnit: 'ml',
			memberQuantity: 1,
			groupQuantity: 1,
			onHand: 200_000,
			onHandInGroupUnit: 200_000,
			archived: false,
		},
		{
			itemId: 'b',
			name: 'Oil B',
			rank: 1,
			baseUnit: 'ml',
			memberQuantity: 1,
			groupQuantity: 1,
			onHand: 300_000,
			onHandInGroupUnit: 300_000,
			archived: false,
		},
	],
}

describe('Group products (#495)', () => {
	it('reorders members so the next one is used first and saves with the version', async () => {
		const user = userEvent.setup()
		const request = vi.fn<InventoryClient['request']>(async () => GROUP)
		const onSaved = vi.fn()
		renderInventory(
			<GroupDialog
				group={GROUP}
				locationId="main"
				open
				onOpenChange={() => {}}
				onSaved={onSaved}
			/>,
			{ request },
		)
		const members = await screen.findByTestId('group-members')
		expect(members.children[0]).toHaveTextContent('First: Oil A')
		expect(members.children[1]).toHaveTextContent('Then: Oil B')
		await user.click(
			within(members.children[1] as HTMLElement).getByRole('button', {
				name: 'Move up',
			}),
		)
		expect(members.children[0]).toHaveTextContent('First: Oil B')
		await user.click(screen.getByTestId('group-save'))
		await waitFor(() => expect(onSaved).toHaveBeenCalled())
		expect(request).toHaveBeenCalledWith(
			'/groups/g1',
			expect.objectContaining({ method: 'PATCH' }),
		)
		expect(sentJson(request, 0)).toEqual({
			expectedVersion: 3,
			name: 'Olive oil',
			members: [
				{ itemId: 'b', memberQuantity: 1, groupQuantity: 1 },
				{ itemId: 'a', memberQuantity: 1, groupQuantity: 1 },
			],
		})
	})

	it('needs a name and at least one product before it can be saved', async () => {
		renderInventory(
			<GroupDialog
				group={null}
				locationId="main"
				open
				onOpenChange={() => {}}
				onSaved={() => {}}
			/>,
			{ request: vi.fn() },
		)
		expect(await screen.findByTestId('group-save')).toBeDisabled()
	})
})
