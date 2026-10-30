import {
	type LoyaltyCheckoutQuote,
	type LoyaltyOrderReward,
	type LoyaltyPublicReward,
} from '@repo/loyalty'
import { formatPoints } from '~/lib/loyalty/format'
import { type LoyaltyLabels } from '~/lib/loyalty/labels'
import { honoredSelection, initRewardPicker } from '~/lib/loyalty/reward-picker'
import { type LoyaltyClient, LoyaltyClientError } from '~/lib/loyalty-client'
import { fillTemplate } from '~/lib/ordering/money'

/**
 * Keeps a reward picker in step with the bill it applies to (a checkout cart
 * or an open table tab). Every change to what the bill covers re-prices it at
 * the region; the page shows the region's totals and sends only a pick the
 * freshest quote honors. Quotes are reads: nothing is held until the order
 * or payment is placed, and the region re-checks the pick then.
 */

export type RewardQuoteTotals = LoyaltyCheckoutQuote['totals']

export type RewardQuoteDeps = {
	/** The picker section; hidden whenever rewards cannot be used. */
	section: HTMLElement
	/** Holds the radios. */
	options: HTMLElement
	/** "You have 150 points". */
	balance?: HTMLElement | null
	/**
	 * A status line (`role="status"`) for automatic changes, such as a
	 * dropped pick. Only its text changes, so it stays in the accessibility
	 * tree and the change is announced.
	 */
	notice?: HTMLElement | null
	labels: LoyaltyLabels
	locale: string
	/** Formats minor units in the bill's currency. */
	formatMoney: (minor: number) => string
	/** The bill's name for a quote line id, to say where a reward lands. */
	lineName?: (lineId: string) => string | null
	/** Rewards are for signed-in members only; nothing is sent otherwise. */
	signedIn: () => boolean
	/** The program's rewards (names and terms), or null when none can be spent. */
	loadRewards: () => Promise<LoyaltyPublicReward[] | null>
	/** What the quote prices, as a stable string; null while it cannot be priced. */
	pricingKey: () => string | null
	/** `signal` aborts once a newer re-price replaced this one. */
	fetchQuote: (
		selection: LoyaltyOrderReward | null,
		signal: AbortSignal,
	) => Promise<LoyaltyCheckoutQuote>
	/** The quote or the pick changed; re-render the totals. */
	onChange: () => void
	/** Message for a pick that leaves nothing to pay online. */
	coversTotalMessage: string
	/**
	 * What the guest would still pay with the pick. Defaults to the total; a
	 * tab payment leaves the tip out, because a tip alone is not paid online.
	 */
	payableMinor?: (totals: RewardQuoteTotals) => number
	/**
	 * The total the page shows with the pick, read out when a reward lands.
	 * Defaults to the region's total.
	 */
	shownTotalMinor?: (totals: RewardQuoteTotals) => number
	debounceMs?: number
	/** Waits between retries after a transient failure; the count caps them. */
	retryDelays?: number[]
	/** How long placing waits for a pick's re-price before giving up. */
	placementWaitMs?: number
	name?: string
}

/**
 * Long enough for a slow connection to answer one quote; the client's own
 * timeout and retries can take more than a minute while the region is down.
 */
export const PLACEMENT_WAIT_MS = 8_000

/** The longest a quote waits on a 429's `retryAfterSeconds` before trying. */
export const MAX_RETRY_AFTER_MS = 30_000

export type PlacementPick =
	{ ok: true; selection: LoyaltyOrderReward | null } | { ok: false }

export type PlacementResult =
	| { ok: true; selection: LoyaltyOrderReward | null }
	| { ok: false; message: string }

