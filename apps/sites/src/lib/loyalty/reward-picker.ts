import {
	type LoyaltyCheckoutQuote,
	type LoyaltyOrderReward,
	type LoyaltyPublicReward,
	type LoyaltyRewardQuote,
} from '@repo/loyalty'
import {
	describeReward,
	formatList,
	formatPoints,
	isolateName,
} from '~/lib/loyalty/format'
import { type LoyaltyLabels } from '~/lib/loyalty/labels'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

/**
 * The reward picker shared by checkout and the tab payment sheet: "No
 * reward" plus one radio per reward the region priced on the current bill.
 * The quote is the only source of what applies, what it costs and what it
 * saves; the browser never prices a reward itself. Text goes through
 * `textContent` only.
 */

export type RewardPickerDeps = {
	labels: LoyaltyLabels
	locale: string
	/** Formats minor units in the quote's currency. */
	formatMoney: (minor: number) => string
	/** Radio group name; one picker per page keeps it unique. */
	name?: string
	/** The bill's name for a quote line id; null when it has none. */
	lineName?: (lineId: string) => string | null
	/** The guest picked a reward (or null for "No reward"). */
	onSelect: (selection: LoyaltyOrderReward | null) => void
}

export type RewardPicker = {
	/** Rebuilds from a fresh quote, keeping the pick the quote still honors. */
	render(
		quote: LoyaltyCheckoutQuote,
		rewards: LoyaltyPublicReward[],
		selection: LoyaltyOrderReward | null,
	): void
}

