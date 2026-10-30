// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import {
	type LoyaltyCheckoutQuote,
	type LoyaltyOrderReward,
} from '@repo/loyalty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	createRewardQuotes,
	MAX_RETRY_AFTER_MS,
	PLACEMENT_WAIT_MS,
	spendableRewards,
	type RewardQuoteDeps,
} from './reward-quotes.ts'
import {
	testProgram,
	testQuote,
	testReward,
	testRewardQuote,
} from './test-fixtures.ts'
import { testLoyaltyLabels } from './test-labels.ts'
import { LoyaltyClientError } from '~/lib/loyalty-client'

const labels = testLoyaltyLabels()
const formatMoney = (minor: number) => `$${(minor / 100).toFixed(2)}`
const coffee: LoyaltyOrderReward = {
	rewardId: 'rwd_coffee',
	rewardVersion: 1,
	expectedDiscountMinor: 500,
	targetLineId: null,
}

/** The region's answer for a pick: the reward's saving off the plain totals. */
function quoteFor(
	selection: LoyaltyOrderReward | null,
	overrides: Partial<LoyaltyCheckoutQuote> = {},
): LoyaltyCheckoutQuote {
	const plain = testQuote(overrides)
	const row = selection
		? plain.rewards.find((entry) => entry.rewardId === selection.rewardId)
		: undefined
	if (!row?.applicable || !row.affordable) return plain
	return testQuote({
		...overrides,
		selectedRewardId: row.rewardId,
		totals: {
			...plain.totals,
			discountMinor: row.discountMinor,
			totalMinor: plain.totals.totalMinor - row.discountMinor,
		},
		availableAfter: plain.balance.available - row.pointsCost,
	})
}

function setup(overrides: Partial<RewardQuoteDeps> = {}) {
	document.body.innerHTML = `
		<section id="card" class="hidden">
			<p id="balance"></p>
			<div id="options"></div>
		</section>
		<p id="notice" role="status"></p>`
	let key: string | null = 'cart-1'
	let signedIn = true
	const fetchQuote = vi.fn(
		(selection: LoyaltyOrderReward | null, _signal?: AbortSignal) =>
			Promise.resolve(quoteFor(selection)),
	)
	const loadRewards = vi.fn(() =>
		Promise.resolve<ReturnType<typeof testReward>[] | null>([testReward()]),
	)
	const onChange = vi.fn()
	const quotes = createRewardQuotes({
		section: document.getElementById('card')!,
		options: document.getElementById('options')!,
		balance: document.getElementById('balance'),
		notice: document.getElementById('notice'),
		labels,
		locale: 'en',
		formatMoney,
		signedIn: () => signedIn,
		loadRewards,
		pricingKey: () => key,
		fetchQuote,
		onChange,
		coversTotalMessage: labels.pickerCoversOrder,
		debounceMs: 0,
		...overrides,
	})
	return {
		quotes,
		fetchQuote,
		loadRewards,
		onChange,
		section: document.getElementById('card')!,
		balance: document.getElementById('balance')!,
		notice: document.getElementById('notice')!,
		setKey(next: string | null) {
			key = next
		},
		signOut() {
			signedIn = false
		},
		radio(rewardId: string) {
			return document.querySelector<HTMLInputElement>(
				`#options input[value="${rewardId}"]`,
			)
		},
		pick(rewardId: string) {
			const input = document.querySelector<HTMLInputElement>(
				`#options input[value="${rewardId}"]`,
			)!
			input.checked = true
			input.dispatchEvent(new Event('change', { bubbles: true }))
		},
	}
}

/** Prices the bill once, as the first render does. */
async function priced(overrides: Partial<RewardQuoteDeps> = {}) {
	const t = setup(overrides)
	t.quotes.sync()
	await t.quotes.settled()
	return t
}

afterEach(() => {
	vi.useRealTimers()
})