export type RewardQuotes = {
	/** Re-prices when what the bill covers changed; cheap on every render. */
	sync(): void
	/** Re-prices now, even for the same bill (for example a fresh balance). */
	refresh(): void
	/** Resolves once no re-price is pending. */
	settled(): Promise<void>
	/** The region's totals for the bill and pick on screen now, or null. */
	freshQuote(): LoyaltyCheckoutQuote | null
	/** The last quote, even when the bill has changed since. */
	lastQuote(): LoyaltyCheckoutQuote | null
	/**
	 * The saving to show while a re-price is on its way: what the last quote
	 * priced for the reward picked now.
	 */
	displayDiscountMinor(): number
	/** The picked reward's name, for the summary line. */
	rewardName(): string | null
	/**
	 * What to send with the order or payment. `ok: false` means the guest
	 * picked a reward that no fresh quote confirms; do not place yet.
	 */
	placementPick(): PlacementPick
	/**
	 * What to send, once a pick is confirmed. Without a pick it answers at
	 * once. With one it waits a few seconds at most for the re-price on its
	 * way (and starts one when earlier retries ran out). A pick that re-price
	 * dropped, or one no fresh quote confirms in time, is `ok: false` with
	 * the message to show: the guest decides again instead of paying the
	 * full price without noticing or waiting on a region that is down.
	 */
	placement(): Promise<PlacementResult>
	/** Stops for good: no more quotes, no pick, the picker hidden. */
	close(): void
	/** True when the honored pick leaves nothing to pay. */
	coversTotal(): boolean
	/**
	 * A placement or payment the region refused. For a loyalty refusal it
	 * re-prices and returns the message to show; null for any other code.
	 */
	refused(code: string, sentPick: boolean): string | null
}

/** Quote failures that will not change while this page is open. */
const PERMANENT_CODES = new Set<string>([
	'signed_out',
	'organization_mismatch',
	'organization_not_found',
	'loyalty_unavailable',
	'loyalty_disabled',
	'redemption_disabled',
	'program_not_found',
	'program_inactive',
	'member_not_found',
	'member_inactive',
	'currency_mismatch',
	'order_refused',
])

/** Refusals after which the pick can be made again on a fresh quote. */
const RETRY_CODES = new Set<string>([
	'reward_not_found',
	'reward_unavailable',
	'reward_not_applicable',
	'zero_value',
	'insufficient_points',
	'stacking_not_allowed',
	'one_reward_per_order',
	'cart_changed',
	'stale_version',
	'unauthorized',
])

/** Refusals that close rewards for the rest of this page view. */
const CLOSED_CODES = new Set<string>([
	'loyalty_unavailable',
	'loyalty_disabled',
	'redemption_disabled',
	'program_not_found',
	'program_inactive',
	'member_not_found',
	'member_inactive',
	'currency_mismatch',
])

/** The program's rewards while members can spend them, else null. */
export async function spendableRewards(
	client: Pick<LoyaltyClient, 'program'>,
): Promise<LoyaltyPublicReward[] | null> {
	const program = await client.program()
	return program?.status === 'active' && program.redemptionEnabled
		? program.rewards
		: null
}

