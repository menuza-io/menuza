import {
	type LoyaltyCustomerApproval,
	type LoyaltyHistoryEntry,
	type LoyaltyPublicProgram,
	type LoyaltyPublicReward,
	type LoyaltyPublicUnitLabel,
} from '@repo/loyalty'
import { type LoyaltyLabels } from '~/lib/loyalty/labels'
import { type LoyaltyClientErrorCode } from '~/lib/loyalty-client'
import { fillTemplate } from '~/lib/ordering/money'
import { formatMinor } from '~/lib/reservations/money'
import { latinDigits } from '~/lib/reservations/time'

/** Pure display helpers for the rewards wallet (no DOM, no I/O). */

export function formatCount(value: number, locale: string): string {
	try {
		return new Intl.NumberFormat(latinDigits(locale)).format(value)
	} catch {
		return String(value)
	}
}

function pluralCategory(count: number, locale: string): Intl.LDMLPluralRule {
	try {
		return new Intl.PluralRules(locale).select(count)
	} catch {
		return 'other'
	}
}

/**
 * `1 point`, `120 stars`, `-30 points`: the program's own unit label, in the
 * plural form the page language uses for the count. A label this site does not
 * know shows the bare number rather than a unit the program may not use.
 */
export function formatPoints(
	count: number,
	unit: LoyaltyPublicUnitLabel,
	labels: LoyaltyLabels,
	locale: string,
	options: { signed?: boolean } = {},
): string {
	if (unit === 'unknown') return formatCount(count, locale)
	const forms = (unit === 'stars' ? labels.stars : labels.points) ?? {}
	const form = forms[pluralCategory(count, locale)]
	// Some forms carry no number (Arabic "نقطتان", two points); a sign needs one.
	const needsNumber = count < 0 || options.signed === true
	const template =
		form && (!needsNumber || form.includes('{count}'))
			? form
			: (forms.other ?? '{count}')
	return fillTemplate(template, { count: formatCount(count, locale) })
}

/** A signed history delta: `+12 points`, `−30 points`. */
export function formatDelta(
	delta: number,
	unit: LoyaltyPublicUnitLabel,
	labels: LoyaltyLabels,
	locale: string,
): string {
	const magnitude = formatPoints(Math.abs(delta), unit, labels, locale, {
		signed: true,
	})
	return delta < 0 ? `\u2212${magnitude}` : `+${magnitude}`
}

export function formatList(values: string[], locale: string): string {
	try {
		return new Intl.ListFormat(locale, {
			style: 'long',
			type: 'conjunction',
		}).format(values)
	} catch {
		return values.join(', ')
	}
}

function formatPercentBp(bp: number, locale: string): string {
	try {
		return new Intl.NumberFormat(latinDigits(locale), {
			style: 'percent',
			maximumFractionDigits: 2,
		}).format(bp / 10_000)
	} catch {
		return `${bp / 100}%`
	}
}

function namesFor(
	ids: string[],
	table: Record<string, string>,
): string[] | null {
	const names = ids
		.map((id) => table[id])
		.filter((name): name is string => Boolean(name))
	// A partial list would misstate the reward; fall back to the generic text.
	return names.length === ids.length && names.length > 0 ? names : null
}

export type RewardDescription = {
	/** What the reward gives: `$5 off`, `20% off`, `Free Latte`. */
	value: string
	/** Where it applies, or the free-item rule. */
	scope: string
	/** `Up to $3 off` for capped percentages; null otherwise. */
	cap: string | null
}

export function describeReward(
	reward: LoyaltyPublicReward,
	labels: LoyaltyLabels,
	locale: string,
): RewardDescription {
	const money = (minor: number) => formatMinor(minor, reward.currency, locale)
	if (reward.kind === 'free_item' || !reward.discount) {
		const item = reward.freeItemId
			? reward.labels.items[reward.freeItemId]
			: null
		return {
			value: item
				? fillTemplate(labels.rewardFreeItem, { item })
				: labels.rewardFreeItemGeneric,
			scope: labels.rewardFreeItemNote,
			cap: null,
		}
	}
	const discount = reward.discount
	const value =
		discount.type === 'fixed'
			? fillTemplate(labels.rewardFixedOff, {
					amount: money(discount.amountMinor),
				})
			: fillTemplate(labels.rewardPercentOff, {
					percent: formatPercentBp(discount.percentBp, locale),
				})
	const cap =
		discount.type === 'percent' && discount.maxDiscountMinor !== null
			? fillTemplate(labels.rewardCap, {
					amount: money(discount.maxDiscountMinor),
				})
			: null
	let scope = labels.rewardScopeOrder
	if (reward.kind === 'items') {
		const names = namesFor(reward.itemIds, reward.labels.items)
		scope = names
			? fillTemplate(labels.rewardScopeItems, {
					items: formatList(names, locale),
				})
			: labels.rewardScopeItemsGeneric
	} else if (reward.kind === 'categories') {
		const names = namesFor(reward.categoryIds, reward.labels.categories)
		scope = names
			? fillTemplate(labels.rewardScopeCategories, {
					categories: formatList(names, locale),
				})
			: labels.rewardScopeCategoriesGeneric
	}
	return { value, scope, cap }
}

/**
 * The earning rule and its minimum spend, in sentences. A rule this site does
 * not know gets no sentence.
 */