describe('reward quotes', () => {
	it('asks nothing for a guest who is not signed in', async () => {
		const t = setup({ signedIn: () => false })
		t.quotes.sync()
		await t.quotes.settled()
		expect(t.loadRewards).not.toHaveBeenCalled()
		expect(t.fetchQuote).not.toHaveBeenCalled()
		expect(t.section).toHaveClass('hidden')
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: null })
	})

	it('prices the bill and lists the rewards with the balance', async () => {
		const t = await priced()
		expect(t.loadRewards).toHaveBeenCalledTimes(1)
		expect(t.fetchQuote).toHaveBeenCalledWith(null, expect.any(AbortSignal))
		expect(t.section).not.toHaveClass('hidden')
		expect(t.section).not.toHaveAttribute('aria-busy')
		expect(t.balance).toHaveTextContent('You have 150 points')
		expect(t.radio('')).toBeChecked()
		expect(t.radio('rwd_coffee')).toBeEnabled()
		expect(t.quotes.freshQuote()?.totals.totalMinor).toBe(2_165)
		expect(t.onChange).toHaveBeenCalled()
	})

	it('sends a pick only once the region has priced it', async () => {
		const t = await priced()
		t.pick('rwd_coffee')
		// Picked, not yet priced: nothing goes out, the saving shows already.
		expect(t.quotes.placementPick()).toEqual({ ok: false })
		expect(t.quotes.freshQuote()).toBeNull()
		expect(t.quotes.displayDiscountMinor()).toBe(500)
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenLastCalledWith(
			coffee,
			expect.any(AbortSignal),
		)
		expect(t.quotes.freshQuote()?.totals.totalMinor).toBe(1_665)
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: coffee })
		expect(t.quotes.rewardName()).toBe('Free coffee')
		expect(t.quotes.displayDiscountMinor()).toBe(500)
		expect(t.radio('rwd_coffee')).toBeChecked()
	})

	it('waits for a re-price on its way before placing', async () => {
		const t = await priced()
		t.pick('rwd_coffee')
		let done = false
		const waiting = t.quotes.settled().then(() => {
			done = true
		})
		await Promise.resolve()
		expect(done).toBe(false)
		await waiting
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: coffee })
	})

	it('stops a placement when the re-price on its way drops the pick', async () => {
		const t = await priced()
		t.pick('rwd_coffee')
		await expect(t.quotes.placement()).resolves.toEqual({
			ok: true,
			selection: coffee,
		})
		t.fetchQuote.mockResolvedValueOnce(
			quoteFor(null, { rewards: [testRewardQuote({ affordable: false })] }),
		)
		t.quotes.refresh()
		// Not placed at the full price without the guest noticing.
		await expect(t.quotes.placement()).resolves.toEqual({
			ok: false,
			message: labels.pickerFailed,
		})
		expect(t.notice).toHaveTextContent(labels.pickerRemoved)
		// The guest saw it: the next attempt goes without a reward.
		await expect(t.quotes.placement()).resolves.toEqual({
			ok: true,
			selection: null,
		})
	})

	it('places without a reward at once, even while a re-price hangs', async () => {
		const t = await priced()
		t.fetchQuote.mockImplementation(() => new Promise(() => {}))
		t.quotes.refresh()
		const waited = new Promise((resolve) => setTimeout(resolve, 50, 'waiting'))
		await expect(Promise.race([t.quotes.placement(), waited])).resolves.toEqual(
			{ ok: true, selection: null },
		)
	})

	it('stops waiting for a re-price the region does not answer', async () => {
		const t = await priced()
		vi.useFakeTimers()
		t.fetchQuote.mockImplementation(() => new Promise(() => {}))
		t.pick('rwd_coffee')
		let placed: unknown = null
		const placing = t.quotes.placement().then((result) => {
			placed = result
			return result
		})
		await vi.advanceTimersByTimeAsync(PLACEMENT_WAIT_MS - 1)
		expect(placed).toBeNull()
		await vi.advanceTimersByTimeAsync(1)
		// The pay button is free again long before the client gives up.
		await expect(placing).resolves.toEqual({
			ok: false,
			message: labels.pickerUnconfirmed,
		})
		expect(t.radio('rwd_coffee')).toBeChecked()
		// Going on without the reward needs no answer from the region.
		t.pick('')
		await expect(t.quotes.placement()).resolves.toEqual({
			ok: true,
			selection: null,
		})
	})

	it.each([
		['honors a 429 retry-after', 12, 12_000],
		['bounds a long 429 retry-after', 600, MAX_RETRY_AFTER_MS],
	])('%s', async (_label, retryAfterSeconds, waitMs) => {
		const t = await priced({ retryDelays: [1_000] })
		vi.useFakeTimers()
		t.fetchQuote.mockRejectedValueOnce(
			new LoyaltyClientError('rate_limited', 429, retryAfterSeconds),
		)
		t.pick('rwd_coffee')
		await vi.advanceTimersByTimeAsync(0)
		expect(t.fetchQuote).toHaveBeenCalledTimes(2)
		// Not at the fixed delay: the region asked for longer.
		await vi.advanceTimersByTimeAsync(waitMs - 1)
		expect(t.fetchQuote).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(t.fetchQuote).toHaveBeenCalledTimes(3)
	})

	it('keeps the fixed delay for a 429 without a retry-after', async () => {
		const t = await priced({ retryDelays: [1_000] })
		vi.useFakeTimers()
		t.fetchQuote.mockRejectedValueOnce(
			new LoyaltyClientError('rate_limited', 429),
		)
		t.pick('rwd_coffee')
		await vi.advanceTimersByTimeAsync(999)
		expect(t.fetchQuote).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(t.fetchQuote).toHaveBeenCalledTimes(3)
	})

	it('never quotes an order that stopped being priceable while the rewards loaded', async () => {
		const t = setup()
		t.loadRewards.mockImplementationOnce(() => {
			t.setKey(null)
			return Promise.resolve([testReward()])
		})
		t.quotes.sync()
		await t.quotes.settled()
		expect(t.fetchQuote).not.toHaveBeenCalled()
		expect(t.section).toHaveClass('hidden')
		// Once it can be priced again, it is.
		t.setKey('cart-2')
		t.quotes.sync()
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenCalledTimes(1)
	})

	it('prices the pick again when placing after the retries ran out', async () => {
		const t = await priced({ retryDelays: [0] })
		t.fetchQuote.mockRejectedValue(new LoyaltyClientError('network', 0))
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.quotes.placementPick()).toEqual({ ok: false })
		t.fetchQuote.mockImplementation((selection) =>
			Promise.resolve(quoteFor(selection)),
		)
		// Trying again means trying again: the region is asked once more.
		await expect(t.quotes.placement()).resolves.toEqual({
			ok: true,
			selection: coffee,
		})
	})

	it('stops for good once closed', async () => {
		const t = await priced()
		t.pick('rwd_coffee')
		await t.quotes.settled()
		t.quotes.close()
		expect(t.section).toHaveClass('hidden')
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: null })
		t.quotes.refresh()
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenCalledTimes(2)
	})

	it('waits for the bill to stop changing before pricing it again', async () => {
		vi.useFakeTimers()
		const t = setup({ debounceMs: 250 })
		t.quotes.sync()
		await vi.advanceTimersByTimeAsync(0)
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenCalledTimes(1)

		t.quotes.sync()
		await vi.advanceTimersByTimeAsync(300)
		expect(t.fetchQuote).toHaveBeenCalledTimes(1)

		t.setKey('cart-2')
		t.quotes.sync()
		await vi.advanceTimersByTimeAsync(200)
		t.setKey('cart-3')
		t.quotes.sync()
		await vi.advanceTimersByTimeAsync(200)
		expect(t.fetchQuote).toHaveBeenCalledTimes(1)
		// The bill on screen has not been priced yet.
		expect(t.quotes.freshQuote()).toBeNull()
		expect(t.quotes.lastQuote()).not.toBeNull()

		await vi.advanceTimersByTimeAsync(50)
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenCalledTimes(2)
		expect(t.quotes.freshQuote()).not.toBeNull()
	})

	it('drops an answer for a bill that changed while it was on its way', async () => {
		const t = setup()
		let answer!: (quote: LoyaltyCheckoutQuote) => void
		t.fetchQuote.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		t.quotes.sync()
		await vi.waitFor(() => expect(t.fetchQuote).toHaveBeenCalledTimes(1))
		t.setKey('cart-2')
		t.quotes.sync()
		await vi.waitFor(() => expect(t.fetchQuote).toHaveBeenCalledTimes(2))
		answer(
			quoteFor(null, { balance: { points: 1, reserved: 0, available: 1 } }),
		)
		await t.quotes.settled()
		expect(t.quotes.freshQuote()?.balance.available).toBe(150)
		expect(t.balance).toHaveTextContent('You have 150 points')
	})

	it('cancels a re-price a newer one replaced, and places without waiting on it', async () => {
		const t = await priced()
		let replaced: AbortSignal | undefined
		// Never answers, even once cancelled: a black-holed connection.
		t.fetchQuote.mockImplementationOnce((_selection, signal) => {
			replaced = signal
			return new Promise(() => {})
		})
		t.pick('rwd_coffee')
		await vi.waitFor(() => expect(t.fetchQuote).toHaveBeenCalledTimes(2))
		expect(replaced?.aborted).toBe(false)
		t.setKey('cart-2')
		t.quotes.sync()
		await vi.waitFor(() => expect(t.fetchQuote).toHaveBeenCalledTimes(3))
		expect(replaced?.aborted).toBe(true)
		await vi.waitFor(() =>
			expect(t.quotes.placementPick()).toEqual({ ok: true, selection: coffee }),
		)
		// Pay goes ahead on the fresh quote, not after PLACEMENT_WAIT_MS.
		const waited = new Promise((resolve) => setTimeout(resolve, 200, 'waiting'))
		await expect(Promise.race([t.quotes.placement(), waited])).resolves.toEqual(
			{ ok: true, selection: coffee },
		)
	})

	it('cancels the re-price on its way when closed', async () => {
		const t = await priced()
		let pending: AbortSignal | undefined
		t.fetchQuote.mockImplementationOnce((_selection, signal) => {
			pending = signal
			return new Promise(() => {})
		})
		t.quotes.refresh()
		await vi.waitFor(() => expect(t.fetchQuote).toHaveBeenCalledTimes(2))
		t.quotes.close()
		expect(pending?.aborted).toBe(true)
		const waited = new Promise((resolve) => setTimeout(resolve, 200, 'waiting'))
		await expect(
			Promise.race([t.quotes.settled().then(() => 'settled'), waited]),
		).resolves.toBe('settled')
	})

	it('removes a pick the region no longer honors, and says so', async () => {
		const t = await priced()
		t.fetchQuote.mockResolvedValueOnce(
			quoteFor(null, { rewards: [testRewardQuote({ affordable: false })] }),
		)
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.notice).toHaveTextContent(labels.pickerRemoved)
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: null })
		expect(t.radio('rwd_coffee')).toBeDisabled()
		expect(t.radio('')).toBeChecked()
	})

	it('turns rewards off for this page when the region refuses them', async () => {
		const t = await priced()
		t.fetchQuote.mockRejectedValueOnce(
			new LoyaltyClientError('redemption_disabled', 403),
		)
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.section).toHaveClass('hidden')
		expect(t.notice).toHaveTextContent(labels.pickerRemoved)
		expect(t.quotes.freshQuote()).toBeNull()
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: null })
		t.setKey('cart-2')
		t.quotes.sync()
		t.quotes.refresh()
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenCalledTimes(2)
	})

	it('stops quoting a tab or cart the region refused', async () => {
		const t = await priced({ retryDelays: [0, 0, 0] })
		t.fetchQuote.mockRejectedValueOnce(
			new LoyaltyClientError('order_refused', 404),
		)
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.section).toHaveClass('hidden')
		// Not retried: a closed tab will not price on the next try.
		expect(t.fetchQuote).toHaveBeenCalledTimes(2)
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: null })
	})

	it('keeps the pick and retries while ordering is down for now', async () => {
		const t = await priced({ retryDelays: [0, 0, 0] })
		t.fetchQuote.mockRejectedValueOnce(
			new LoyaltyClientError('order_unavailable', 503),
		)
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.section).not.toHaveClass('hidden')
		expect(t.fetchQuote).toHaveBeenCalledTimes(3)
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: coffee })
	})

	it('keeps the pick and retries when the region cannot be reached', async () => {
		const t = await priced({ retryDelays: [0, 0, 0] })
		t.fetchQuote.mockRejectedValueOnce(new LoyaltyClientError('network', 0))
		t.pick('rwd_coffee')
		await t.quotes.settled()
		// A blip hides nothing and drops nothing: the retry prices the pick.
		expect(t.section).not.toHaveClass('hidden')
		expect(t.fetchQuote).toHaveBeenCalledTimes(3)
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: coffee })
		expect(t.radio('rwd_coffee')).toBeChecked()
		expect(t.notice).toHaveTextContent(
			'Reward applied: $5.00 off. New total: $16.65',
		)
	})

	it('keeps the last totals when the region stays unreachable', async () => {
		const t = await priced({ retryDelays: [0] })
		t.fetchQuote.mockRejectedValue(new LoyaltyClientError('network', 0))
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenCalledTimes(3)
		expect(t.section).not.toHaveClass('hidden')
		expect(t.notice).toHaveTextContent(labels.errorUnavailable)
		// The pick was never priced: nothing goes out for it.
		expect(t.quotes.placementPick()).toEqual({ ok: false })
		// The next change to the bill tries again.
		t.fetchQuote.mockImplementation((selection) =>
			Promise.resolve(quoteFor(selection)),
		)
		t.setKey('cart-2')
		t.quotes.sync()
		await t.quotes.settled()
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: coffee })
	})

	it('announces the saving and the new total once, when the reward lands', async () => {
		const t = await priced()
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.notice).toHaveTextContent(
			'Reward applied: $5.00 off. New total: $16.65',
		)
		// A re-price of the same pick does not announce again.
		t.notice.textContent = ''
		t.quotes.refresh()
		await t.quotes.settled()
		expect(t.notice).toHaveTextContent('')
	})

	it('announces the total the page shows, not only the quoted one', async () => {
		// A tab payment swaps the quoted tip for the one chosen now.
		const t = await priced({
			shownTotalMinor: (totals) => totals.totalMinor - totals.tipMinor + 300,
		})
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.notice).toHaveTextContent(
			'Reward applied: $5.00 off. New total: $19.65',
		)
	})

	it('stays hidden when the program has nothing to spend', async () => {
		const t = setup()
		t.loadRewards.mockResolvedValueOnce(null)
		t.quotes.sync()
		await t.quotes.settled()
		expect(t.fetchQuote).not.toHaveBeenCalled()
		expect(t.section).toHaveClass('hidden')
		t.setKey('cart-2')
		t.quotes.sync()
		await t.quotes.settled()
		expect(t.loadRewards).toHaveBeenCalledTimes(1)
	})

	it('hides the picker while the bill cannot be priced', async () => {
		const t = await priced()
		t.setKey(null)
		t.quotes.sync()
		await t.quotes.settled()
		expect(t.section).toHaveClass('hidden')
		expect(t.quotes.freshQuote()).toBeNull()
		expect(t.fetchQuote).toHaveBeenCalledTimes(1)
	})

	it('says when another member collects the tab', async () => {
		const t = setup()
		t.fetchQuote.mockRejectedValueOnce(
			new LoyaltyClientError('already_claimed', 409),
		)
		t.quotes.sync()
		await t.quotes.settled()
		expect(t.section).toHaveClass('hidden')
		expect(t.notice).toHaveTextContent(labels.pickerTabClaimed)
	})

	it('forgets the pick when the guest signs out', async () => {
		let signedIn = true
		const t = await priced({ signedIn: () => signedIn })
		t.pick('rwd_coffee')
		await t.quotes.settled()
		signedIn = false
		t.quotes.sync()
		expect(t.section).toHaveClass('hidden')
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: null })
		expect(t.quotes.freshQuote()).toBeNull()
	})

	it('re-prices an unchanged bill on request', async () => {
		const t = await priced()
		t.quotes.refresh()
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenCalledTimes(2)
	})

	it('knows when a pick leaves nothing to pay', async () => {
		const covering = (selection: LoyaltyOrderReward | null) =>
			Promise.resolve(
				selection
					? testQuote({
							selectedRewardId: selection.rewardId,
							totals: {
								subtotalMinor: 500,
								discountMinor: 500,
								taxMinor: 0,
								taxInclusive: false,
								tipMinor: 75,
								deliveryFeeMinor: 0,
								totalMinor: 75,
							},
						})
					: testQuote(),
			)
		const order = await priced({ fetchQuote: covering })
		order.pick('rwd_coffee')
		await order.quotes.settled()
		// An order's tip is paid with it, so 75 is still owed.
		expect(order.quotes.coversTotal()).toBe(false)

		const tab = await priced({
			fetchQuote: covering,
			payableMinor: (totals) => totals.totalMinor - totals.tipMinor,
		})
		tab.pick('rwd_coffee')
		await tab.quotes.settled()
		expect(tab.quotes.coversTotal()).toBe(true)
	})
})