export function createRewardQuotes(deps: RewardQuoteDeps): RewardQuotes {
	const { labels, locale, section } = deps
	const debounceMs = deps.debounceMs ?? 250
	const retryDelays = deps.retryDelays ?? [1_000, 3_000, 5_000]
	const placementWaitMs = deps.placementWaitMs ?? PLACEMENT_WAIT_MS
	let retries = 0
	const payable = deps.payableMinor ?? ((totals) => totals.totalMinor)
	const shownTotal = deps.shownTotalMinor ?? ((totals) => totals.totalMinor)
	let rewards: LoyaltyPublicReward[] | null = null
	let off = false
	let quote: LoyaltyCheckoutQuote | null = null
	let quotedKey: string | null = null
	let quotedPickId: string | null = null
	let selection: LoyaltyOrderReward | null = null
	let requestedKey: string | null | undefined
	let seq = 0
	let timer: ReturnType<typeof setTimeout> | null = null
	// Only the newest request counts as pending: one a newer request replaced
	// is cancelled, and its answer would be dropped anyway, so a hung one
	// cannot hold up placing.
	let inFlightId: number | null = null
	let inFlight: AbortController | null = null
	let waiters: Array<() => void> = []

	const picker = initRewardPicker(deps.options, {
		labels,
		locale,
		formatMoney: deps.formatMoney,
		name: deps.name,
		lineName: deps.lineName,
		onSelect(next) {
			selection = next
			clearNotice()
			deps.onChange()
			schedule(0)
		},
	})

	const busy = () => timer !== null || inFlightId === seq

	function cancelInFlight() {
		inFlight?.abort()
		inFlight = null
	}

	function release() {
		if (busy()) return
		const list = waiters
		waiters = []
		for (const resolve of list) resolve()
	}

	function notify(message: string) {
		if (deps.notice) deps.notice.textContent = message
	}

	function clearNotice() {
		if (deps.notice) deps.notice.textContent = ''
	}

	function setVisible(visible: boolean) {
		section.classList.toggle('hidden', !visible)
	}

	function disable(message: string | null) {
		off = true
		seq += 1
		cancelInFlight()
		if (timer) clearTimeout(timer)
		timer = null
		quote = null
		quotedKey = null
		selection = null
		setVisible(false)
		section.removeAttribute('aria-busy')
		if (message) notify(message)
		deps.onChange()
		release()
	}

	function schedule(delay: number) {
		if (off) return
		requestedKey = deps.pricingKey()
		// A newer request owns the state; answers to older ones are dropped.
		seq += 1
		const id = seq
		cancelInFlight()
		if (timer) clearTimeout(timer)
		section.setAttribute('aria-busy', 'true')
		timer = setTimeout(() => {
			timer = null
			void run(id)
		}, delay)
	}

	function apply(next: LoyaltyCheckoutQuote, key: string) {
		const pick = selection
		const honored = honoredSelection(next, pick)
		const announcedPickId = quotedPickId
		quote = next
		quotedKey = key
		quotedPickId = next.selectedRewardId
		retries = 0
		if (pick && !honored) {
			selection = null
			notify(labels.pickerRemoved)
		} else {
			selection = honored
			if (
				honored &&
				honored.rewardId !== announcedPickId &&
				next.totals.discountMinor > 0
			) {
				// The saving changed the total: the status line announces both once.
				notify(
					fillTemplate(labels.pickerApplied, {
						amount: deps.formatMoney(next.totals.discountMinor),
						total: deps.formatMoney(shownTotal(next.totals)),
					}),
				)
			}
		}
		const byId = new Set((rewards ?? []).map((reward) => reward.id))
		const listed = next.rewards.some((row) => byId.has(row.rewardId))
		if (deps.balance) {
			deps.balance.textContent = fillTemplate(labels.pickerBalance, {
				amount: formatPoints(
					next.balance.available,
					next.unitLabel,
					labels,
					locale,
				),
			})
		}
		picker.render(next, rewards ?? [], selection)
		setVisible(listed)
	}

	async function run(id: number) {
		if (off || id !== seq) return
		const key = deps.pricingKey()
		requestedKey = key
		if (key === null) {
			// Not priceable yet (no delivery address, no pickup time): keep the
			// pick for when it is, but show nothing the guest could act on.
			quote = null
			quotedKey = null
			setVisible(false)
			section.removeAttribute('aria-busy')
			deps.onChange()
			release()
			return
		}
		inFlightId = id
		const controller = new AbortController()
		inFlight = controller
		try {
			if (!rewards) {
				const list = await deps.loadRewards()
				if (id !== seq || off) return
				if (!list || list.length === 0) {
					disable(null)
					return
				}
				rewards = list
			}
			// The bill may have changed (or stopped being priceable) while the
			// rewards loaded: price what is on screen now, never a stale order.
			if (deps.pricingKey() !== key) {
				schedule(0)
				return
			}
			const next = await deps.fetchQuote(selection, controller.signal)
			if (id !== seq || off) return
			apply(next, key)
			// Totals priced with a pick that was just dropped: price them again.
			if (!selection && next.selectedRewardId) schedule(0)
			deps.onChange()
		} catch (error) {
			if (id !== seq || off) return
			const code = error instanceof LoyaltyClientError ? error.code : null
			const hadPick = selection !== null
			if (code === 'already_claimed') {
				// Another member collects this tab: say so instead of hiding.
				disable(labels.pickerTabClaimed)
				return
			}
			if (code && PERMANENT_CODES.has(code)) {
				disable(hadPick ? labels.pickerRemoved : null)
				return
			}
			// Unreachable or unpriceable for now: keep the pick and the last
			// totals on screen and try again in a moment; a change to the bill
			// retries too. Only the freshest quote can send a pick, so nothing
			// stale goes out while the region is unreachable.
			retries += 1
			if (quote || hadPick) notify(labels.pickerRetrying)
			if (retries <= retryDelays.length) {
				// A busy region says when to come back: honor it, up to a bound.
				const waitMs =
					error instanceof LoyaltyClientError &&
					error.status === 429 &&
					error.retryAfterSeconds !== null
						? Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
						: 0
				schedule(Math.max(retryDelays[retries - 1]!, waitMs))
				return
			}
			retries = 0
			if (quote || hadPick) notify(labels.errorUnavailable)
			deps.onChange()
		} finally {
			if (inFlight === controller) inFlight = null
			if (inFlightId === id) inFlightId = null
			if (id === seq) section.removeAttribute('aria-busy')
			release()
		}
	}

	function freshQuote(): LoyaltyCheckoutQuote | null {
		if (!quote || off) return null
		if (quotedKey !== deps.pricingKey()) return null
		if (quotedPickId !== (selection?.rewardId ?? null)) return null
		return quote
	}

	function settled(): Promise<void> {
		if (!busy()) return Promise.resolve()
		return new Promise((resolve) => {
			waiters.push(resolve)
		})
	}

	/** Like `settled`, but stops waiting after `ms`. */
	function settledWithin(ms: number): Promise<void> {
		if (!busy()) return Promise.resolve()
		return new Promise((resolve) => {
			const timeout = setTimeout(resolve, ms)
			waiters.push(() => {
				clearTimeout(timeout)
				resolve()
			})
		})
	}

	function placementPick(): PlacementPick {
		if (!selection) return { ok: true, selection: null }
		const honored = honoredSelection(freshQuote(), selection)
		return honored ? { ok: true, selection: honored } : { ok: false }
	}

	/** Signed out since the page loaded: forget everything. */
	function signedOut(): boolean {
		if (deps.signedIn()) return false
		if (quote || selection) disable(null)
		return true
	}

	return {
		sync() {
			if (off || signedOut()) return
			const key = deps.pricingKey()
			if (key === requestedKey) return
			schedule(requestedKey === undefined ? 0 : debounceMs)
		},

		refresh() {
			if (off || signedOut()) return
			schedule(0)
		},

		settled,

		freshQuote,

		lastQuote: () => (off ? null : quote),

		displayDiscountMinor() {
			const pickId = selection?.rewardId
			if (!quote || off || !pickId) return 0
			if (quote.selectedRewardId === pickId) return quote.totals.discountMinor
			// Just picked: what the last quote priced the reward at.
			const row = quote.rewards.find((entry) => entry.rewardId === pickId)
			return row?.applicable && row.affordable ? row.discountMinor : 0
		},

		rewardName() {
			const pickId = selection?.rewardId
			if (!pickId || off) return null
			return rewards?.find((reward) => reward.id === pickId)?.name ?? null
		},

		placementPick,

		async placement() {
			// Nothing a re-price says can add a pick, so nothing to wait for.
			if (!selection) return { ok: true, selection: null }
			if (!busy() && !placementPick().ok) schedule(0)
			await settledWithin(placementWaitMs)
			const pick = placementPick()
			if (pick.ok && pick.selection) return pick
			return {
				ok: false,
				message: selection ? labels.pickerUnconfirmed : labels.pickerFailed,
			}
		},

		close() {
			if (!off) disable(null)
		},

		coversTotal() {
			const fresh = freshQuote()
			return Boolean(
				fresh &&
				selection &&
				fresh.selectedRewardId === selection.rewardId &&
				payable(fresh.totals) <= 0,
			)
		},

		refused(code, sentPick) {
			if (code === 'reward_covers_total') {
				schedule(0)
				return deps.coversTotalMessage
			}
			if (code === 'already_claimed') {
				disable(null)
				return labels.pickerTabClaimed
			}
			if (CLOSED_CODES.has(code)) {
				disable(null)
				return code === 'member_inactive'
					? labels.errorMemberInactive
					: labels.redemptionPaused
			}
			if (!RETRY_CODES.has(code)) return null
			if (code === 'unauthorized' && !sentPick) return null
			// The guest picks again on fresh totals rather than inherit a
			// discount the region just refused.
			selection = null
			deps.onChange()
			schedule(0)
			return labels.pickerFailed
		},
	}
}