export function initRewardPicker(
	container: HTMLElement,
	deps: RewardPickerDeps,
): RewardPicker {
	const name = deps.name ?? 'loyalty-reward'
	const { labels, locale } = deps
	let lastQuote: LoyaltyCheckoutQuote | null = null
	let reasonSeq = 0

	container.setAttribute('role', 'radiogroup')
	container.addEventListener('change', (event) => {
		const input = event.target
		if (!(input instanceof HTMLInputElement)) return
		if (input.name !== name || !input.checked || !lastQuote) return
		deps.onSelect(input.value ? selectionFor(lastQuote, input.value) : null)
	})

	/** The bill lines a reward takes money off; empty when one has no name. */
	function landedOn(row: LoyaltyRewardQuote): string[] {
		if (!deps.lineName) return []
		const names: string[] = []
		for (const line of row.lines) {
			if (line.discountMinor <= 0 && line.rewardUnits <= 0) continue
			const lineName = deps.lineName(line.lineId)
			// A partial list would misstate where the reward lands.
			if (!lineName) return []
			if (!names.includes(lineName)) names.push(lineName)
		}
		return names
	}

	function noneOption(selected: boolean): HTMLElement {
		const label = el('label', 'choice-card')
		const input = el('input')
		input.type = 'radio'
		input.name = name
		input.value = ''
		input.checked = selected
		label.append(
			input,
			el(
				'span',
				'min-w-0 flex-1 text-sm font-semibold text-foreground',
				labels.pickerNoReward,
			),
		)
		return label
	}

	function rewardOption(
		quote: LoyaltyCheckoutQuote,
		row: LoyaltyRewardQuote,
		reward: LoyaltyPublicReward,
		selection: LoyaltyOrderReward | null,
	): HTMLElement {
		const usable = row.applicable && row.affordable
		const label = el('label', 'choice-card')
		const input = el('input')
		input.type = 'radio'
		input.name = name
		input.value = row.rewardId
		input.disabled = !usable
		input.checked = usable && selection?.rewardId === row.rewardId
		const body = el('span', 'min-w-0 flex-1')
		const title = el('span', 'block text-sm font-semibold text-foreground')
		title.append(el('bdi', undefined, reward.name))
		body.append(title)
		const description = describeReward(reward, labels, locale)
		const detail = [description.value, description.scope, description.cap]
			.filter(Boolean)
			.join(' · ')
		body.append(el('span', 'block text-xs text-muted-foreground', detail))
		if (usable && row.discountMinor > 0) {
			body.append(
				el(
					'span',
					'mt-0.5 block text-xs font-medium text-foreground',
					fillTemplate(labels.pickerSave, {
						amount: deps.formatMoney(row.discountMinor),
					}),
				),
			)
		}
		// A whole-order reward lands on every line; its scope already says so.
		const landed = usable && reward.kind !== 'order' ? landedOn(row) : []
		if (landed.length > 0) {
			const usedOn = el(
				'span',
				'block text-xs text-muted-foreground',
				fillTemplate(labels.pickerUsedOn, {
					items: formatList(landed.map(isolateName), locale),
				}),
			)
			usedOn.dataset.rewardLines = ''
			body.append(usedOn)
		}
		const points = formatPoints(row.pointsCost, quote.unitLabel, labels, locale)
		body.append(
			el('span', 'block text-xs tabular-nums text-muted-foreground', points),
		)
		if (
			usable &&
			selection?.rewardId === row.rewardId &&
			quote.selectedRewardId === row.rewardId
		) {
			const after = el(
				'span',
				'block text-xs tabular-nums text-muted-foreground',
				fillTemplate(labels.pickerLeftAfter, {
					amount: formatPoints(
						quote.availableAfter,
						quote.unitLabel,
						labels,
						locale,
					),
				}),
			)
			after.dataset.rewardAfter = ''
			body.append(after)
		}
		label.append(input, body)
		if (usable) {
			label.dataset.rewardId = row.rewardId
			return label
		}
		const reason = row.affordable
			? labels.pickerNotApplicable
			: fillTemplate(labels.rewardNeedMore, {
					amount: formatPoints(
						Math.max(1, row.pointsCost - quote.balance.available),
						quote.unitLabel,
						labels,
						locale,
					),
				})
		// The card of a disabled radio is faded; the reason stays outside it at
		// full contrast and is read out with the radio.
		const note = el('p', 'px-1 text-xs text-muted-foreground', reason)
		note.id = `${name}-unavailable-${++reasonSeq}`
		note.dataset.rewardUnavailable = ''
		input.setAttribute('aria-describedby', note.id)
		const option = el('div', 'flex flex-col gap-1')
		option.dataset.rewardId = row.rewardId
		option.append(label, note)
		return option
	}

	return {
		render(quote, rewards, selection) {
			lastQuote = quote
			// The radios are rebuilt: keep keyboard focus on the same choice
			// (or on "No reward" when that choice went away).
			const active = document.activeElement
			const refocus =
				active instanceof HTMLInputElement && container.contains(active)
					? active.value
					: null
			const byId = new Map(rewards.map((reward) => [reward.id, reward]))
			const options: HTMLElement[] = [noneOption(selection === null)]
			for (const row of quote.rewards) {
				const reward = byId.get(row.rewardId)
				if (reward) options.push(rewardOption(quote, row, reward, selection))
			}
			container.replaceChildren(...options)
			if (refocus !== null) {
				const next =
					container.querySelector<HTMLInputElement>(
						`input[name="${name}"][value="${CSS.escape(refocus)}"]`,
					) ??
					container.querySelector<HTMLInputElement>(`input[name="${name}"]`)
				if (next && !next.disabled) next.focus({ preventScroll: true })
			}
		},
	}
}

/** A checkout quote's line id is the line's position on the order. */
export function orderLineName(
	names: readonly string[],
	lineId: string,
): string | null {
	if (!/^\d+$/.test(lineId)) return null
	return names[Number(lineId)] ?? null
}

/** Builds the pick for one quote row; null when the row cannot be used. */
export function selectionFor(
	quote: LoyaltyCheckoutQuote,
	rewardId: string,
): LoyaltyOrderReward | null {
	const row = quote.rewards.find((entry) => entry.rewardId === rewardId)
	if (!row || !row.applicable || !row.affordable) return null
	return {
		rewardId: row.rewardId,
		rewardVersion: row.rewardVersion,
		expectedDiscountMinor: row.discountMinor,
		targetLineId: row.targetLineId,
	}
}

/**
 * The pick to send with the order or tab payment: only what the freshest
 * quote still honors, with the discount the guest was shown. Anything else
 * (stale pick, dropped reward) returns null and the order goes without one.
 */
export function honoredSelection(
	quote: LoyaltyCheckoutQuote | null,
	selection: LoyaltyOrderReward | null,
): LoyaltyOrderReward | null {
	if (!quote || !selection || quote.selectedRewardId !== selection.rewardId) {
		return null
	}
	const pick = selectionFor(quote, selection.rewardId)
	if (!pick) return null
	return { ...pick, expectedDiscountMinor: quote.totals.discountMinor }
}
