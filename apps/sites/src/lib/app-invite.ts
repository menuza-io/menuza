import { INVITE_BANNER_DISMISS_DAYS } from '@repo/common/customer-app'
import { buildLinkPath } from '@repo/common/links'

/**
 * When the phone "Get the app" banner shows (#196). Pure, so the rules are
 * tested without a browser. The banner is decided in the visitor's browser
 * (the page itself is cached), from state that never leaves it: how many times
 * they visited, whether they placed an order, and when they dismissed it.
 * Nothing about it is sent anywhere, and no visitor id exists.
 */

export const INVITE_STORAGE = {
	dismissedAt: 'menuza:app-invite:dismissed-at',
	visits: 'menuza:app-invite:visits',
	ordered: 'menuza:app-invite:ordered',
	/** Set for the session when the site is open inside the app's own browser. */
	inApp: 'menuza:app-invite:in-app',
	/** The visit of this session was already counted. */
	sessionCounted: 'menuza:app-invite:session-counted',
} as const

/** The query parameter the customer app adds to the site pages it opens. */
export const IN_APP_PARAM = 'inapp'

const DAY_MS = 24 * 60 * 60 * 1000

export type InvitePlatform = 'ios' | 'android' | 'other'

export function platformFromUserAgent(userAgent: string): InvitePlatform {
	if (/iPhone|iPod|iPad/i.test(userAgent)) return 'ios'
	if (/Android/i.test(userAgent)) return 'android'
	return 'other'
}

/** Pages whose buttons the banner must never sit near: the cart and the checkout. */
export function isCartOrCheckoutPath(pathname: string): boolean {
	return /(^|\/)menu\/(checkout|payment|pay)(\/|$)/.test(pathname)
}

export type BannerInput = {
	now: number
	platform: InvitePlatform
	/** The owner's switch for the banner. */
	enabled: boolean
	/** Store links of the stores that are live. */
	stores: { ios?: string; android?: string }
	/** Open inside the app's own web view (or the in-app browser it launches). */
	inApp: boolean
	pathname: string
	/** `Date.now()` of the dismissal on this device, or null. */
	dismissedAt: number | null
	/** Visits counted on this device, this one included. */
	visits: number
	/** The visitor placed an order from this device. */
	ordered: boolean
}

export type BannerDecision =
	| { show: true; platform: 'ios' | 'android' }
	| {
			show: false
			reason:
				| 'off'
				| 'not_a_phone'
				| 'no_live_store'
				| 'in_app'
				| 'cart_or_checkout'
				| 'dismissed'
				| 'too_early'
	  }

/**
 * Shown on a phone, once the first order was placed or on the second visit;
 * dismissed for 30 days on that device; never on the cart or checkout, never
 * inside the app, and only for a store that is live.
 */
export function bannerDecision(input: BannerInput): BannerDecision {
	if (!input.enabled) return { show: false, reason: 'off' }
	if (input.platform === 'other') return { show: false, reason: 'not_a_phone' }
	if (!input.stores[input.platform])
		return { show: false, reason: 'no_live_store' }
	if (input.inApp) return { show: false, reason: 'in_app' }
	if (isCartOrCheckoutPath(input.pathname)) {
		return { show: false, reason: 'cart_or_checkout' }
	}
	if (
		input.dismissedAt !== null &&
		input.now - input.dismissedAt < INVITE_BANNER_DISMISS_DAYS * DAY_MS
	) {
		return { show: false, reason: 'dismissed' }
	}
	if (!input.ordered && input.visits < 2) {
		return { show: false, reason: 'too_early' }
	}
	return { show: true, platform: input.platform }
}

export type StoreKey = 'app_store' | 'play_store'

export function storeForPlatform(platform: 'ios' | 'android'): StoreKey {
	return platform === 'ios' ? 'app_store' : 'play_store'
}

/**
 * The address of a tap: the site's own `/get-app` redirect counts the tap per
 * placement and sends the visitor to the store link. The store link itself is
 * never put in a query, so the redirect cannot be bent into an open redirect.
 */
export function storeTapPath(
	store: StoreKey,
	placement: string,
	localePrefix = '',
): string {
	return `${localePrefix}${buildLinkPath('get_app', { store, p: placement })}`
}

/** The text of the default banner when the owner wrote none. */
export const DEFAULT_BANNER_FALLBACK = 'Get our app for faster ordering'