export function describeEarning(
	program: LoyaltyPublicProgram,
	labels: LoyaltyLabels,
	locale: string,
): string[] {
	const rule = program.earning
	const points =
		'points' in rule
			? formatPoints(rule.points, program.unitLabel, labels, locale)
			: ''
	const lines: string[] = []
	if (rule.method === 'spend') {
		lines.push(
			fillTemplate(labels.earnSpend, {
				points,
				amount: formatMinor(rule.perMinor, program.currency, locale),
			}),
		)
	} else if (rule.method === 'visit') {
		lines.push(fillTemplate(labels.earnVisit, { points }))
	} else if (rule.method === 'items') {
		const names = namesFor(rule.itemIds, program.labels.items)
		lines.push(
			names
				? fillTemplate(labels.earnItems, {
						points,
						items: formatList(names, locale),
					})
				: fillTemplate(labels.earnItemsGeneric, { points }),
		)
	} else if (rule.method === 'categories') {
		const names = namesFor(rule.categoryIds, program.labels.categories)
		lines.push(
			names
				? fillTemplate(labels.earnCategories, {
						points,
						categories: formatList(names, locale),
					})
				: fillTemplate(labels.earnCategoriesGeneric, { points }),
		)
	}
	if (program.minimumSpendMinor > 0) {
		lines.push(
			fillTemplate(labels.earnMinimum, {
				amount: formatMinor(
					program.minimumSpendMinor,
					program.currency,
					locale,
				),
			}),
		)
	}
	if (rule.method === 'spend' || program.minimumSpendMinor > 0) {
		lines.push(labels.earnExcludes)
	}
	return lines
}

/** 0–100, how far `available` is toward a reward costing `cost`. */
export function progressPercent(available: number, cost: number): number {
	if (cost <= 0) return 100
	const ratio = Math.max(0, available) / cost
	return Math.min(100, Math.max(0, Math.floor(ratio * 100)))
}

/**
 * A name the business typed, such as a reward, kept in its own direction so a
 * Latin name in Arabic text (or the reverse) does not reorder the punctuation
 * and numbers around it.
 */
export function isolateName(name: string): string {
	return `\u2068${name}\u2069`
}

export function historyEntryLabel(
	entry: LoyaltyHistoryEntry,
	labels: LoyaltyLabels,
): string {
	switch (entry.type) {
		case 'earn':
			return labels.historyEarn
		case 'earn_reversal':
			return labels.historyEarnReversal
		case 'redeem':
			return entry.rewardName
				? fillTemplate(labels.historyRedeem, {
						reward: isolateName(entry.rewardName),
					})
				: labels.historyRedeemGeneric
		case 'redeem_restore':
			return labels.historyRedeemRestore
		case 'adjust':
			return labels.historyAdjust
	}
}

export function channelLabel(
	channel: LoyaltyHistoryEntry['channel'],
	labels: LoyaltyLabels,
): string | null {
	switch (channel) {
		case 'web':
			return labels.channelWeb
		case 'pos':
			return labels.channelPos
		case 'qr':
			return labels.channelQr
		case 'native':
			return labels.channelNative
		default:
			return null
	}
}

/** A ledger time in the visitor's own zone. */
export function formatEntryDate(
	at: number,
	locale: string,
	style: 'datetime' | 'date' = 'datetime',
): string {
	try {
		return new Intl.DateTimeFormat(
			latinDigits(locale),
			style === 'date'
				? { dateStyle: 'medium' }
				: { dateStyle: 'medium', timeStyle: 'short' },
		).format(new Date(at))
	} catch {
		return new Date(at).toISOString()
	}
}

/** `A B C D, E F G H`: screen readers read a member code one character at a time. */
export function spellCode(code: string): string {
	return code
		.split('-')
		.map((part) => part.split('').join(' '))
		.join(', ')
}

/** `4:05` for a countdown; `0:00` once past. */
export function formatCountdown(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function approvalDetail(
	approval: LoyaltyCustomerApproval,
	unit: LoyaltyPublicUnitLabel,
	labels: LoyaltyLabels,
	locale: string,
): string {
	return fillTemplate(labels.approvalDetail, {
		points: formatPoints(approval.pointsCost, unit, labels, locale),
		amount: formatMinor(approval.discountMinor, approval.currency, locale),
	})
}

type ErrorLabelKey = keyof Pick<
	LoyaltyLabels,
	| 'errorNetwork'
	| 'errorRateLimited'
	| 'errorUnavailable'
	| 'errorDisabled'
	| 'errorMemberInactive'
	| 'errorProgramInactive'
	| 'errorInsufficientPoints'
	| 'errorRewardUnavailable'
	| 'redemptionPaused'
	| 'errorSignedOut'
	| 'errorWrongSite'
	| 'approvalExpired'
	| 'approvalClosed'
	| 'errorGeneric'
>

const ERROR_LABELS: Partial<Record<LoyaltyClientErrorCode, ErrorLabelKey>> = {
	network: 'errorNetwork',
	rate_limited: 'errorRateLimited',
	loyalty_unavailable: 'errorUnavailable',
	loyalty_disabled: 'errorDisabled',
	redemption_disabled: 'redemptionPaused',
	program_not_found: 'errorDisabled',
	organization_not_found: 'errorDisabled',
	member_not_found: 'errorDisabled',
	member_inactive: 'errorMemberInactive',
	program_inactive: 'errorProgramInactive',
	insufficient_points: 'errorInsufficientPoints',
	reward_unavailable: 'errorRewardUnavailable',
	reward_not_found: 'errorRewardUnavailable',
	signed_out: 'errorSignedOut',
	organization_mismatch: 'errorWrongSite',
	approval_expired: 'approvalExpired',
	approval_closed: 'approvalClosed',
	approval_not_found: 'approvalClosed',
}

/** Which localized message a failed call shows. */
export function loyaltyErrorLabelKey(
	code: LoyaltyClientErrorCode,
): ErrorLabelKey {
	return ERROR_LABELS[code] ?? 'errorGeneric'
}
