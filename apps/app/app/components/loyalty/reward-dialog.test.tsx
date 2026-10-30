// @vitest-environment jsdom
import {
	type LoyaltyOperatorReward,
	type LoyaltyRewardDefinition,
} from '@repo/loyalty'
import { screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type LoyaltyCatalog } from '#app/utils/loyalty/catalog.ts'
import { type LoyaltyClient } from '#app/utils/loyalty/loyalty-client.ts'
import { renderStaff } from '#tests/staff-render.tsx'
import { RewardDialog } from './reward-dialog.tsx'

const CATALOG: LoyaltyCatalog = {
	items: [
		{ id: 'item_latte', name: 'Latte', detail: null },
		{ id: 'item_mocha', name: 'Mocha', detail: null },
	],
	categories: [],
}

function rewardWith(
	definition: LoyaltyRewardDefinition,
): LoyaltyOperatorReward {
	return {
		id: 'rwd_1',
		status: 'active',
		version: 2,
		currency: 'USD',
		definition,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
	}
}

const originalScrollIntoView = Element.prototype.scrollIntoView

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
})

afterEach(() => {
	vi.unstubAllGlobals()
	Element.prototype.scrollIntoView = originalScrollIntoView
})

function setup(reward: LoyaltyOperatorReward | null) {
	const client = {
		createReward: vi.fn(async (definition: LoyaltyRewardDefinition) =>
			rewardWith(definition),
		),
		updateReward: vi.fn(
			async (
				_id: string,
				input: { expectedVersion: number; definition: LoyaltyRewardDefinition },
			) => rewardWith(input.definition),
		),
	}
	const onSaved = vi.fn()
	renderStaff(
		<RewardDialog
			client={client as unknown as LoyaltyClient}
			reward={reward}
			catalog={CATALOG}
			onClose={() => {}}
			onSaved={onSaved}
		/>,
	)
	return { client, onSaved }
}