describe('refused placements', () => {
	it('re-prices and explains a pick that covers the whole bill', async () => {
		const t = await priced()
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.quotes.refused('reward_covers_total', true)).toBe(
			labels.pickerCoversOrder,
		)
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenCalledTimes(3)
		expect(t.fetchQuote).toHaveBeenLastCalledWith(
			coffee,
			expect.any(AbortSignal),
		)
	})

	it('drops a refused pick so the guest picks again on fresh totals', async () => {
		const t = await priced()
		t.pick('rwd_coffee')
		await t.quotes.settled()
		expect(t.quotes.refused('cart_changed', true)).toBe(labels.pickerFailed)
		expect(t.quotes.placementPick()).toEqual({ ok: true, selection: null })
		await t.quotes.settled()
		expect(t.fetchQuote).toHaveBeenLastCalledWith(null, expect.any(AbortSignal))
		expect(t.radio('')).toBeChecked()
	})

	it('closes rewards for refusals that will not change', async () => {
		const inactive = await priced()
		expect(inactive.quotes.refused('member_inactive', true)).toBe(
			labels.errorMemberInactive,
		)
		expect(inactive.section).toHaveClass('hidden')

		const paused = await priced()
		expect(paused.quotes.refused('redemption_disabled', true)).toBe(
			labels.redemptionPaused,
		)

		const claimed = await priced()
		expect(claimed.quotes.refused('already_claimed', true)).toBe(
			labels.pickerTabClaimed,
		)
		expect(claimed.section).toHaveClass('hidden')
	})

	it('leaves other refusals to the page', async () => {
		const t = await priced()
		expect(t.quotes.refused('ordering_closed', true)).toBeNull()
		// A guest token refused on an order without a pick is not about rewards.
		expect(t.quotes.refused('unauthorized', false)).toBeNull()
		expect(t.quotes.refused('unauthorized', true)).toBe(labels.pickerFailed)
	})
})

describe('spendableRewards', () => {
	it('lists rewards only while members can spend them', async () => {
		const client = (program: ReturnType<typeof testProgram> | null) => ({
			program: () => Promise.resolve(program),
		})
		expect(await spendableRewards(client(testProgram()))).toHaveLength(2)
		expect(
			await spendableRewards(client(testProgram({ redemptionEnabled: false }))),
		).toBeNull()
		expect(
			await spendableRewards(client(testProgram({ status: 'paused' }))),
		).toBeNull()
		expect(await spendableRewards(client(null))).toBeNull()
	})
})
