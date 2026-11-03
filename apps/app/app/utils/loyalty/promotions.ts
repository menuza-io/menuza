import { type MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import {
	computeEarning,
	computePromotionBonus,
	LOYALTY_MULTIPLIER_MAX_BP,
	LOYALTY_MULTIPLIER_ONE_BP,
	promotionIsLive,
	type LoyaltyProgramConfig,
	type LoyaltyPromotion,
	type LoyaltyPurchaseSnapshot,
} from '@repo/loyalty'
import {
	addDays,
	businessDateOf,
	dayOfWeek,
	localParts,
	parseDate,
	parseLocalTimestamp,
	zonedLocalToUtc,
} from '@repo/zoned-time'
import {
	formatLoyaltyInstant,
	formatLoyaltyMoney,
	isUsableTimeZone,
} from '#app/utils/loyalty/loyalty-view.ts'
import { asciiNumberText, parseMoneyToMinor } from '#app/utils/money-input.ts'

/**
 * Display and input helpers for loyalty promotions. The rules themselves live
 * in `@repo/loyalty` (`promotions.ts`); this file only reads and writes the
 * strings an operator types, and describes a promotion in plain words.
 */

type Translate = (descriptor: MessageDescriptor) => string

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type PromotionStatus = 'live' | 'scheduled' | 'ended' | 'paused'

export const PROMOTION_STATUS_LABELS: Record<
	PromotionStatus,
	MessageDescriptor
> = {
	live: msg`Live now`,
	scheduled: msg`Scheduled`,
	ended: msg`Ended`,
	paused: msg`Paused`,
}

/**
 * Where a promotion stands at `now`. A promotion that is switched off is
 * paused whatever its dates say; past its end date it is ended; running at
 * this moment (its dates and its weekly window, in the program's time zone) it
 * is live; anything else is scheduled for later. The location list is
 * ignored here: it says where a promotion applies, not whether it is on.
 */
export function promotionStatus(
	promotion: LoyaltyPromotion,
	now: number,
	timeZone: string,
): PromotionStatus {
	if (!promotion.enabled) return 'paused'
	if (promotion.endsAt !== null && now >= promotion.endsAt) return 'ended'
	const live = promotionIsLive(
		{ ...promotion, locationIds: null },
		{ occurredAt: now, timeZone, locationId: null },
	)
	return live ? 'live' : 'scheduled'
}

// ---------------------------------------------------------------------------
// Typed values
// ---------------------------------------------------------------------------

/** A multiplier in basis points as the "times" a field shows: 15000 → "1.5". */
export function multiplierToInput(bp: number | null | undefined): string {
	if (bp === null || bp === undefined) return ''
	const times = bp / LOYALTY_MULTIPLIER_ONE_BP
	return String(Number(times.toFixed(2)))
}

/**
 * "2", "1.5" or "١٫٥" to basis points, or null. Above 1x and at most 10x, up
 * to two decimals. A comma is never a decimal mark.
 */
export function parseMultiplierToBp(input: string): number | null {
	const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(asciiNumberText(input))
	if (!match) return null
	const bp =
		Number(match[1]) * LOYALTY_MULTIPLIER_ONE_BP +
		Number((match[2] ?? '').padEnd(2, '0')) * 100
	return bp > LOYALTY_MULTIPLIER_ONE_BP && bp <= LOYALTY_MULTIPLIER_MAX_BP
		? bp
		: null
}

/** Minutes after local midnight as the `HH:mm` a time field shows. */
export function minutesToTimeInput(minutes: number): string {
	const wrapped = ((minutes % 1440) + 1440) % 1440
	const hours = Math.floor(wrapped / 60)
	return `${String(hours).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

/** `HH:mm` to minutes after local midnight, or null. */
export function parseTimeInput(input: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(asciiNumberText(input.trim()))
	if (!match) return null
	const hours = Number(match[1])
	const minutes = Number(match[2])
	return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null
}

/** An instant as the `YYYY-MM-DDTHH:mm` a date-time field shows, in `timeZone`. */
export function instantToLocalInput(
	at: number | null | undefined,
	timeZone: string,
): string {
	if (at === null || at === undefined) return ''
	const p = localParts(at, timeZone)
	const two = (value: number) => String(value).padStart(2, '0')
	return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`
}

/**
 * A date-time field's value, read as wall-clock time in `timeZone`: an
 * instant, `null` for an empty field, `undefined` for one that is not a real
 * date and time.
 */
export function parseLocalInput(
	input: string,
	timeZone: string,
): number | null | undefined {
	const value = input.trim()
	if (value === '') return null
	try {
		return parseLocalTimestamp(value, timeZone)
	} catch {
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function namesOf(
	ids: readonly string[],
	labels: Record<string, string>,
	limit = 2,
): { shown: string; extra: number } {
	const names = ids.map((id) => labels[id] ?? id)
	return {
		shown: names.slice(0, limit).join(', '),
		extra: Math.max(0, names.length - limit),
	}
}

/** What the promotion does, in one sentence. */
export function describePromotionEffect(
	promotion: LoyaltyPromotion,
	tx: Translate,
): string {
	const { scope } = promotion
	if (promotion.kind === 'multiplier') {
		const times = multiplierToInput(promotion.value)
		if (scope.type === 'order') {
			return tx(msg`${times}x points on the whole order`)
		}
		if (scope.type === 'items') {
			const { shown, extra } = namesOf(scope.itemIds, promotion.labels.items)
			return extra > 0
				? tx(msg`${times}x points on ${shown} and ${extra} more`)
				: tx(msg`${times}x points on ${shown}`)
		}
		const { shown, extra } = namesOf(
			scope.categoryIds,
			promotion.labels.categories,
		)
		return extra > 0
			? tx(msg`${times}x points on ${shown} and ${extra} more`)
			: tx(msg`${times}x points on ${shown}`)
	}
	const points = promotion.value
	if (scope.type === 'order') {
		return tx(
			msg`${plural(points, { one: '# bonus point', other: '# bonus points' })} on every purchase`,
		)
	}
	const names =
		scope.type === 'items'
			? namesOf(scope.itemIds, promotion.labels.items)
			: namesOf(scope.categoryIds, promotion.labels.categories)
	const { shown, extra } = names
	return extra > 0
		? tx(
				msg`${plural(points, { one: '# bonus point', other: '# bonus points' })} for each of ${shown} and ${extra} more`,
			)
		: tx(
				msg`${plural(points, { one: '# bonus point', other: '# bonus points' })} for each ${shown}`,
			)
}

/** A sample time of day, formatted by the locale. */
function formatMinutes(minutes: number, locale: string): string {
	try {
		return new Intl.DateTimeFormat(locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: 'UTC',
		}).format(new Date(Date.UTC(2026, 0, 4, 0, minutes % 1440)))
	} catch {
		return minutesToTimeInput(minutes)
	}
}

function weekdayName(day: number, locale: string): string {
	try {
		// 2026-01-04 is a Sunday.
		return new Intl.DateTimeFormat(locale, {
			weekday: 'short',
			timeZone: 'UTC',
		}).format(new Date(Date.UTC(2026, 0, 4 + day)))
	} catch {
		return String(day)
	}
}

/** When it runs: the weekly window, the dates, or "Always". */
export function describePromotionSchedule(
	promotion: LoyaltyPromotion,
	input: { locale: string; timeZone: string },
	tx: Translate,
): string {
	const parts: string[] = []
	if (promotion.recurring) {
		const days = [...promotion.recurring.weekdays]
			.sort((a, b) => a - b)
			.map((day) => weekdayName(day, input.locale))
			.join(', ')
		const from = formatMinutes(promotion.recurring.fromMinute, input.locale)
		const to = formatMinutes(promotion.recurring.toMinute, input.locale)
		parts.push(tx(msg`${days}, ${from} to ${to}`))
	}
	if (promotion.startsAt !== null) {
		const start =
			formatLoyaltyInstant(promotion.startsAt, input.locale, input.timeZone) ??
			''
		parts.push(tx(msg`from ${start}`))
	}
	if (promotion.endsAt !== null) {
		const end =
			formatLoyaltyInstant(promotion.endsAt, input.locale, input.timeZone) ?? ''
		parts.push(tx(msg`until ${end}`))
	}
	return parts.length > 0 ? parts.join(' · ') : tx(msg`Always`)
}

/** Where it applies: every location, or the names of those chosen. */
export function describePromotionLocations(
	promotion: LoyaltyPromotion,
	locations: ReadonlyArray<{ id: string; name: string }>,
	tx: Translate,
): string {
	if (promotion.locationIds === null) return tx(msg`All locations`)
	const names = promotion.locationIds.map(
		(id) => locations.find((location) => location.id === id)?.name ?? id,
	)
	if (names.length <= 2) return names.join(', ')
	const shown = names.slice(0, 2).join(', ')
	const extra = names.length - 2
	return tx(msg`${shown} and ${extra} more`)
}

// ---------------------------------------------------------------------------
// The live example
// ---------------------------------------------------------------------------

export type PromotionExample = {
	/** The sample sale, in minor units. */
	orderMinor: number
	/** When the sample sale finished. */
	at: number
	/** What the program's rule earns on its own. */
	basePoints: number
	/** The bonus this promotion adds (0 when it does not apply). */
	bonusPoints: number
	/** The base award plus the bonus. */
	totalPoints: number
	/** The promotion matched the sample sale. */
	applies: boolean
}

/** A time that falls inside the promotion, so the example shows it working. */
function sampleInstant(
	promotion: LoyaltyPromotion,
	timeZone: string,
	now: number,
): number {
	const earliest = Math.max(now, promotion.startsAt ?? 0)
	const { recurring } = promotion
	if (!recurring) return earliest
	const middle = Math.max(
		recurring.fromMinute,
		Math.floor((recurring.fromMinute + recurring.toMinute) / 2 / 5) * 5,
	)
	const firstDay = businessDateOf(earliest, timeZone)
	for (let offset = 0; offset < 15; offset += 1) {
		const date = addDays(firstDay, offset)
		if (!recurring.weekdays.includes(dayOfWeek(date))) continue
		const { year, month, day } = parseDate(date)
		const at = zonedLocalToUtc(year, month, day, 0, middle, timeZone)
		if (at >= earliest) return at
	}
	return earliest
}

/**
 * The same math a settled purchase goes through, over a sample sale: the
 * program's own earning rule first, then this promotion on top. The sample is
 * one line of about 20.00 (or the minimum spend, when that is higher) made of
 * an item that matches the program's rule and the promotion's scope, finished
 * at a time the promotion covers.
 */
export function promotionExample(input: {
	config: LoyaltyProgramConfig
	promotion: LoyaltyPromotion
	now: number
}): PromotionExample {
	const { config, promotion, now } = input
	const timeZone = isUsableTimeZone(config.timeZone) ? config.timeZone : 'UTC'
	const orderMinor = Math.max(
		parseMoneyToMinor('20', { currency: config.currency }) ?? 2000,
		config.minimumSpendMinor,
	)
	const itemIds: string[] = []
	const categoryIds: string[] = []
	if (promotion.scope.type === 'items')
		itemIds.push(promotion.scope.itemIds[0]!)
	if (promotion.scope.type === 'categories') {
		categoryIds.push(promotion.scope.categoryIds[0]!)
	}
	if (config.earning.method === 'items')
		itemIds.push(config.earning.itemIds[0]!)
	if (config.earning.method === 'categories') {
		categoryIds.push(config.earning.categoryIds[0]!)
	}
	// One item that satisfies every rule at once; when the program and the
	// promotion name different items, the sample gets one line for each.
	const lines: LoyaltyPurchaseSnapshot['lines'] =
		itemIds.length > 1 && new Set(itemIds).size > 1
			? [
					{
						lineId: 'sample-1',
						itemId: itemIds[0]!,
						categoryIds,
						quantity: 1,
						netMinor: Math.ceil(orderMinor / 2),
						rewardUnits: 0,
					},
					{
						lineId: 'sample-2',
						itemId: itemIds[1]!,
						categoryIds,
						quantity: 1,
						netMinor: orderMinor - Math.ceil(orderMinor / 2),
						rewardUnits: 0,
					},
				]
			: [
					{
						lineId: 'sample-1',
						itemId: itemIds[0] ?? 'sample-item',
						categoryIds,
						quantity: 1,
						netMinor: orderMinor,
						rewardUnits: 0,
					},
				]
	const snapshot: LoyaltyPurchaseSnapshot = {
		currency: config.currency,
		totalPaidMinor: orderMinor,
		lines,
	}
	const earning = computeEarning({
		rule: config.earning,
		minimumSpendMinor: config.minimumSpendMinor,
		snapshot,
	})
	const at = sampleInstant(promotion, timeZone, now)
	const bonus = computePromotionBonus({
		promotions: [promotion],
		stacking: 'best',
		earning,
		snapshot,
		occurredAt: at,
		timeZone,
		locationId: promotion.locationIds?.[0] ?? null,
	})
	return {
		orderMinor,
		at,
		basePoints: earning.points,
		bonusPoints: bonus.points,
		totalPoints: earning.points + bonus.points,
		applies: bonus.points > 0,
	}
}

/** The example as one sentence. */
export function describePromotionExample(
	example: PromotionExample,
	input: { currency: string; locale: string; timeZone: string },
	tx: Translate,
): string {
	const amount = formatLoyaltyMoney(
		example.orderMinor,
		input.currency,
		input.locale,
	)
	const when =
		formatLoyaltyInstant(example.at, input.locale, input.timeZone) ?? ''
	const base = example.basePoints
	const total = example.totalPoints
	if (!example.applies) {
		return tx(
			msg`A ${amount} order on ${when} earns ${base} points, and this promotion adds nothing to it.`,
		)
	}
	return tx(
		msg`A ${amount} order on ${when} earns ${base} points; with this promotion it earns ${total}.`,
	)
}

/** A fresh promotion id: short, URL-safe and unique enough for 25 entries. */
export function newPromotionId(): string {
	return `promo_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}
