import { type I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'

import { buildSavedAddressLabels } from '~/lib/ordering-labels'

/**
 * Words for the guest account pages added with saved addresses (#113) and
 * favorite dishes (#158). Built in frontmatter and handed to the browser as
 * JSON, like every other Sites page.
 */

export function buildAddressesPageLabels(i18n: I18n) {
	return {
		...buildSavedAddressLabels(i18n),
		title: i18n._(msg`Addresses`),
		description: i18n._(
			msg`Where you like your delivery brought. Each address is checked against the delivery area every time you order.`,
		),
		empty: i18n._(msg`No saved addresses yet.`),
		emptyHint: i18n._(
			msg`Add one below, or save one while you check out for delivery.`,
		),
		add: i18n._(msg`Add an address`),
		searchPlaceholder: i18n._(msg`Search street address`),
		unitLabel: i18n._(msg`Apt, suite or floor`),
		check: i18n._(msg`Check address`),
		checking: i18n._(msg`Checking…`),
		suggestions: i18n._(msg`Address suggestions`),
		cantSave: i18n._(
			msg`We don't deliver to this address yet, so it can't be saved.`,
		),
		addressNotFound: i18n._(msg`We couldn't find that address.`),
		edit: i18n._(msg`Edit`),
		remove: i18n._(msg`Remove`),
		removeConfirm: i18n._(msg`Remove this address?`),
		makeDefault: i18n._(msg`Make default`),
		cancel: i18n._(msg`Cancel`),
		saveChanges: i18n._(msg`Save changes`),
		loadError: i18n._(msg`We couldn't load your addresses.`),
		retry: i18n._(msg`Try again`),
		signIn: i18n._(msg`Sign in to see your saved addresses.`),
		signInLink: i18n._(msg`Sign in`),
	}
}
export type AddressesPageLabels = ReturnType<typeof buildAddressesPageLabels>

/** The heart on dishes and the "Your favorites" row (#158). */
export function buildFavoritesLabels(i18n: I18n) {
	return {
		title: i18n._(msg`Favorites`),
		description: i18n._(msg`Dishes you love, saved to this account.`),
		row: i18n._(msg`Your favorites`),
		add: i18n._(msg`Add to favorites`),
		remove: i18n._(msg`Remove from favorites`),
		signInToSave: i18n._(msg`Sign in to save your favorite dishes.`),
		soldOut: i18n._(msg`Sold out`),
		empty: i18n._(msg`No favorites yet.`),
		emptyHint: i18n._(msg`Tap the heart on a dish to keep it here.`),
		browseMenu: i18n._(msg`Browse the menu`),
		limitReached: i18n._(
			msg`You have 100 favorites. Remove one to add another.`,
		),
		failed: i18n._(msg`We couldn't update your favorites. Try again.`),
		loadError: i18n._(msg`We couldn't load your favorites.`),
		retry: i18n._(msg`Try again`),
		signIn: i18n._(msg`Sign in to see your favorites.`),
		signInLink: i18n._(msg`Sign in`),
		previous: i18n._(msg`Previous`),
		next: i18n._(msg`Next`),
	}
}
export type FavoritesLabels = ReturnType<typeof buildFavoritesLabels>
