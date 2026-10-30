import {
	type QrPublicTab,
	type QrTabPayRequest,
} from '@repo/common/qr-ordering'
import { getAccessToken } from '~/lib/client-auth'
import { type LoyaltyLabels } from '~/lib/loyalty/labels'
import { readLoyaltyLabels } from '~/lib/loyalty/read-labels'
import {
	createRewardQuotes,
	spendableRewards,
	type RewardQuotes,
} from '~/lib/loyalty/reward-quotes'
import { createLoyaltyClient, type LoyaltyClient } from '~/lib/loyalty-client'

/**
 * The reward picker on the tab payment sheet. The menu page imports this
 * module only when a signed-in guest opens the sheet, so the loyalty code
 * stays out of the menu bundle. The region prices every reward on the tab's
 * rounds and checks the pick again when the payment starts. The tip is a
 * share of the subtotal before any reward, so changing it never re-prices.
 */

export type TabRewardsDeps = {
	/** The picker block; hidden whenever rewards cannot be used. */
	section: HTMLElement
	/** Holds the radios. */
	options: HTMLElement
	balance?: HTMLElement | null
	/** A status line for automatic changes, such as a dropped pick. */
	notice?: HTMLElement | null
	locale: string
	/** Formats minor units in the tab's currency. */
	formatMoney: (minor: number) => string
	tipPercent: () => number
	/** The tip chosen now, in minor units, as the pay button adds it. */
	tipMinor: () => number
	/** The quote or the pick changed: repaint the pay button. */
	onChange: () => void
	labels?: LoyaltyLabels
	client?: Pick<LoyaltyClient, 'program' | 'tabQuote'>
	signedIn?: () => boolean
	debounceMs?: number
}

export type TabRewardPick =
	| { ok: true; loyalty: QrTabPayRequest['loyalty'] | null }
	| { ok: false; message: string }

/** A tab quote's line id is `<round id>:<position in the round>`. */
export function tabLineName(tab: QrPublicTab, lineId: string): string | null {
	const split = lineId.lastIndexOf(':')
	const position = lineId.slice(split + 1)
	if (split <= 0 || !/^\d+$/.test(position)) return null
	const round = tab.rounds.find((entry) => entry.id === lineId.slice(0, split))
	return round?.lines[Number(position)]?.itemName ?? null
}

export function mountTabRewards(deps: TabRewardsDeps) {
	const labels = deps.labels ?? readLoyaltyLabels()
	const client = deps.client ?? createLoyaltyClient()
	const signedIn = deps.signedIn ?? (() => Boolean(getAccessToken()))
	let options = deps.options
	let tab: QrPublicTab | null = null
	let tabToken: string | null = null
	let quotes: RewardQuotes | null = null

	function start(): RewardQuotes {
		return createRewardQuotes({
			section: deps.section,
			options,
			balance: deps.balance,
			notice: deps.notice,
			labels,
			locale: deps.locale,
			formatMoney: deps.formatMoney,
			lineName: (lineId) => (tab ? tabLineName(tab, lineId) : null),
			signedIn,
			loadRewards: () => spendableRewards(client),
			pricingKey: () =>
				tab && tabToken
					? JSON.stringify([
							tab.id,
							tab.totals,
							tab.rounds.map((round) => round.lines),
						])
					: null,
			fetchQuote: (selection, signal) =>
				client.tabQuote({
					tabToken: tabToken ?? '',
					tipPercent: deps.tipPercent(),
					selection,
					signal,
				}),
			onChange: deps.onChange,
			coversTotalMessage: labels.pickerCoversTotal,
			// A tip alone is never paid online.
			payableMinor: (totals) => totals.totalMinor - totals.tipMinor,
			// The tip never re-prices, so the quoted one may be out of date.
			shownTotalMinor: (totals) =>
				totals.totalMinor - totals.tipMinor + deps.tipMinor(),
			debounceMs: deps.debounceMs,
			name: 'tab-reward',
		})
	}

	return {
		/** The sheet opened for this tab: price it now (the balance may have moved). */
		open(next: QrPublicTab, nextToken: string) {
			if (quotes && tab?.id !== next.id) {
				// A new tab starts over: what the last one refused (another
				// member's claim) does not carry over. A fresh container drops
				// the old picker's listener.
				quotes.close()
				const fresh = options.cloneNode(false) as HTMLElement
				options.replaceWith(fresh)
				options = fresh
				if (deps.notice) deps.notice.textContent = ''
				quotes = null
			}
			tab = next
			tabToken = nextToken
			quotes ??= start()
			quotes.refresh()
			// A pick priced on the tab as it was shows no amount until re-priced.
			deps.onChange()
		},

		/**
		 * What the guest pays, tip included: the tab's own total without a
		 * pick, the region's total with one, and null while a pick is priced.
		 */
		amountMinor(totalMinor: number, tipMinor: number): number | null {
			if (!quotes) return totalMinor + tipMinor
			const pick = quotes.placementPick()
			if (!pick.ok) return null
			const fresh = quotes.freshQuote()
			if (!pick.selection || !fresh) return totalMinor + tipMinor
			return fresh.totals.totalMinor - fresh.totals.tipMinor + tipMinor
		},

		/**
		 * What to send or why to stop. Waits a few seconds at most for a
		 * pick's re-price, so a region that is down never holds the sheet.
		 */
		async placement(): Promise<TabRewardPick> {
			if (!quotes) return { ok: true, loyalty: null }
			const pick = await quotes.placement()
			if (!pick.ok) return pick
			if (quotes.coversTotal()) {
				return { ok: false, message: labels.pickerCoversTotal }
			}
			return { ok: true, loyalty: pick.selection }
		},

		/** A refused payment: the message when it was about the reward, else null. */
		refused(code: string, sentPick: boolean): string | null {
			return quotes?.refused(code, sentPick) ?? null
		},
	}
}
