import { type InvitePlacement } from '@repo/common/customer-app'
import { type PublicCustomerApp } from '~/lib/customer-app-types'
import { storeTapPath } from './app-invite'

export type PlacementStore = {
	store: 'app_store' | 'play_store'
	/** The site's own tap-counting redirect, never the store link itself. */
	href: string
}

/**
 * What a "Get the app" placement shows, from the published site settings: only
 * stores that are live, each with the counted-tap address. An empty list means
 * nothing renders: the app has no live store, or the owner switched the
 * placement off (#196).
 */
export function placementStores(
	app: PublicCustomerApp | null | undefined,
	placement: InvitePlacement,
	localePrefix = '',
): PlacementStore[] {
	if (!app) return []
	const on =
		placement === 'banner'
			? app.invite.banner
			: placement === 'confirmation' || placement === 'email'
				? app.invite.confirmation
				: placement === 'footer'
					? app.invite.footer
					: true // the builder block follows the page that holds it
	if (!on) return []
	const out: PlacementStore[] = []
	if (app.stores.app_store) {
		out.push({
			store: 'app_store',
			href: storeTapPath('app_store', placement, localePrefix),
		})
	}
	if (app.stores.play_store) {
		out.push({
			store: 'play_store',
			href: storeTapPath('play_store', placement, localePrefix),
		})
	}
	return out
}
