import { type I18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { type OrderingLabels } from '~/lib/ordering/types.ts'

/** Translates a `msg` descriptor with ICU placeholder values. */
export function translate(
	i18n: I18n,
	descriptor: MessageDescriptor,
	values: Record<string, string | number>,
): string {
	const withValues: MessageDescriptor = { ...descriptor, values }
	// The extractor already collected the `msg` descriptor at the call site.
	return /* lingui-extract-ignore */ i18n._(withValues)
}

/**
 * Translates a template while keeping its `{name}` placeholders intact so the
 * client can fill them later with `fillTemplate`.
 */
function keep(i18n: I18n, descriptor: MessageDescriptor, ...names: string[]) {
	return translate(
		i18n,
		descriptor,
		Object.fromEntries(names.map((name) => [name, `{${name}}`])),
	)
}

/** Interface strings shared by the menu and drop ordering surfaces. */
export function buildOrderingLabels(i18n: I18n): OrderingLabels {
	return {
		addToOrder: i18n._(msg`Add to Order`),
		soldOut: i18n._(msg`Sold out`),
		from: i18n._(msg`From`),
		required: i18n._(msg`Required`),
		optional: i18n._(msg`Optional`),
		done: i18n._(msg`Done`),
		chooseOne: i18n._(msg`Choose 1`),
		chooseN: keep(i18n, msg`Choose {count}`, 'count'),
		chooseAtLeastN: keep(i18n, msg`Choose at least {count}`, 'count'),
		chooseRange: keep(i18n, msg`Choose {min}–{max}`, 'min', 'max'),
		upToN: keep(i18n, msg`Up to {count}`, 'count'),
		chooseAtLeastOne: i18n._(msg`Choose at least 1 option`),
		chooseAtLeastNOptions: keep(
			i18n,
			msg`Choose at least {count} options`,
			'count',
		),
		combinationUnavailable: i18n._(
			msg`This combination is sold out. Choose another combination.`,
		),
		whole: i18n._(msg`Whole`),
		left: i18n._(msg`Left`),
		right: i18n._(msg`Right`),
		none: i18n._(msg`None`),
		quantity: i18n._(msg`Quantity`),
		increase: i18n._(msg`Increase quantity`),
		decrease: i18n._(msg`Decrease quantity`),
		remove: i18n._(msg`Remove`),
		onlyNLeft: keep(i18n, msg`Only {count} left`, 'count'),
		onlyNLeftIn: keep(
			i18n,
			msg`Only {count} left in {category}`,
			'count',
			'category',
		),
		limitNPerOrder: keep(i18n, msg`Limit {count} per order`, 'count'),
		limitReached: i18n._(msg`Limit reached`),
		emptyCartTitle: i18n._(msg`Your cart is empty`),
		emptyCartDesc: i18n._(msg`Explore our menu and add your favorite dishes.`),
		closeDialog: i18n._(msg`Close`),
		customizeItem: i18n._(msg`Customize Item`),
		itemsCount: keep(i18n, msg`{count} items`, 'count'),
	}
}
