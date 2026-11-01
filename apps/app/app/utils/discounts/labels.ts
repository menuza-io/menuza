import { type MessageDescriptor } from '@lingui/core'
import { msg, plural } from '@lingui/core/macro'
import {
	type DiscountApplication,
	type DiscountChannel,
	type DiscountCombineClass,
	type DiscountDefinition,
	type DiscountEligibility,
	type DiscountFulfillment,
	type DiscountLimitPeriod,
	type DiscountRefusalReason,
	type DiscountStatus,
	type DiscountValueType,
} from '@repo/discounts'
import { minorToMajor } from '#app/utils/money-input.ts'

/**
 * Plain-language labels and one-line summaries for discounts. Callers pass
 * `tx` (`i18n._`) so nothing here touches React.
 */

export type Translate = (descriptor: MessageDescriptor) => string

export const DISCOUNT_STATUS_LABELS: Record<DiscountStatus, MessageDescriptor> =
	{
		active: msg`Active`,
		paused: msg`Paused`,
		archived: msg`Archived`,
	}

/**
 * What the list shows for a discount: the stored status, refined for an active
 * one that has not started, has ended or has used up its limit.
 */
export type DiscountDisplayState =
	DiscountStatus | 'scheduled' | 'ended' | 'limit_reached'

export const DISCOUNT_DISPLAY_STATE_LABELS: Record<
	DiscountDisplayState,
	MessageDescriptor
> = {
	active: msg`Active`,
	paused: msg`Paused`,
	archived: msg`Archived`,
	scheduled: msg`Scheduled`,
	ended: msg`Ended`,
	limit_reached: msg`Limit reached`,
}

/**
 * The state to show for a discount. Dates are local date-times, so `nowLocal`
 * is the operator's own clock as `YYYY-MM-DDTHH:MM` (the engine compares in
 * each location's zone; the two match for a single-zone business). `uses` is
 * the lifetime count: pass null when the count covers a date range, which says
 * nothing about a lifetime limit.
 */
export function discountDisplayState(
	input: {
		status: string
		startsAt: string | null
		endsAt: string | null
		totalLimit: number | null
		uses: number | null
	},
	nowLocal: string | readonly string[] | null,
): DiscountDisplayState | string {
	if (input.status !== 'active') return input.status
	// One clock reading per location zone. The discount has ended only when it
	// has ended everywhere it runs, and it is scheduled only while no location
	// has reached its start.
	const clocks =
		typeof nowLocal === 'string' ? [nowLocal] : nowLocal ? [...nowLocal] : []
	if (clocks.length > 0) {
		if (input.endsAt && clocks.every((now) => now >= input.endsAt!)) {
			return 'ended'
		}
		if (input.startsAt && clocks.every((now) => now < input.startsAt!)) {
			return 'scheduled'
		}
	}
	if (
		input.totalLimit !== null &&
		input.uses !== null &&
		input.uses >= input.totalLimit
	) {
		return 'limit_reached'
	}
	return 'active'
}

/**
 * The clock as `YYYY-MM-DDTHH:MM` in an IANA time zone (a location's), or null
 * when the zone name is not one the browser knows.
 */
export function zonedNowText(now: Date, timeZone: string): string | null {
	try {
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
		}).formatToParts(now)
		const get = (type: string) =>
			parts.find((part) => part.type === type)?.value ?? '00'
		return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
	} catch {
		return null
	}
}

