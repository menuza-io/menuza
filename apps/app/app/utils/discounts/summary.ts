import { msg, plural } from '@lingui/core/macro'
import { type LoyaltyCatalog } from '#app/utils/loyalty/catalog.ts'
import { parsePercentToBp } from '#app/utils/loyalty/loyalty-view.ts'
import { parseMoneyToMinor } from '#app/utils/money-input.ts'
import {
	ALL_CHANNELS,
	ALL_FULFILLMENTS,
	tiersApply,
	type DiscountChoiceCatalog,
	type EditorState,
	type ItemGroupState,
} from './editor-model.ts'
import {
	amountEach,
	DISCOUNT_APPLICATION_LABELS,
	DISCOUNT_CHANNEL_LABELS,
	DISCOUNT_COMBINE_LABELS,
	DISCOUNT_ELIGIBILITY_LABELS,
	DISCOUNT_FULFILLMENT_LABELS,
	DISCOUNT_VALUE_TYPE_LABELS,
	formatMoney,
	listText,
	numberText,
	perCustomerSummary,
	type Translate,
	valueSummary,
	whenSummary,
} from './labels.ts'

/**
 * The discount in plain words, read from the form as it stands. It works from
 * raw field values rather than a validated definition, so it describes a
 * half-finished discount instead of waiting for the form to be valid.
 */

export type SummaryRow = { key: string; label: string; value: string }

export type DiscountSummary = {
	title: string
	headline: string
	rows: SummaryRow[]
}

type Named = { id: string; name: string }

const NAMES_SHOWN = 3

/** "Pizza, Wings, Salad +2". Ids the menu no longer has are left out. */
export function nameList(
	ids: readonly string[],
	options: readonly Named[],
	locale = 'en',
): string {
	const byId = new Map(options.map((option) => [option.id, option.name]))
	const names = ids.flatMap((id) => {
		const name = byId.get(id)
		return name ? [name] : []
	})
	if (names.length <= NAMES_SHOWN) return listText(names, locale)
	const more = numberText(names.length - NAMES_SHOWN, locale)
	return `${listText(names.slice(0, NAMES_SHOWN), locale)} +${more}`
}

/** "Pizzas (Large)": what a group covers, with the sizes it is limited to. */
function withSizes(
	text: string,
	sizes: readonly string[],
	locale: string,
): string {
	return sizes.length > 0 ? `${text} (${listText(sizes, locale)})` : text
}

function groupNames(
	group: ItemGroupState,
	catalog: LoyaltyCatalog,
	locale: string,
): string {
	const names = listText(
		[
			nameList(group.itemIds, catalog.items, locale),
			nameList(group.categoryIds, catalog.categories, locale),
		].filter(Boolean),
		locale,
	)
	return names ? withSizes(names, group.variantNames, locale) : ''
}

function groupText(
	group: ItemGroupState,
	catalog: LoyaltyCatalog,
	locale: string,
): string | null {
	const names = groupNames(group, catalog, locale)
	if (!names) return null
	const quantity = Number(group.quantity)
	return Number.isInteger(quantity) && quantity > 1
		? `${quantity} × ${names}`
		: names
}

