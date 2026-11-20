import {
	bannerDecision,
	IN_APP_PARAM,
	INVITE_STORAGE,
	platformFromUserAgent,
} from './app-invite'

/**
 * Runs in the visitor's browser: counts the visit, notes an order, and shows
 * the banner when the rules allow. Storage can be blocked (private windows):
 * everything is wrapped, and the banner simply stays hidden then.
 */

function read(storage: Storage | undefined, key: string): string | null {
	try {
		return storage?.getItem(key) ?? null
	} catch {
		return null
	}
}

function write(storage: Storage | undefined, key: string, value: string) {
	try {
		storage?.setItem(key, value)
	} catch {
		// Blocked storage: nothing to remember.
	}
}

export function runAppInviteBanner(root: HTMLElement, win: Window = window) {
	const local = (() => {
		try {
			return win.localStorage
		} catch {
			return undefined
		}
	})()
	const session = (() => {
		try {
			return win.sessionStorage
		} catch {
			return undefined
		}
	})()

	// The app opens site pages with ?inapp=1: remember it for this session.
	const url = new URL(win.location.href)
	if (url.searchParams.get(IN_APP_PARAM) === '1') {
		write(session, INVITE_STORAGE.inApp, '1')
	}
	const inApp =
		read(session, INVITE_STORAGE.inApp) === '1' ||
		/MenuzaCustomerApp/i.test(win.navigator.userAgent)

	// A visit is a browsing session: a reload or another page is not a new one.
	if (read(session, INVITE_STORAGE.sessionCounted) !== '1') {
		write(session, INVITE_STORAGE.sessionCounted, '1')
		const visits = Number(read(local, INVITE_STORAGE.visits) ?? '0') || 0
		write(local, INVITE_STORAGE.visits, String(visits + 1))
	}

	// An order was placed: the confirmation page carries its id in the URL.
	if (
		/\/menu\/success\/?$/.test(url.pathname) &&
		url.searchParams.get('order')
	) {
		write(local, INVITE_STORAGE.ordered, '1')
	}

	const decision = bannerDecision({
		now: Date.now(),
		platform: platformFromUserAgent(win.navigator.userAgent),
		enabled: true,
		stores: {
			ios: root.dataset.iosHref || undefined,
			android: root.dataset.androidHref || undefined,
		},
		inApp,
		pathname: url.pathname,
		dismissedAt: Number(read(local, INVITE_STORAGE.dismissedAt)) || null,
		visits: Number(read(local, INVITE_STORAGE.visits) ?? '0') || 0,
		ordered: read(local, INVITE_STORAGE.ordered) === '1',
	})
	if (!decision.show) return decision

	const link = root.querySelector<HTMLAnchorElement>('[data-app-invite-link]')
	if (link) {
		link.href =
			(decision.platform === 'ios'
				? root.dataset.iosHref
				: root.dataset.androidHref) ?? '#'
	}
	root.hidden = false
	root
		.querySelector<HTMLButtonElement>('[data-app-invite-dismiss]')
		?.addEventListener('click', () => {
			write(local, INVITE_STORAGE.dismissedAt, String(Date.now()))
			root.hidden = true
		})
	return decision
}