/** The clock as `YYYY-MM-DDTHH:MM`, in the browser's own zone. */
export function localNowText(now: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

export const DISCOUNT_APPLICATION_LABELS: Record<
	DiscountApplication,
	MessageDescriptor
> = {
	automatic: msg`Automatic`,
	code: msg`Coupon code`,
	manual: msg`At the till`,
}

export const DISCOUNT_VALUE_TYPE_LABELS: Record<
	DiscountValueType,
	MessageDescriptor
> = {
	percent: msg`Percentage off`,
	fixed: msg`Amount off`,
	free_delivery: msg`Free delivery`,
	fixed_price: msg`Set price`,
	variable_percent: msg`Percentage entered at the till`,
	variable_amount: msg`Amount entered at the till`,
}

/** The kinds of discount, as the "stacks with" choices name them. */
export const DISCOUNT_COMBINE_LABELS: Record<
	DiscountCombineClass,
	MessageDescriptor
> = {
	item: msg`Item discounts`,
	order: msg`Whole-order discounts`,
	delivery: msg`Delivery discounts`,
}

export const DISCOUNT_CHANNEL_LABELS: Record<
	DiscountChannel,
	MessageDescriptor
> = {
	web: msg`Website`,
	qr: msg`QR ordering`,
	pos: msg`In store till`,
	app: msg`Customer app`,
}

export const DISCOUNT_FULFILLMENT_LABELS: Record<
	DiscountFulfillment,
	MessageDescriptor
> = {
	pickup: msg`Pickup`,
	delivery: msg`Delivery`,
	dine_in: msg`Dine in`,
}

export const DISCOUNT_ELIGIBILITY_LABELS: Record<
	DiscountEligibility,
	MessageDescriptor
> = {
	everyone: msg`Everyone`,
	signed_in: msg`Signed in customers`,
	new_customer: msg`New customers (first order)`,
	loyalty_member: msg`Loyalty members`,
}

/** The period choices of a per-customer limit, as full phrases. */
export const DISCOUNT_PERIOD_LABELS: Record<
	DiscountLimitPeriod,
	MessageDescriptor
> = {
	lifetime: msg`Counts across all time`,
	day: msg`Starts again every day`,
	week: msg`Starts again every week`,
}

/** Why a discount would not apply, written for the person setting it up. */
export const DISCOUNT_REFUSAL_LABELS: Record<
	DiscountRefusalReason | 'replaced_by_better_discount',
	MessageDescriptor
> = {
	not_found: msg`It is not active.`,
	not_started: msg`It has not started yet at this date and time.`,
	expired: msg`It has ended by this date and time.`,
	not_available_now: msg`This time is outside the weekly hours.`,
	wrong_location: msg`It is not offered at this location.`,
	wrong_channel: msg`It is not offered on this sales channel.`,
	wrong_fulfillment: msg`It is not offered for this order type.`,
	wrong_drop: msg`Drop orders are left out of this discount.`,
	sign_in_required: msg`The customer has to be signed in.`,
	new_customers_only: msg`Only for a customer's first order.`,
	members_only: msg`Only for loyalty members.`,
	limit_reached: msg`The use limit has been reached.`,
	minimum_not_met: msg`The order is below the minimum spend.`,
	requirement_not_met: msg`The cart does not have the required items.`,
	quantity_not_met: msg`The cart does not have enough of the chosen items.`,
	not_applicable: msg`Nothing in this cart qualifies.`,
	replaced_by_better_discount: msg`Another discount gives the customer more.`,
}

export function formatMoney(
	minor: number,
	currency: string,
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(minorToMajor(minor, currency))
	} catch {
		return `${minorToMajor(minor, currency)} ${currency}`
	}
}

/** "10%" or "12.5%", with the digits and percent sign of the UI language. */
export function percentText(bp: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'percent',
			maximumFractionDigits: 2,
		}).format(bp / 10000)
	} catch {
		return `${bp / 100}%`
	}
}

/** A whole number in the digits of the UI language. */
export function numberText(value: number, locale: string): string {
	try {
		return new Intl.NumberFormat(locale).format(value)
	} catch {
		return String(value)
	}
}

/**
 * Names or short phrases as a list with the separator of the UI language
 * ("Pizza, Wings" in English, with the Arabic comma in Arabic).
 */
export function listText(items: readonly string[], locale: string): string {
	try {
		return new Intl.ListFormat(locale, {
			type: 'unit',
			style: 'short',
		}).format(items)
	} catch {
		return items.join(', ')
	}
}

/**
 * What an amount off is taken from. A fixed amount comes off every matching
 * item (or choice) on an item discount, each item the customer gets in a buy
 * and get, each full meal deal, but only once on the whole order.
 */
export type AmountEach = 'item' | 'choice' | 'got_item' | 'deal'

export function amountEach(
	scope: string,
	quantityKind: string,
): AmountEach | null {
	if (quantityKind === 'buy_get') return 'got_item'
	if (quantityKind === 'bundle') return 'deal'
	if (scope === 'modifiers') return 'choice'
	if (scope === 'items' || scope === 'categories') return 'item'
	return null
}

