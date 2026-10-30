import { type I18n } from '@lingui/core'
import {
	type LoyaltyCustomerApproval,
	type LoyaltyHistoryEntry,
	type LoyaltyPublicProgram,
	type LoyaltyPublicReward,
	type LoyaltyPublicUnitLabel,
} from '@repo/loyalty'
import { LOYALTY_LABELS, pluralForms, withValues } from './labels'

/**
 * Pure display helpers for the rewards wallet (no I/O). Numbers follow the
 * i18n language with Western digits, like the organization website.
 */

/** Western digits in every language (`ar` would otherwise use Arabic-Indic ones on some engines). */
export function latinDigits(locale: string): string {
	return locale.includes('-u-') ? locale : `${locale}-u-nu-latn`
}

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

function fillCount(template: string, count: string): string {
	return template.replace(/\{count\}/g, count)
}

/**
 * `1 point`, `120 stars`, `-30 points`: the program's own unit label, in the
 * plural form the language uses for the count. A label this app does not know
 * shows the bare number rather than a unit the program may not use.
 */
export function formatPoints(
	count: number,
	unit: LoyaltyPublicUnitLabel,
	i18n: I18n,
	options: { signed?: boolean } = {},
): string {
	const locale = i18n.locale
	if (unit === 'unknown') return formatCount(count, locale)
	const forms = pluralForms(
		i18n,
		unit === 'stars' ? LOYALTY_LABELS.stars : LOYALTY_LABELS.points,
	)
	const form = forms[pluralCategory(count, locale)]
	// Some forms carry no number (Arabic "نقطتان", two points); a sign needs one.
	const needsNumber = count < 0 || options.signed === true
	const template =
		form && (!needsNumber || form.includes('{count}'))
			? form
			: (forms.other ?? '{count}')
	return fillCount(template, formatCount(count, locale))
}

