import {
	allowedTags,
	isGlobalPrivacyControl,
	readConsentChoice,
	resolveConsent,
	TAG_CATEGORY,
	type ConsentCategories,
	type ConsentMode,
	type SiteTagIds,
} from '@repo/common/site-consent'

/** The page's own consent event: the banner fires it after every choice. */
export const SITE_CONSENT_EVENT = 'site-consent-change'

type Fbq = ((...args: unknown[]) => void) & {
	callMethod?: (...args: unknown[]) => void
	queue: unknown[]
	loaded: boolean
	version: string
	push: Fbq
}

type TikTokQueue = {
	methods: string[]
	setAndDefer: (target: TikTokQueue, method: string) => void
	instance: (id: string) => TikTokQueue
	load: (id: string, options?: { partner?: string }) => void
	page: () => void
	holdConsent?: () => void
	grantConsent?: () => void
	revokeConsent?: () => void
	_i: Record<string, TikTokQueue & { _u?: string }>
	_t: Record<string, number>
	_o: Record<string, unknown>
	push: (args: unknown[]) => void
}

type PixelWindow = Window &
	typeof globalThis & {
		fbq?: Fbq
		_fbq?: Fbq
		dataLayer?: unknown[]
		gtag?: (...args: unknown[]) => void
		TiktokAnalyticsObject?: string
		ttq?: TikTokQueue
	}

/** What the vendors need from the page, so tests can fake it. */
export type PixelEnv = {
	window: PixelWindow
	storage: Pick<Storage, 'getItem'> | null
	now: () => number
	gpc: boolean
}

function browserEnv(): PixelEnv {
	const host = globalThis as typeof globalThis & { window?: PixelWindow }
	const w = (host.window ?? host) as PixelWindow
	let storage: Storage | null = null
	try {
		storage = w.localStorage ?? null
	} catch {
		storage = null
	}
	return {
		window: w,
		storage,
		now: () => Date.now(),
		gpc: isGlobalPrivacyControl(
			w.navigator as { globalPrivacyControl?: unknown },
		),
	}
}

function addScript(env: PixelEnv, src: string, before = false) {
	const doc = env.window.document
	const script = doc.createElement('script')
	script.async = true
	script.src = src
	const first = before ? doc.getElementsByTagName('script')[0] : null
	if (first?.parentNode) first.parentNode.insertBefore(script, first)
	else doc.head.appendChild(script)
}

function gtag(env: PixelEnv, ...args: unknown[]) {
	const w = env.window
	w.dataLayer = w.dataLayer || []
	// gtag.js reads the `arguments` object, not an array.
	if (!w.gtag) {
		w.gtag = function () {
			// eslint-disable-next-line prefer-rest-params
			w.dataLayer!.push(arguments)
		}
	}
	w.gtag(...args)
}

function googleConsent(categories: ConsentCategories) {
	return {
		analytics_storage: categories.analytics ? 'granted' : 'denied',
		ad_storage: categories.marketing ? 'granted' : 'denied',
		ad_user_data: categories.marketing ? 'granted' : 'denied',
		ad_personalization: categories.marketing ? 'granted' : 'denied',
	}
}

/** Google Consent Mode v2: everything denied by default, then updated. */
function googleDefaultDenied(env: PixelEnv) {
	gtag(env, 'consent', 'default', {
		...googleConsent({ analytics: false, marketing: false }),
		wait_for_update: 500,
	})
}

function bootFacebook(env: PixelEnv, pixelId: string, granted: boolean) {
	const w = env.window
	if (!w.fbq) {
		const fbq = function (this: Fbq, ...args: unknown[]) {
			if (fbq.callMethod) fbq.callMethod.apply(fbq, args)
			else fbq.queue.push(args)
		} as Fbq
		fbq.queue = []
		fbq.loaded = true
		fbq.version = '2.0'
		fbq.push = fbq
		w.fbq = fbq
		w._fbq = fbq
		addScript(env, 'https://connect.facebook.net/en_US/fbevents.js')
	}
	// Consent first, then init: Meta holds events until the grant.
	w.fbq('consent', granted ? 'grant' : 'revoke')
	w.fbq('init', pixelId)
	w.fbq('track', 'PageView')
}