/** "10% off", "$5.00 off each item", "Free delivery". */
export function valueSummary(
	definition: Pick<
		DiscountDefinition,
		| 'valueType'
		| 'percentBp'
		| 'amountMinor'
		| 'currency'
		| 'maxDiscountMinor'
		| 'tiers'
	>,
	tx: Translate,
	locale: string,
	fallbackCurrency: string,
	each: AmountEach | null = null,
): string {
	if (definition.valueType === 'free_delivery') return tx(msg`Free delivery`)
	if (definition.tiers) return tx(msg`Tiered discount`)
	if (definition.valueType === 'variable_percent') {
		return tx(msg`Percentage entered at the till`)
	}
	if (definition.valueType === 'variable_amount') {
		return tx(msg`Amount entered at the till`)
	}
	if (definition.valueType === 'fixed_price') {
		const price = formatMoney(
			definition.amountMinor ?? 0,
			definition.currency ?? fallbackCurrency,
			locale,
		)
		return tx(msg`Set price ${price}`)
	}
	if (definition.valueType === 'fixed') {
		const amount = formatMoney(
			definition.amountMinor ?? 0,
			definition.currency ?? fallbackCurrency,
			locale,
		)
		if (each === 'item') return tx(msg`${amount} off each item`)
		if (each === 'choice') return tx(msg`${amount} off each choice`)
		if (each === 'got_item') return tx(msg`${amount} off each item they get`)
		if (each === 'deal') return tx(msg`${amount} off each deal`)
		return tx(msg`${amount} off`)
	}
	const percent = percentText(definition.percentBp ?? 0, locale)
	if (definition.maxDiscountMinor !== null) {
		const max = formatMoney(
			definition.maxDiscountMinor,
			fallbackCurrency,
			locale,
		)
		return tx(msg`${percent} off (up to ${max})`)
	}
	return tx(msg`${percent} off`)
}

/** What it covers: "Whole order", "3 items", "Buy 2, get 1 free". */
export function appliesSummary(
	definition: Pick<DiscountDefinition, 'target' | 'quantityRule' | 'valueType'>,
	tx: Translate,
): string {
	const { target, quantityRule: rule } = definition
	if (definition.valueType === 'free_delivery') return tx(msg`Delivery fee`)
	let scope: string
	if (target.scope === 'order') scope = tx(msg`Whole order`)
	else if (target.scope === 'items') {
		const count = target.itemIds.length
		// A plural is the whole message here, which is Lingui's own pattern.
		scope = tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(count, { one: '# item', other: '# items' })}`,
		)
	} else if (target.scope === 'modifiers') {
		const count =
			(target.modifierGroupIds?.length ?? 0) +
			(target.modifierOptionIds?.length ?? 0)
		scope = tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(count, { one: '# modifier choice', other: '# modifier choices' })}`,
		)
	} else {
		const count = target.categoryIds.length
		scope = tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(count, { one: '# category', other: '# categories' })}`,
		)
	}
	if (rule.kind === 'bogo') {
		const { buyQuantity, getQuantity } = rule
		return tx(msg`${scope}: buy ${buyQuantity}, get ${getQuantity} discounted`)
	}
	if (rule.kind === 'buy_get') {
		const getQuantity = rule.get.quantity
		if (rule.buy.quantity === undefined) {
			return tx(msg`Spend on one group, get ${getQuantity} from another`)
		}
		const buyQuantity = rule.buy.quantity
		return tx(msg`Buy ${buyQuantity}, get ${getQuantity} from another group`)
	}
	if (rule.kind === 'bundle') {
		const units = rule.slots.reduce((sum, slot) => sum + slot.quantity, 0)
		return tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(units, { one: 'Meal deal of # item', other: 'Meal deal of # items' })}`,
		)
	}
	if (rule.kind === 'per_item') {
		const { quantity } = rule
		return tx(msg`${scope}: the first ${quantity} on each item`)
	}
	if (rule.kind === 'exact') {
		const { quantity } = rule
		return tx(msg`${scope}: every group of ${quantity}`)
	}
	if (rule.kind === 'minimum') {
		const { quantity } = rule
		return tx(msg`${scope}: when buying ${quantity} or more`)
	}
	return scope
}

/** Monday first, matching the weeks the per-customer limits use. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

export function weekdayLabel(
	day: number,
	locale: string,
	width: 'short' | 'long' = 'short',
): string {
	// 2024-01-07 was a Sunday.
	const date = new Date(Date.UTC(2024, 0, 7 + day))
	try {
		return new Intl.DateTimeFormat(locale, {
			weekday: width,
			timeZone: 'UTC',
		}).format(date)
	} catch {
		return String(day)
	}
}

function dayRuns(days: readonly number[]): number[][] {
	const present = new Set(days)
	const runs: number[][] = []
	let current: number[] = []
	for (const day of WEEK_ORDER) {
		if (present.has(day)) {
			current.push(day)
		} else if (current.length > 0) {
			runs.push(current)
			current = []
		}
	}
	if (current.length > 0) runs.push(current)
	return runs
}

function dayRangeText(run: readonly number[], locale: string): string {
	const first = weekdayLabel(run[0]!, locale)
	if (run.length >= 3) {
		return `${first}–${weekdayLabel(run[run.length - 1]!, locale)}`
	}
	return listText(
		run.map((day) => weekdayLabel(day, locale)),
		locale,
	)
}

/** "Mon–Fri 11:00–14:00; Sat 12:00–16:00", or null for no weekly hours. */
export function scheduleSummary(
	schedule: DiscountDefinition['schedule'],
	locale: string,
): string | null {
	if (!schedule || schedule.length === 0) return null
	const byHours = new Map<string, number[]>()
	for (const window of schedule) {
		const key = `${window.start}–${window.end}`
		byHours.set(key, [...(byHours.get(key) ?? []), window.day])
	}
	return [...byHours.entries()]
		.map(([hours, days]) =>
			dayRuns(days)
				.map((run) => `${dayRangeText(run, locale)} ${hours}`)
				.join('; '),
		)
		.join('; ')
}