/** A signed history delta: `+12 points`, `−30 points`. */
export function formatDelta(
	delta: number,
	unit: LoyaltyPublicUnitLabel,
	i18n: I18n,
): string {
	const magnitude = formatPoints(Math.abs(delta), unit, i18n, { signed: true })
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

/**
 * Integer minor units in the given currency. The divisor comes from the
 * currency's own exponent (USD 2, JPY 0, KWD 3), never a hard-coded 100.
 */
export function formatMinor(
	amountMinor: number,
	currency: string,
	locale: string,
): string {
	const code = (currency || 'USD').toUpperCase()
	try {
		const formatter = new Intl.NumberFormat(latinDigits(locale), {
			style: 'currency',
			currency: code,
		})
		const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2
		return formatter.format(amountMinor / 10 ** digits)
	} catch {
		return `${amountMinor} ${code}`
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
	i18n: I18n,
): RewardDescription {
	const locale = i18n.locale
	const money = (minor: number) => formatMinor(minor, reward.currency, locale)
	if (reward.kind === 'free_item' || !reward.discount) {
		const item = reward.freeItemId
			? reward.labels.items[reward.freeItemId]
			: null
		return {
			value: item
				? i18n._(withValues(LOYALTY_LABELS.rewardFreeItem, { item }))
				: i18n._(LOYALTY_LABELS.rewardFreeItemGeneric),
			scope: i18n._(LOYALTY_LABELS.rewardFreeItemNote),
			cap: null,
		}
	}
	const discount = reward.discount
	const value =
		discount.type === 'fixed'
			? i18n._(
					withValues(LOYALTY_LABELS.rewardFixedOff, {
						amount: money(discount.amountMinor),
					}),
				)
			: i18n._(
					withValues(LOYALTY_LABELS.rewardPercentOff, {
						percent: formatPercentBp(discount.percentBp, locale),
					}),
				)
	const cap =
		discount.type === 'percent' && discount.maxDiscountMinor !== null
			? i18n._(
					withValues(LOYALTY_LABELS.rewardCap, {
						amount: money(discount.maxDiscountMinor),
					}),
				)
			: null
	let scope = i18n._(LOYALTY_LABELS.rewardScopeOrder)
	if (reward.kind === 'items') {
		const names = namesFor(reward.itemIds, reward.labels.items)
		scope = names
			? i18n._(
					withValues(LOYALTY_LABELS.rewardScopeItems, {
						items: formatList(names, locale),
					}),
				)
			: i18n._(LOYALTY_LABELS.rewardScopeItemsGeneric)
	} else if (reward.kind === 'categories') {
		const names = namesFor(reward.categoryIds, reward.labels.categories)
		scope = names
			? i18n._(
					withValues(LOYALTY_LABELS.rewardScopeCategories, {
						categories: formatList(names, locale),
					}),
				)
			: i18n._(LOYALTY_LABELS.rewardScopeCategoriesGeneric)
	}
	return { value, scope, cap }
}

/**
 * The earning rule and its minimum spend, in sentences. A rule this app does
 * not know gets no sentence.
 */
export function describeEarning(
	program: LoyaltyPublicProgram,
	i18n: I18n,
): string[] {
	const locale = i18n.locale
	const rule = program.earning
	const points =
		'points' in rule ? formatPoints(rule.points, program.unitLabel, i18n) : ''
	const lines: string[] = []
	if (rule.method === 'spend') {
		lines.push(
			i18n._(
				withValues(LOYALTY_LABELS.earnSpend, {
					points,
					amount: formatMinor(rule.perMinor, program.currency, locale),
				}),
			),
		)
	} else if (rule.method === 'visit') {
		lines.push(i18n._(withValues(LOYALTY_LABELS.earnVisit, { points })))
	} else if (rule.method === 'items') {
		const names = namesFor(rule.itemIds, program.labels.items)
		lines.push(
			names
				? i18n._(
						withValues(LOYALTY_LABELS.earnItems, {
							points,
							items: formatList(names, locale),
						}),
					)
				: i18n._(withValues(LOYALTY_LABELS.earnItemsGeneric, { points })),
		)
	} else if (rule.method === 'categories') {
		const names = namesFor(rule.categoryIds, program.labels.categories)
		lines.push(
			names
				? i18n._(
						withValues(LOYALTY_LABELS.earnCategories, {
							points,
							categories: formatList(names, locale),
						}),
					)
				: i18n._(withValues(LOYALTY_LABELS.earnCategoriesGeneric, { points })),
		)
	}
	if (program.minimumSpendMinor > 0) {
		lines.push(
			i18n._(
				withValues(LOYALTY_LABELS.earnMinimum, {
					amount: formatMinor(
						program.minimumSpendMinor,
						program.currency,
						locale,
					),
				}),
			),
		)
	}
	if (rule.method === 'spend' || program.minimumSpendMinor > 0) {
		lines.push(i18n._(LOYALTY_LABELS.earnExcludes))
	}
	return lines
}

/**
 * 0–100, how far `available` is toward a reward costing `cost`. Integer
 * math: `57 / 100 * 100` is 56.99… in floating point.
 */
export function progressPercent(available: number, cost: number): number {
	if (cost <= 0) return 100
	const percent = Math.floor((Math.max(0, available) * 100) / cost)
	return Math.min(100, Math.max(0, percent))
}

/** `57%` for a 0–100 progress value, in the language's own percent style. */
export function formatPercent(percent: number, locale: string): string {
	try {
		return new Intl.NumberFormat(latinDigits(locale), {
			style: 'percent',
			maximumFractionDigits: 0,
		}).format(percent / 100)
	} catch {
		return `${percent}%`
	}
}

/**
 * A name the business typed, such as a reward, kept in its own direction so a
 * Latin name in Arabic text (or the reverse) does not reorder the punctuation
 * and numbers around it.
 */
export function isolateName(name: string): string {
	return `\u2068${name}\u2069`
}

/** Keeps numbers and codes left-to-right inside right-to-left text. */
export function isolateLtr(value: string): string {
	return `\u2066${value}\u2069`
}

export function historyEntryLabel(
	entry: LoyaltyHistoryEntry,
	i18n: I18n,
): string {
	switch (entry.type) {
		case 'earn':
			return i18n._(LOYALTY_LABELS.historyEarn)
		case 'earn_reversal':
			return i18n._(LOYALTY_LABELS.historyEarnReversal)
		case 'redeem':
			return entry.rewardName
				? i18n._(
						withValues(LOYALTY_LABELS.historyRedeem, {
							reward: isolateName(entry.rewardName),
						}),
					)
				: i18n._(LOYALTY_LABELS.historyRedeemGeneric)
		case 'redeem_restore':
			return i18n._(LOYALTY_LABELS.historyRedeemRestore)
		case 'adjust':
			return i18n._(LOYALTY_LABELS.historyAdjust)
	}
}

export function channelLabel(
	channel: LoyaltyHistoryEntry['channel'],
	i18n: I18n,
): string | null {
	switch (channel) {
		case 'web':
			return i18n._(LOYALTY_LABELS.channelWeb)
		case 'pos':
			return i18n._(LOYALTY_LABELS.channelPos)
		case 'qr':
			return i18n._(LOYALTY_LABELS.channelQr)
		case 'native':
			return i18n._(LOYALTY_LABELS.channelNative)
		default:
			return null
	}
}

/** A ledger entry's time in the device's own zone. */
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
	i18n: I18n,
): string {
	return i18n._(
		withValues(LOYALTY_LABELS.approvalDetail, {
			points: formatPoints(approval.pointsCost, unit, i18n),
			amount: formatMinor(
				approval.discountMinor,
				approval.currency,
				i18n.locale,
			),
		}),
	)
}