describe('RewardDialog', () => {
	it('creates a whole-order reward with no description', async () => {
		const { client, onSaved } = setup(null)
		await userEvent.type(
			await screen.findByTestId('loyalty-reward-name'),
			'Five off',
		)
		await userEvent.type(screen.getByTestId('loyalty-reward-cost'), '100')
		await userEvent.type(screen.getByTestId('loyalty-reward-amount'), '5.00')
		await userEvent.click(screen.getByTestId('loyalty-reward-save'))

		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
		expect(client.createReward).toHaveBeenCalledWith(
			{
				kind: 'order',
				name: 'Five off',
				description: null,
				pointsCost: 100,
				labels: { items: {}, categories: {} },
				discount: { type: 'fixed', amountMinor: 500 },
			},
			expect.any(String),
		)
	})

	it('keeps the chosen items of an edited reward', async () => {
		const { client } = setup(
			rewardWith({
				kind: 'items',
				name: 'Ten percent on drinks',
				description: null,
				pointsCost: 50,
				labels: {
					items: { item_latte: 'Latte', item_mocha: 'Mocha' },
					categories: {},
				},
				discount: { type: 'percent', percentBp: 1000, maxDiscountMinor: null },
				itemIds: ['item_latte', 'item_mocha'],
			}),
		)
		await userEvent.click(await screen.findByTestId('loyalty-reward-save'))
		await waitFor(() => expect(client.updateReward).toHaveBeenCalledTimes(1))
		const [id, input] = client.updateReward.mock.calls[0]!
		expect(id).toBe('rwd_1')
		expect(input.expectedVersion).toBe(2)
		expect(input.definition).toMatchObject({
			kind: 'items',
			itemIds: ['item_latte', 'item_mocha'],
			discount: { type: 'percent', percentBp: 1000, maxDiscountMinor: null },
			labels: {
				items: { item_latte: 'Latte', item_mocha: 'Mocha' },
				categories: {},
			},
		})
	})

	it('drops the menu name of an item that is no longer chosen', async () => {
		const { client } = setup(
			rewardWith({
				kind: 'items',
				name: 'Ten percent on drinks',
				description: null,
				pointsCost: 50,
				labels: {
					items: { item_latte: 'Latte', item_mocha: 'Mocha' },
					categories: {},
				},
				discount: { type: 'percent', percentBp: 1000, maxDiscountMinor: null },
				itemIds: ['item_latte', 'item_mocha'],
			}),
		)
		await userEvent.click(
			within(
				await screen.findByTestId('loyalty-reward-items-chosen'),
			).getByRole('button', { name: 'Remove Mocha' }),
		)
		await userEvent.click(screen.getByTestId('loyalty-reward-save'))
		await waitFor(() => expect(client.updateReward).toHaveBeenCalledTimes(1))
		const [, input] = client.updateReward.mock.calls[0]!
		expect(input.definition).toMatchObject({
			itemIds: ['item_latte'],
			labels: { items: { item_latte: 'Latte' }, categories: {} },
		})
	})

	it('reads and shows amounts in the reward currency exponent', async () => {
		const { client } = setup({
			...rewardWith({
				kind: 'order',
				name: 'Off the order',
				description: null,
				pointsCost: 100,
				labels: { items: {}, categories: {} },
				discount: { type: 'fixed', amountMinor: 1500 },
			}),
			currency: 'KWD',
		})
		const amount = await screen.findByTestId('loyalty-reward-amount')
		expect(amount).toHaveValue('1.500')
		await userEvent.clear(amount)
		await userEvent.type(amount, '1.234')
		await userEvent.click(screen.getByTestId('loyalty-reward-save'))
		await waitFor(() => expect(client.updateReward).toHaveBeenCalledTimes(1))
		expect(client.updateReward.mock.calls[0]![1].definition).toMatchObject({
			discount: { type: 'fixed', amountMinor: 1234 },
		})
	})

	it('changes the free item and saves the new name', async () => {
		const { client } = setup(
			rewardWith({
				kind: 'free_item',
				name: 'Free drink',
				description: 'Any size',
				pointsCost: 120,
				labels: { items: { item_latte: 'Latte' }, categories: {} },
				itemId: 'item_latte',
			}),
		)
		await userEvent.click(
			await screen.findByRole('button', { name: /^Free item/ }),
		)
		await userEvent.click(await screen.findByRole('option', { name: /^Mocha/ }))
		await userEvent.click(screen.getByTestId('loyalty-reward-save'))

		await waitFor(() => expect(client.updateReward).toHaveBeenCalledTimes(1))
		expect(client.updateReward.mock.calls[0]![1].definition).toEqual({
			kind: 'free_item',
			name: 'Free drink',
			description: 'Any size',
			pointsCost: 120,
			labels: { items: { item_mocha: 'Mocha' }, categories: {} },
			itemId: 'item_mocha',
		})
	})

	it('asks for the free item before saving', async () => {
		const { client } = setup(null)
		await userEvent.click(
			await screen.findByRole('combobox', { name: 'Reward type' }),
		)
		await userEvent.click(
			await screen.findByRole('option', { name: 'Free item' }),
		)
		await userEvent.type(
			screen.getByTestId('loyalty-reward-name'),
			'Free drink',
		)
		await userEvent.type(screen.getByTestId('loyalty-reward-cost'), '120')
		await userEvent.click(screen.getByTestId('loyalty-reward-save'))

		expect(await screen.findByText('Choose the free item.')).toBeTruthy()
		expect(client.createReward).not.toHaveBeenCalled()
	})

	it('asks for a discount above zero and reads Arabic-Indic digits', async () => {
		const { client } = setup(null)
		await userEvent.type(
			await screen.findByTestId('loyalty-reward-name'),
			'Five off',
		)
		await userEvent.type(screen.getByTestId('loyalty-reward-cost'), '1,000')
		const amount = screen.getByTestId('loyalty-reward-amount')
		await userEvent.type(amount, '0.00')
		await userEvent.click(screen.getByTestId('loyalty-reward-save'))
		expect(
			await screen.findByText('Enter the discount amount, like 5.00.'),
		).toBeTruthy()
		expect(client.createReward).not.toHaveBeenCalled()

		await userEvent.clear(amount)
		await userEvent.type(amount, '٥')
		await userEvent.click(screen.getByTestId('loyalty-reward-save'))
		await waitFor(() => expect(client.createReward).toHaveBeenCalledTimes(1))
		expect(client.createReward.mock.calls[0]![0]).toMatchObject({
			pointsCost: 1000,
			discount: { type: 'fixed', amountMinor: 500 },
		})
	})
})