/** A local date-time with its time, so "ends at midnight" is not read as a day. */
function localDateText(value: string, locale: string): string {
	const [year, month, day] = value.slice(0, 10).split('-').map(Number)
	const [hours, minutes] = value.slice(11, 16).split(':').map(Number)
	const hasTime = value.length >= 16
	const date = new Date(
		Date.UTC(
			year!,
			month! - 1,
			day!,
			hasTime ? (hours ?? 0) : 0,
			hasTime ? (minutes ?? 0) : 0,
		),
	)
	try {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			...(hasTime ? { timeStyle: 'short' as const } : {}),
			timeZone: 'UTC',
		}).format(date)
	} catch {
		return value.replace('T', ' ')
	}
}

/** "Always", "Mon–Fri 11:00–14:00", "From Nov 1, 2026, 10:00 AM to Nov 30, 2026, 12:00 AM". */
export function whenSummary(
	definition: Pick<DiscountDefinition, 'schedule' | 'startsAt' | 'endsAt'>,
	tx: Translate,
	locale: string,
): string {
	const parts: string[] = []
	const { startsAt, endsAt } = definition
	if (startsAt && endsAt) {
		const from = localDateText(startsAt, locale)
		const until = localDateText(endsAt, locale)
		parts.push(tx(msg`${from} until ${until}`))
	} else if (startsAt) {
		const from = localDateText(startsAt, locale)
		parts.push(tx(msg`From ${from}`))
	} else if (endsAt) {
		const until = localDateText(endsAt, locale)
		parts.push(tx(msg`Until ${until}`))
	}
	const hours = scheduleSummary(definition.schedule, locale)
	if (hours) parts.push(hours)
	// A typographic separator, not a list: the parts hold commas of their own.
	return parts.length > 0 ? parts.join(' · ') : tx(msg`Always`)
}

/**
 * "1 use per customer in total", "2 uses per customer per day". One message
 * for each period, so a translation can order the words as its language needs.
 */
export function perCustomerSummary(
	limit: { count: number; period: DiscountLimitPeriod },
	tx: Translate,
): string {
	const { count } = limit
	if (limit.period === 'day') {
		return tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(count, { one: '# use per customer per day', other: '# uses per customer per day' })}`,
		)
	}
	if (limit.period === 'week') {
		return tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(count, { one: '# use per customer per week', other: '# uses per customer per week' })}`,
		)
	}
	return tx(
		// eslint-disable-next-line lingui/no-single-variables-to-translate
		msg`${plural(count, { one: '# use per customer in total', other: '# uses per customer in total' })}`,
	)
}

/**
 * Screen reader announcements for the editors' add and remove buttons. The
 * count is a plural, so one code or tier never reads "1 codes".
 */
export const ANNOUNCE = {
	codeAdded: (total: number, tx: Translate) =>
		tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(total, { one: 'Code added. # code.', other: 'Code added. # codes.' })}`,
		),
	codeRemoved: (left: number, tx: Translate) =>
		tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(left, { one: 'Code removed. # code left.', other: 'Code removed. # codes left.' })}`,
		),
	singleUseAdded: (made: number, total: number, tx: Translate) => {
		const added = tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(made, { one: '# single-use code added.', other: '# single-use codes added.' })}`,
		)
		const all = tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(total, { one: '# code in all.', other: '# codes in all.' })}`,
		)
		return `${added} ${all}`
	},
	tierAdded: (total: number, tx: Translate) =>
		tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(total, { one: 'Tier added. # tier.', other: 'Tier added. # tiers.' })}`,
		),
	tierRemoved: (total: number, tx: Translate) =>
		tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(total, { one: 'Tier removed. # tier.', other: 'Tier removed. # tiers.' })}`,
		),
	groupAdded: (total: number, tx: Translate) =>
		tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(total, { one: 'Group added. # group.', other: 'Group added. # groups.' })}`,
		),
	groupRemoved: (total: number, tx: Translate) =>
		tx(
			// eslint-disable-next-line lingui/no-single-variables-to-translate
			msg`${plural(total, { one: 'Group removed. # group.', other: 'Group removed. # groups.' })}`,
		),
}
