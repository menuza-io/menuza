// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { type QrPublicTab } from '@repo/common/qr-ordering'
import {
	type LoyaltyCheckoutQuote,
	type LoyaltyOrderReward,
} from '@repo/loyalty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLACEMENT_WAIT_MS } from './reward-quotes.ts'
import { mountTabRewards, type TabRewardsDeps } from './tab-rewards.ts'
import {
	testProgram,
	testQuote,
	testReward,
	testRewardQuote,
} from './test-fixtures.ts'
import { testLoyaltyLabels } from './test-labels.ts'
import { LoyaltyClientError } from '~/lib/loyalty-client'

const labels = testLoyaltyLabels()
const tabToken = `tab-1.1.${'b'.repeat(64)}`
const coffee: LoyaltyOrderReward = {
	rewardId: 'rwd_coffee',
	rewardVersion: 1,
	expectedDiscountMinor: 500,
	targetLineId: null,
}

function testTab(overrides: Partial<QrPublicTab> = {}): QrPublicTab {
	return {
		id: 'tab-1',
		tabNumber: '007',
		status: 'open',
		paymentStatus: 'unpaid',
		table: { id: 'tbl-1', label: 'T4', locationId: 'loc-1' },
		openedAt: '2030-01-01T12:00:00.000Z',
		closedAt: null,
		rounds: [],
		totals: {
			currency: 'USD',
			subtotalCents: 2_000,
			taxCents: 165,
			taxInclusive: false,
			tipCents: 0,
			loyaltyDiscountCents: 0,
			totalCents: 2_165,
		},
		roundsPending: false,
		...overrides,
	}
}

function testRound(
	id: string,
	names: string[],
): QrPublicTab['rounds'][number] {
	return {
		id,
		number: '1',
		status: 'served',
		createdAt: null,
		subtotalCents: 1_000,
		taxCents: 0,
		totalCents: 1_000,
		lines: names.map((itemName) => ({
			itemName,
			quantity: 1,
			totalCents: 500,
			options: [],
			instructions: null,
		})),
	}
}

/**
 * The region's tab quote: a picked reward comes off before tax, and the tip
 * is a share of the subtotal before the reward.
 */
function tabQuote(
	selection: LoyaltyOrderReward | null,
	tipPercent: number,
): LoyaltyCheckoutQuote {
	const picked = selection?.rewardId === 'rwd_coffee'
	const discountMinor = picked ? 500 : 0
	const taxMinor = picked ? 124 : 165
	const tipMinor = Math.round((2_000 * tipPercent) / 100)
	return testQuote({
		selectedRewardId: picked ? 'rwd_coffee' : null,
		totals: {
			subtotalMinor: 2_000,
			discountMinor,
			taxMinor,
			taxInclusive: false,
			tipMinor,
			deliveryFeeMinor: 0,
			totalMinor: 2_000 - discountMinor + taxMinor + tipMinor,
		},
	})
}