export function buildDiscountSummary({
	state,
	currency,
	locale,
	catalog,
	choices,
	locations,
	tx,
}: {
	state: EditorState
	currency: string
	locale: string
	catalog: LoyaltyCatalog
	choices: DiscountChoiceCatalog
	locations: readonly Named[]
	tx: Translate
}): DiscountSummary {
	const rows: SummaryRow[] = []
	const add = (key: string, label: string, value: string | null) => {
		if (value) rows.push({ key, label, value })
	}

	// What it takes off, as far as the fields can be read.
	const percentBp = parsePercentToBp(state.percent)
	const amountMinor = parseMoneyToMinor(state.amount, { currency, min: 1 })
	const maxMinor = state.maxDiscount.trim()
		? parseMoneyToMinor(state.maxDiscount, { currency, min: 1 })
		: null
	const readable =
		state.valueType === 'free_delivery' ||
		(state.valueType === 'percent' && percentBp !== null) ||
		((state.valueType === 'fixed' || state.valueType === 'fixed_price') &&
			amountMinor !== null)
	const tiered = tiersApply(state)
	// A fixed amount comes off each matching item on an item discount.
	const each = amountEach(
		state.valueType === 'free_delivery' ? 'order' : state.scope,
		state.valueType === 'free_delivery' ? 'none' : state.quantityKind,
	)
	const plainHeadline = readable
		? valueSummary(
				{
					valueType: state.valueType,
					percentBp: state.valueType === 'percent' ? percentBp : null,
					amountMinor:
						state.valueType === 'fixed' || state.valueType === 'fixed_price'
							? amountMinor
							: null,
					currency,
					maxDiscountMinor: state.valueType === 'percent' ? maxMinor : null,
				},
				tx,
				locale,
				currency,
				each,
			)
		: tx(DISCOUNT_VALUE_TYPE_LABELS[state.valueType])

	const headline = tiered ? tx(msg`Tiered discount`) : plainHeadline

	const codes = state.codes.map((row) => row.code.trim()).filter(Boolean)
	const how = tx(DISCOUNT_APPLICATION_LABELS[state.application])
	add(
		'how',
		tx(msg`How it applies`),
		state.application === 'code' && codes.length > 0
			? listText(
					[
						how,
						`${codes[0]}${codes.length > 1 ? ` +${numberText(codes.length - 1, locale)}` : ''}`,
					],
					locale,
				)
			: how,
	)

	// The items it covers.
	const freeDelivery = state.valueType === 'free_delivery'
	const setRule =
		!freeDelivery &&
		(state.quantityKind === 'buy_get' || state.quantityKind === 'bundle')
	let covers: string | null = null
	if (freeDelivery) {
		covers = tx(msg`Delivery fee`)
	} else if (state.quantityKind === 'buy_get') {
		const get = groupText(state.getGroup, catalog, locale)
		if (state.buyGroup.by === 'spend') {
			const names = groupNames(state.buyGroup, catalog, locale)
			const spend = parseMoneyToMinor(state.buyGroup.spend, {
				currency,
				min: 1,
			})
			if (names && get && spend !== null) {
				const amount = formatMoney(spend, currency, locale)
				covers = tx(msg`Spend ${amount} on ${names}, get ${get}`)
			}
		} else {
			const buy = groupText(state.buyGroup, catalog, locale)
			if (buy && get) covers = tx(msg`Buy ${buy}, get ${get}`)
		}
	} else if (state.quantityKind === 'bundle') {
		const parts = state.bundleSlots.flatMap((slot) => {
			const text = groupText(slot, catalog, locale)
			return text ? [text] : []
		})
		if (parts.length > 0) covers = parts.join(' + ')
	} else if (state.scope === 'order') {
		covers = tx(msg`Whole order`)
	} else if (state.scope === 'items') {
		const names = nameList(state.itemIds, catalog.items, locale)
		covers = names ? withSizes(names, state.variantNames, locale) : null
	} else if (state.scope === 'categories') {
		const names = nameList(state.categoryIds, catalog.categories, locale)
		covers = names ? withSizes(names, state.variantNames, locale) : null
	} else {
		const picked = nameList(
			[...state.modifierGroupIds, ...state.modifierOptionIds],
			[...choices.groups, ...choices.options],
			locale,
		)
		const items = listText(
			[
				nameList(state.itemIds, catalog.items, locale),
				nameList(state.categoryIds, catalog.categories, locale),
			].filter(Boolean),
			locale,
		)
		if (picked) {
			const on = withSizes(items, state.variantNames, locale)
			covers = on ? tx(msg`${picked} on ${on}`) : picked
		}
	}
	// Say so while the choice is still empty: that is what is left to do.
	add('covers', tx(msg`Applies to`), covers ?? tx(msg`Nothing chosen yet`))

	// Counted rules read as a sentence; deals already did above.
	if (!freeDelivery) {
		const quantity = Number(state.quantityN)
		const perItem = Number(state.perItemN)
		const buy = Number(state.buyQuantity)
		const get = Number(state.getQuantity)
		let rule: string | null = null
		if (state.quantityKind === 'exact' && quantity > 0) {
			rule = tx(msg`Every group of ${quantity}`)
		} else if (state.quantityKind === 'minimum' && quantity > 0) {
			rule = tx(msg`When buying ${quantity} or more`)
		} else if (state.quantityKind === 'bogo' && buy > 0 && get > 0) {
			rule = tx(msg`Buy ${buy}, get ${get} discounted`)
		} else if (state.quantityKind === 'per_item' && perItem > 0) {
			rule = tx(msg`The first ${perItem} on each item, most expensive first`)
		}
		add('rule', tx(msg`Quantity`), rule)
	}

	if (tiered) {
		const spend = state.tierBasis === 'spend'
		const steps = state.tiers.flatMap((row) => {
			const at = spend
				? parseMoneyToMinor(row.at, { currency, min: 1 })
				: Number(row.at)
			if (at === null || !Number.isInteger(at) || at < 1) return []
			const earned =
				state.valueType === 'percent'
					? parsePercentToBp(row.value)
					: parseMoneyToMinor(row.value, { currency, min: 1 })
			if (earned === null) return []
			const value = valueSummary(
				{
					valueType: state.valueType,
					percentBp: state.valueType === 'percent' ? earned : null,
					amountMinor: state.valueType === 'fixed' ? earned : null,
					currency,
					maxDiscountMinor: null,
				},
				tx,
				locale,
				currency,
				each,
			)
			if (spend) {
				const amount = formatMoney(at, currency, locale)
				return [tx(msg`${amount} or more: ${value}`)]
			}
			return [tx(msg`${at} or more items: ${value}`)]
		})
		add(
			'tiers',
			tx(msg`Tiers`),
			steps.length > 0 ? listText(steps, locale) : null,
		)
		// A cap on a percentage ladder is not in any one step.
		if (state.valueType === 'percent' && maxMinor !== null) {
			add('cap', tx(msg`Maximum off`), formatMoney(maxMinor, currency, locale))
		}
	}

	// Items discounted per use: only an item, category, modifier or deal discount.
	if (!freeDelivery && (state.scope !== 'order' || setRule)) {
		const units = Number(state.maxUnits)
		if (state.maxUnits.trim() && Number.isInteger(units) && units > 0) {
			const cap = tx(
				// eslint-disable-next-line lingui/no-single-variables-to-translate
				msg`${plural(units, { one: 'Up to # item', other: 'Up to # items' })}`,
			)
			add('units', tx(msg`Items discounted per use`), cap)
		}
	}

	// What the order must already hold, and what never gets the discount.
	if (state.requireOn && !freeDelivery) {
		const names = listText(
			[
				nameList(state.requireItemIds, catalog.items, locale),
				nameList(state.requireCategoryIds, catalog.categories, locale),
			].filter(Boolean),
			locale,
		)
		const quantity = Number(state.requireQuantity)
		if (names && Number.isInteger(quantity) && quantity > 0) {
			add(
				'require',
				tx(msg`Order must include`),
				quantity > 1 ? `${quantity} × ${names}` : names,
			)
		}
	}
	if (!freeDelivery) {
		const excluded = listText(
			[
				nameList(state.excludeItemIds, catalog.items, locale),
				nameList(state.excludeCategoryIds, catalog.categories, locale),
			].filter(Boolean),
			locale,
		)
		add('exclude', tx(msg`Never discounted`), excluded || null)
	}

	add(
		'when',
		tx(msg`When`),
		whenSummary(
			{
				schedule:
					state.hoursOn && state.schedule.length > 0 ? state.schedule : null,
				startsAt: state.startsAt || null,
				endsAt: state.endsAt || null,
			},
			tx,
			locale,
		),
	)

	// Where: only what is narrowed. A discount that applies everywhere says so
	// instead of listing every channel and order type.
	const narrowed: string[] = []
	if (!state.allLocations) {
		narrowed.push(
			state.locationIds.length <= NAMES_SHOWN
				? nameList(state.locationIds, locations, locale)
				: (() => {
						const count = state.locationIds.length
						return tx(
							// eslint-disable-next-line lingui/no-single-variables-to-translate
							msg`${plural(count, { one: '# location', other: '# locations' })}`,
						)
					})(),
		)
	}
	if (state.channels.length < ALL_CHANNELS.length) {
		narrowed.push(
			listText(
				state.channels.map((value) => tx(DISCOUNT_CHANNEL_LABELS[value])),
				locale,
			),
		)
	}
	if (state.fulfillments.length < ALL_FULFILLMENTS.length) {
		narrowed.push(
			listText(
				state.fulfillments.map((value) =>
					tx(DISCOUNT_FULFILLMENT_LABELS[value]),
				),
				locale,
			),
		)
	}
	add(
		'where',
		tx(msg`Where`),
		narrowed.length > 0
			? listText(narrowed.filter(Boolean), locale)
			: tx(msg`Everywhere`),
	)
	if (state.includeDrops) {
		add('drops', tx(msg`Drop orders`), tx(msg`Included`))
	}

	// Who, and how often.
	const who = [tx(DISCOUNT_ELIGIBILITY_LABELS[state.eligibility])]
	const totalLimit =
		state.totalLimit === 'custom'
			? Number(state.totalLimitCustom)
			: state.totalLimit === 'unlimited'
				? 0
				: Number(state.totalLimit)
	if (Number.isInteger(totalLimit) && totalLimit > 0) {
		who.push(
			tx(
				// eslint-disable-next-line lingui/no-single-variables-to-translate
				msg`${plural(totalLimit, { one: 'Up to # use', other: 'Up to # uses' })}`,
			),
		)
	}
	const minSpend = state.minSubtotal.trim()
		? parseMoneyToMinor(state.minSubtotal, { currency, min: 1 })
		: null
	if (minSpend !== null) {
		const amount = formatMoney(minSpend, currency, locale)
		who.push(tx(msg`Minimum spend ${amount}`))
	}
	add('who', tx(msg`Who can use it`), listText(who, locale))
	if (state.perCustomerOn) {
		const count = Number(state.perCustomerCount)
		if (Number.isInteger(count) && count > 0) {
			add(
				'perCustomer',
				tx(msg`Per customer`),
				`${perCustomerSummary({ count, period: state.perCustomerPeriod }, tx)}. ${tx(msg`Guests can't use it.`)}`,
			)
		}
	}

	if (state.valueType === 'free_delivery' && state.maxDeliveryFee.trim()) {
		const fee = parseMoneyToMinor(state.maxDeliveryFee, { currency, min: 1 })
		if (fee !== null) {
			const amount = formatMoney(fee, currency, locale)
			add(
				'fee',
				tx(msg`Delivery fee limit`),
				tx(msg`Only when the fee is ${amount} or less`),
			)
		}
	}

	// Say so when nothing is ticked: it is a choice, and it changes the outcome.
	add(
		'combine',
		tx(msg`Combines with`),
		state.combinesWith.length > 0
			? listText(
					state.combinesWith.map((kind) => tx(DISCOUNT_COMBINE_LABELS[kind])),
					locale,
				)
			: tx(msg`Nothing (stands alone)`),
	)

	return {
		title: state.name.trim() || tx(msg`Untitled discount`),
		headline,
		rows,
	}
}
