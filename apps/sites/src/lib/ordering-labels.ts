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
		addToOrder: i18n._(msg`Add to order`),
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
		customizeItem: i18n._(msg`Customize item`),
		itemsCount: keep(i18n, msg`{count} items`, 'count'),
		exploreMenu: i18n._(msg`Explore menu`),
	}
}

/** Interface strings for `<OrderDetailsSheet>` and the checkout delivery step. */
export function buildOrderDetailsLabels(i18n: I18n) {
	return {
		title: i18n._(msg`Order details`),
		close: i18n._(msg`Close`),
		orderType: i18n._(msg`Order type`),
		pickup: i18n._(msg`Pickup`),
		delivery: i18n._(msg`Delivery`),
		addressLabel: i18n._(msg`Delivery address`),
		addressPlaceholder: i18n._(msg`Search street address`),
		clearAddress: i18n._(msg`Clear address`),
		suggestions: i18n._(msg`Address suggestions`),
		keepTyping: i18n._(msg`Keep typing to see matching addresses.`),
		noMatches: i18n._(msg`No matching addresses`),
		noMatchesHint: i18n._(
			msg`Check the spelling, or try just the street number and name.`,
		),
		useTyped: keep(i18n, msg`Use “{query}”`, 'query'),
		suggestionsError: i18n._(msg`We couldn't load address suggestions.`),
		retry: i18n._(msg`Try again`),
		unitLabel: i18n._(msg`Apt, suite or floor`),
		optional: i18n._(msg`Optional`),
		checking: i18n._(msg`Checking delivery to this address…`),
		deliverableTitle: i18n._(msg`We deliver here`),
		deliveryFee: i18n._(msg`Delivery fee`),
		minimumOrder: i18n._(msg`Minimum order`),
		noMinimum: i18n._(msg`No minimum`),
		free: i18n._(msg`Free`),
		estimatedTime: i18n._(msg`Estimated time`),
		minutesRange: keep(i18n, msg`{min}–{max} min`, 'min', 'max'),
		minutes: keep(i18n, msg`{count} min`, 'count'),
		outOfRangeTitle: i18n._(msg`We don't deliver to this address yet`),
		outOfRangeBody: keep(
			i18n,
			msg`It's outside the delivery area for {location}. You can still order for pickup.`,
			'location',
		),
		switchToPickup: i18n._(msg`Switch to pickup`),
		tryAnotherAddress: i18n._(msg`Try another address`),
		notFoundTitle: i18n._(msg`We couldn't find that address`),
		notFoundBody: i18n._(
			msg`Check the street number and spelling, or choose a suggestion from the list.`,
		),
		unavailableTitle: i18n._(msg`Delivery isn't available right now`),
		unavailableBody: i18n._(msg`You can still order for pickup.`),
		quoteErrorTitle: i18n._(msg`We couldn't check this address`),
		quoteErrorBody: i18n._(msg`Check your connection and try again.`),
		pickupFrom: i18n._(msg`Pick up from`),
		openNow: i18n._(msg`Open now`),
		openUntil: keep(i18n, msg`Open until {time}`, 'time'),
		closed: i18n._(msg`Closed`),
		opensAt: keep(i18n, msg`Opens {time}`, 'time'),
		readyIn: keep(i18n, msg`Ready in about {count} min`, 'count'),
		when: i18n._(msg`When`),
		asap: i18n._(msg`ASAP`),
		schedule: i18n._(msg`Schedule`),
		asapPickup: keep(i18n, msg`Ready in about {count} min`, 'count'),
		asapDelivery: keep(i18n, msg`Arrives in {min}–{max} min`, 'min', 'max'),
		asapClosed: i18n._(msg`Closed now. Schedule your order for later.`),
		today: i18n._(msg`Today`),
		tomorrow: i18n._(msg`Tomorrow`),
		chooseDay: i18n._(msg`Choose a day`),
		chooseTime: i18n._(msg`Choose a time`),
		noScheduleTimes: i18n._(msg`No scheduled times are available right now.`),
		save: i18n._(msg`Save`),
		deliverHere: i18n._(msg`Deliver here`),
		needAddress: i18n._(msg`Enter a delivery address to continue.`),
		needTime: i18n._(msg`Choose a time to continue.`),
		change: i18n._(msg`Change`),
		addAddress: i18n._(msg`Add delivery address`),
		addressMissingTitle: i18n._(msg`Where should we deliver?`),
		addressMissingBody: i18n._(
			msg`We'll check that your address is in our delivery area before you order.`,
		),
		blockNoQuote: i18n._(
			msg`Add a delivery address we deliver to before placing your order.`,
		),
		blockMinimum: keep(
			i18n,
			msg`Add {amount} more to reach the {minimum} delivery minimum.`,
			'amount',
			'minimum',
		),
		feeAfterAddress: i18n._(msg`After address`),
		scheduleExpired: i18n._(
			msg`Your scheduled time is no longer available. Choose a new time.`,
		),
		deliveryNotAvailable: i18n._(msg`Not available right now`),
		quoteExpired: i18n._(
			msg`Your delivery check expired. Confirm your address again.`,
		),
	}
}

export type OrderDetailsLabels = ReturnType<typeof buildOrderDetailsLabels>