function setup(overrides: Partial<TabRewardsDeps> = {}) {
	document.body.innerHTML = `
		<div id="tab-rewards" class="hidden">
			<p id="balance"></p>
			<div id="options"></div>
		</div>
		<p id="notice" role="status"></p>`
	let tip = 0
	const client = {
		program: vi.fn(() => Promise.resolve(testProgram())),
		tabQuote: vi.fn(
			(input: {
				tabToken: string
				tipPercent: number
				selection: LoyaltyOrderReward | null
			}) => Promise.resolve(tabQuote(input.selection, input.tipPercent)),
		),
	}
	const onChange = vi.fn()
	const rewards = mountTabRewards({
		section: document.getElementById('tab-rewards')!,
		options: document.getElementById('options')!,
		balance: document.getElementById('balance'),
		notice: document.getElementById('notice'),
		locale: 'en',
		formatMoney: (minor) => `$${(minor / 100).toFixed(2)}`,
		tipPercent: () => tip,
		tipMinor: () => Math.round((2_000 * tip) / 100),
		onChange,
		labels,
		client,
		signedIn: () => true,
		debounceMs: 0,
		...overrides,
	})
	const section = document.getElementById('tab-rewards')!
	return {
		rewards,
		client,
		onChange,
		section,
		notice: document.getElementById('notice')!,
		setTip(next: number) {
			tip = next
		},
		/** Waits until the region's answer is on screen. */
		shown: () =>
			vi.waitFor(() => {
				expect(section).not.toHaveClass('hidden')
				expect(section).not.toHaveAttribute('aria-busy')
			}),
		pick(rewardId: string) {
			const input = document.querySelector<HTMLInputElement>(
				`input[name="tab-reward"][value="${rewardId}"]`,
			)!
			input.checked = true
			input.dispatchEvent(new Event('change', { bubbles: true }))
		},
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('tab rewards', () => {
	it('pays the tab as it is until the sheet has priced it', async () => {
		const t = setup()
		expect(t.rewards.amountMinor(2_165, 200)).toBe(2_365)
		await expect(t.rewards.placement()).resolves.toEqual({
			ok: true,
			loyalty: null,
		})
		expect(t.client.tabQuote).not.toHaveBeenCalled()
	})

	it('prices the open tab with its code', async () => {
		const t = setup()
		t.setTip(10)
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		expect(t.client.tabQuote).toHaveBeenCalledWith({
			tabToken,
			tipPercent: 10,
			selection: null,
			signal: expect.any(AbortSignal),
		})
		expect(t.rewards.amountMinor(2_165, 200)).toBe(2_365)
	})

	it("charges the region's total for a picked reward, tip on top", async () => {
		const t = setup()
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		t.pick('rwd_coffee')
		// Being priced: the sheet shows no amount it cannot stand by.
		expect(t.rewards.amountMinor(2_165, 200)).toBeNull()
		await expect(t.rewards.placement()).resolves.toEqual({
			ok: true,
			loyalty: coffee,
		})
		expect(t.rewards.amountMinor(2_165, 200)).toBe(1_824)
		// The tip never changes what a reward is worth: no new quote.
		t.setTip(20)
		expect(t.rewards.amountMinor(2_165, 400)).toBe(2_024)
		expect(t.client.tabQuote).toHaveBeenCalledTimes(2)
		expect(t.onChange).toHaveBeenCalled()
	})

	it('announces the amount the pay button shows, with the tip chosen now', async () => {
		const t = setup()
		t.setTip(10)
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		// The guest moves the tip while the pick is priced at the old one.
		t.client.tabQuote.mockImplementationOnce((input) => {
			t.setTip(20)
			return Promise.resolve(tabQuote(input.selection, input.tipPercent))
		})
		t.pick('rwd_coffee')
		await t.rewards.placement()
		expect(t.rewards.amountMinor(2_165, 400)).toBe(2_024)
		expect(t.notice).toHaveTextContent(
			'Reward applied: $5.00 off. New total: $20.24',
		)
	})

	it('names the tab lines a reward lands on', async () => {
		const bagel = testReward({
			kind: 'items',
			itemIds: ['itm_bagel'],
			labels: { items: { itm_bagel: 'Bagel' }, categories: {} },
		})
		const t = setup({
			client: {
				program: vi.fn(() =>
					Promise.resolve(testProgram({ rewards: [bagel] })),
				),
				tabQuote: vi.fn(() =>
					Promise.resolve(
						testQuote({
							rewards: [
								testRewardQuote({
									lines: [
										{ lineId: 'ord-2:0', discountMinor: 0, rewardUnits: 0 },
										{ lineId: 'ord-2:1', discountMinor: 500, rewardUnits: 0 },
									],
								}),
							],
						}),
					),
				),
			},
		})
		t.rewards.open(
			testTab({
				rounds: [
					testRound('ord-1', ['Bagel', 'Latte']),
					testRound('ord-2', ['Latte', 'Bagel']),
				],
			}),
			tabToken,
		)
		await t.shown()
		expect(document.querySelector('[data-reward-lines]')!.textContent).toBe(
			'Used on \u2068Bagel\u2069',
		)
	})

	it('re-prices every time the sheet opens', async () => {
		const t = setup()
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		expect(t.client.tabQuote).toHaveBeenCalledTimes(2)
		expect(t.client.program).toHaveBeenCalledTimes(1)
	})

	it('holds back the amount of a pick while a changed tab is re-priced', async () => {
		const t = setup()
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		t.pick('rwd_coffee')
		await t.rewards.placement()
		expect(t.rewards.amountMinor(2_165, 0)).toBe(1_624)
		t.onChange.mockClear()
		// Another round arrived while the sheet was closed.
		const bigger = testTab({
			totals: {
				...testTab().totals,
				subtotalCents: 2_500,
				taxCents: 206,
				totalCents: 2_706,
			},
		})
		t.rewards.open(bigger, tabToken)
		expect(t.onChange).toHaveBeenCalled()
		expect(t.rewards.amountMinor(2_706, 0)).toBeNull()
		await expect(t.rewards.placement()).resolves.toEqual({
			ok: true,
			loyalty: coffee,
		})
	})

	it('stops a pick that leaves nothing to pay from the phone', async () => {
		const t = setup()
		t.client.tabQuote.mockImplementation((input) =>
			Promise.resolve(
				input.selection
					? testQuote({
							rewards: [testRewardQuote({ discountMinor: 2_000 })],
							selectedRewardId: 'rwd_coffee',
							totals: {
								subtotalMinor: 2_000,
								discountMinor: 2_000,
								taxMinor: 0,
								taxInclusive: false,
								tipMinor: 300,
								deliveryFeeMinor: 0,
								totalMinor: 300,
							},
						})
					: testQuote({
							rewards: [testRewardQuote({ discountMinor: 2_000 })],
						}),
			),
		)
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		t.pick('rwd_coffee')
		// The tip alone is still owed, but a tip is never paid on its own.
		await expect(t.rewards.placement()).resolves.toEqual({
			ok: false,
			message: labels.pickerCoversTotal,
		})
	})

	it('stops a pick the re-price dropped', async () => {
		const t = setup()
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		t.client.tabQuote.mockResolvedValueOnce(
			testQuote({ rewards: [testRewardQuote({ affordable: false })] }),
		)
		t.pick('rwd_coffee')
		await expect(t.rewards.placement()).resolves.toEqual({
			ok: false,
			message: labels.pickerFailed,
		})
		expect(t.notice).toHaveTextContent(labels.pickerRemoved)
	})

	it('frees the pay sheet when the region does not answer', async () => {
		const t = setup()
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		vi.useFakeTimers()
		t.client.tabQuote.mockImplementation(() => new Promise(() => {}))
		t.pick('rwd_coffee')
		const placing = t.rewards.placement()
		await vi.advanceTimersByTimeAsync(PLACEMENT_WAIT_MS)
		await expect(placing).resolves.toEqual({
			ok: false,
			message: labels.pickerUnconfirmed,
		})
	})

	it('explains a refused payment only when it was about the reward', async () => {
		const t = setup()
		t.rewards.open(testTab(), tabToken)
		await t.shown()
		t.pick('rwd_coffee')
		await t.rewards.placement()
		expect(t.rewards.refused('tab_paying', true)).toBeNull()
		expect(t.rewards.refused('reward_covers_total', true)).toBe(
			labels.pickerCoversTotal,
		)
		expect(t.rewards.refused('cart_changed', true)).toBe(labels.pickerFailed)
	})

	it('starts over on a new tab after another member claimed the last one', async () => {
		const t = setup()
		t.client.tabQuote.mockRejectedValueOnce(
			new LoyaltyClientError('already_claimed', 409),
		)
		t.rewards.open(testTab(), tabToken)
		await vi.waitFor(() =>
			expect(t.notice).toHaveTextContent(labels.pickerTabClaimed),
		)
		expect(t.section).toHaveClass('hidden')
		// The same tab stays claimed.
		t.rewards.open(testTab(), tabToken)
		expect(t.client.tabQuote).toHaveBeenCalledTimes(1)

		const nextToken = `tab-2.1.${'c'.repeat(64)}`
		t.rewards.open(testTab({ id: 'tab-2' }), nextToken)
		await t.shown()
		expect(t.notice).toBeEmptyDOMElement()
		expect(t.client.tabQuote).toHaveBeenLastCalledWith({
			tabToken: nextToken,
			tipPercent: 0,
			selection: null,
			signal: expect.any(AbortSignal),
		})
		expect(document.querySelectorAll('#options')).toHaveLength(1)
		t.pick('rwd_coffee')
		await expect(t.rewards.placement()).resolves.toEqual({
			ok: true,
			loyalty: coffee,
		})
	})

	it('asks nothing once the guest has signed out', async () => {
		const t = setup({ signedIn: () => false })
		t.rewards.open(testTab(), tabToken)
		await expect(t.rewards.placement()).resolves.toEqual({
			ok: true,
			loyalty: null,
		})
		expect(t.client.tabQuote).not.toHaveBeenCalled()
		expect(t.section).toHaveClass('hidden')
	})
})