function bootTikTok(env: PixelEnv, pixelId: string, granted: boolean) {
	const w = env.window
	w.TiktokAnalyticsObject = 'ttq'
	// The vendor snippet queues on an array so events.js can replay `push`.
	const ttq = (w.ttq = w.ttq || ([] as unknown as TikTokQueue))
	ttq.methods = [
		'page',
		'track',
		'identify',
		'instances',
		'debug',
		'on',
		'off',
		'once',
		'ready',
		'alias',
		'group',
		'enableCookie',
		'disableCookie',
		'holdConsent',
		'revokeConsent',
		'grantConsent',
	]
	ttq.setAndDefer = (target, method) => {
		;(target as unknown as Record<string, (...args: unknown[]) => void>)[
			method
		] = (...args: unknown[]) => {
			target.push([method, ...args])
		}
	}
	for (const method of ttq.methods) ttq.setAndDefer(ttq, method)
	ttq.instance = (id) => {
		const instances = (ttq._i = ttq._i || {})
		const queue = instances[id] || ([] as unknown as TikTokQueue)
		for (const method of ttq.methods) ttq.setAndDefer(queue, method)
		return queue
	}
	ttq.load = (id, options) => {
		const src = 'https://analytics.tiktok.com/i18n/pixel/events.js'
		ttq._i = ttq._i || {}
		const queue = [] as unknown as TikTokQueue & { _u?: string }
		queue._u = src
		ttq._i[id] = queue
		ttq._t = ttq._t || {}
		ttq._t[id] = Date.now()
		ttq._o = ttq._o || {}
		ttq._o[id] = options || {}
		addScript(env, `${src}?sdkid=${encodeURIComponent(id)}&lib=ttq`, true)
	}
	// Hold everything until the guest has agreed.
	ttq.holdConsent?.()
	ttq.load(pixelId)
	ttq.page()
	if (granted) ttq.grantConsent?.()
}

function bootGoogleAnalytics(env: PixelEnv, measurementId: string) {
	gtag(env, 'js', new Date())
	gtag(env, 'config', measurementId)
	addScript(
		env,
		`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`,
	)
}

function bootTagManager(env: PixelEnv, containerId: string) {
	const w = env.window
	w.dataLayer = w.dataLayer || []
	w.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' })
	addScript(
		env,
		`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`,
	)
}

const PATTERNS = {
	facebook: /^\d{5,20}$/,
	tiktok: /^[A-Z0-9]{10,30}$/,
	googleTagManager: /^GTM-[A-Z0-9]+$/,
	googleAnalytics: /^G-[A-Z0-9]+$/,
} as const

/** The tag ids on the page, each only if it has the right shape. */
export function readTagIds(root: HTMLElement): SiteTagIds {
	const pick = (value: string | undefined, key: keyof typeof PATTERNS) =>
		value && PATTERNS[key].test(value) ? value : null
	return {
		facebook: pick(root.dataset.facebookPixel, 'facebook'),
		tiktok: pick(root.dataset.tiktokPixel, 'tiktok'),
		googleTagManager: pick(root.dataset.googleTagManager, 'googleTagManager'),
		googleAnalytics: pick(root.dataset.googleAnalytics, 'googleAnalytics'),
	}
}

function readMode(root: HTMLElement): ConsentMode {
	const mode = root.dataset.consentMode
	return mode === 'required' || mode === 'notice' ? mode : 'off'
}

export type SiteTagController = {
	/** Re-reads the choice and loads or revokes what changed. */
	apply: () => void
	/** The tags booted so far. */
	booted: () => ReadonlySet<keyof SiteTagIds>
}

/**
 * Loads the tracking tags the guest's consent allows (#89), and only those.
 * In Required mode nothing loads before Accept; Notice loads with an opt-out;
 * Off loads everything. Each vendor is booted once, with its consent API:
 * Google Consent Mode v2 (`default` denied, then `update`), TikTok
 * `holdConsent` / `grantConsent` and Meta `fbq('consent', 'revoke' | 'grant')`.
 * A tag that was allowed and is then rejected is revoked with the same APIs.
 * Runs again on every `site-consent-change` the banner fires.
 */
export function startSiteTags(
	root: HTMLElement,
	env: PixelEnv = browserEnv(),
): SiteTagController {
	const ids = readTagIds(root)
	const mode = readMode(root)
	const booted = new Set<keyof SiteTagIds>()
	let googlePrepared = false

	function current() {
		return resolveConsent({
			mode,
			choice: readConsentChoice(env.storage, env.now()),
			gpc: env.gpc,
			tags: ids,
		})
	}

	function apply() {
		const state = current()
		const allowed = new Set(allowedTags(state, ids))
		const wantsGoogle = ids.googleAnalytics || ids.googleTagManager
		if (wantsGoogle && !googlePrepared) {
			googleDefaultDenied(env)
			googlePrepared = true
		}
		for (const key of Object.keys(TAG_CATEGORY) as Array<keyof SiteTagIds>) {
			const id = ids[key]
			if (!id) continue
			if (allowed.has(key) && !booted.has(key)) {
				booted.add(key)
				if (key === 'facebook') bootFacebook(env, id, true)
				else if (key === 'tiktok') bootTikTok(env, id, true)
				else if (key === 'googleAnalytics') bootGoogleAnalytics(env, id)
				else bootTagManager(env, id)
			} else if (!allowed.has(key) && booted.has(key)) {
				// Allowed before, rejected now: tell the vendor.
				if (key === 'facebook') env.window.fbq?.('consent', 'revoke')
				else if (key === 'tiktok') env.window.ttq?.revokeConsent?.()
			}
		}
		if (booted.has('googleAnalytics') || booted.has('googleTagManager')) {
			gtag(env, 'consent', 'update', googleConsent(state))
		}
	}

	apply()
	env.window.addEventListener?.(SITE_CONSENT_EVENT, apply)
	return { apply, booted: () => booted }
}

/** Loads pixels from data attributes. The script itself is bundled. */
export function bootSitePixels(root: HTMLElement) {
	return startSiteTags(root)
}
