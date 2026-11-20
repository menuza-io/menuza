import { z } from 'zod'

/**
 * Promotional popups (#132): the rules both the App (saving, the public
 * payload) and Sites (showing) apply. Pure: no I/O, no clock of its own.
 */

export const SITE_POPUP_TRIGGERS = ['delay', 'scroll', 'exit'] as const
export const SITE_POPUP_FREQUENCIES = [
	'session',
	'day',
	'week',
	'ever',
] as const
export const SITE_POPUP_CAPTURES = ['none', 'email', 'phone'] as const
export const SITE_POPUP_PAGE_KEYS = ['all', 'home', 'menu', 'other'] as const

export type SitePopupTrigger = (typeof SITE_POPUP_TRIGGERS)[number]
export type SitePopupFrequency = (typeof SITE_POPUP_FREQUENCIES)[number]
export type SitePopupCapture = (typeof SITE_POPUP_CAPTURES)[number]
export type SitePopupPageKey = (typeof SITE_POPUP_PAGE_KEYS)[number]

/** The error code a save is refused with when the coupon cannot be used online. */
export const COUPON_NOT_VALID_ONLINE = 'coupon_not_valid_online'

export const SITE_POPUP_DEFAULT_DELAY_SECONDS = 5
export const SITE_POPUP_DEFAULT_SCROLL_PERCENT = 40

export const sitePopupInputSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		// Localized JSON strings (`{"en":"…"}`) like every site text.
		title: z.string().trim().max(600).default(''),
		body: z.string().trim().max(2000).default(''),
		buttonLabel: z.string().trim().max(300).default(''),
		buttonUrl: z.string().trim().max(500).nullable().default(null),
		imageUrl: z.string().trim().max(500).nullable().default(null),
		discountId: z.string().trim().min(1).max(100).nullable().default(null),
		trigger: z.enum(SITE_POPUP_TRIGGERS).default('delay'),
		triggerValue: z.number().int().min(0).max(600).default(5),
		frequency: z.enum(SITE_POPUP_FREQUENCIES).default('day'),
		pages: z.array(z.enum(SITE_POPUP_PAGE_KEYS)).min(1).max(4).default(['all']),
		startsAt: z.string().trim().max(40).nullable().default(null),
		endsAt: z.string().trim().max(40).nullable().default(null),
		captureContact: z.enum(SITE_POPUP_CAPTURES).default('none'),
		consentText: z.string().trim().max(600).default(''),
	})
	.superRefine((value, context) => {
		if (
			value.trigger === 'scroll' &&
			(value.triggerValue < 1 || value.triggerValue > 100)
		) {
			context.addIssue({
				code: 'custom',
				path: ['triggerValue'],
				message: 'Scroll is a percent between 1 and 100.',
			})
		}
		if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
			context.addIssue({
				code: 'custom',
				path: ['endsAt'],
				message: 'The end must be after the start.',
			})
		}
		if (value.captureContact !== 'none' && !value.consentText.trim()) {
			context.addIssue({
				code: 'custom',
				path: ['consentText'],
				message: 'Signup needs the wording of the consent checkbox.',
			})
		}
		if (!value.title.trim() && !value.body.trim()) {
			context.addIssue({
				code: 'custom',
				path: ['title'],
				message: 'Add a title or some text.',
			})
		}
	})
export type SitePopupInput = z.infer<typeof sitePopupInputSchema>

/** What Sites receives for a published popup. Coupon fields are resolved server-side. */
export type PublicSitePopup = {
	id: string
	title: string
	body: string
	buttonLabel: string
	/** A site path or https URL when there is no coupon. */
	buttonUrl: string | null
	imageUrl: string | null
	/** Present only while the coupon is valid online; never the discount's rules. */
	couponCode: string | null
	trigger: SitePopupTrigger
	triggerValue: number
	frequency: SitePopupFrequency
	pages: SitePopupPageKey[]
	startsAt: string | null
	endsAt: string | null
	captureContact: SitePopupCapture
	consentText: string
}

// ---------------------------------------------------------------------------
// Where a popup may show
// ---------------------------------------------------------------------------

/**
 * Pages a popup never covers (#132): checkout and payment, order and booking
 * confirmation and management pages, and the guest's account and sign-in
 * pages. Paths are site paths; a language prefix (`/ar/checkout`) is ignored.
 */
const EXCLUDED_FIRST_SEGMENTS = new Set([
	'checkout',
	'payment',
	'pay',
	'cart',
	'profile',
	'account',
	'login',
	'verify',
	'complete-name',
])

/** `/menu/checkout`, `/menu/success`, `/reserve/manage`, `/reserve/pay`, `/shop/success`. */
const EXCLUDED_NESTED: Record<string, ReadonlySet<string>> = {
	menu: new Set(['checkout', 'payment', 'pay', 'success']),
	reserve: new Set(['manage', 'pay', 'waitlist']),
	shop: new Set(['success', 'checkout']),
}

function pathSegments(pathname: string): string[] {
	return pathname
		.split(/[?#]/u)[0]!
		.split('/')
		.map((segment) => segment.toLowerCase())
		.filter(Boolean)
}

const LOCALE_PREFIX = /^[a-z]{2}(-[a-z]{2})?$/u

/** The segments after an optional language prefix. */
function withoutLocale(segments: string[]): string[] {
	return segments.length > 0 && LOCALE_PREFIX.test(segments[0]!)
		? segments.slice(1)
		: segments
}

export function popupExcludedPath(pathname: string): boolean {
	const [first, second] = withoutLocale(pathSegments(pathname))
	if (!first) return false
	if (EXCLUDED_FIRST_SEGMENTS.has(first)) return true
	return Boolean(second && EXCLUDED_NESTED[first]?.has(second))
}

export function popupPageKey(
	pathname: string,
): Exclude<SitePopupPageKey, 'all'> {
	const trimmed = withoutLocale(pathSegments(pathname))
	if (trimmed.length === 0) return 'home'
	if (trimmed[0] === 'menu') return 'menu'
	return 'other'
}

export function popupMatchesPage(
	pages: readonly SitePopupPageKey[],
	pathname: string,
): boolean {
	if (popupExcludedPath(pathname)) return false
	return pages.includes('all') || pages.includes(popupPageKey(pathname))
}

// ---------------------------------------------------------------------------
// When it shows
// ---------------------------------------------------------------------------

const FREQUENCY_MS: Record<
	Exclude<SitePopupFrequency, 'session' | 'ever'>,
	number
> = {
	day: 24 * 60 * 60 * 1000,
	week: 7 * 24 * 60 * 60 * 1000,
}

/** The window (ms) after a close in which the popup stays away; `null`: never again. */
export function frequencyWindowMs(
	frequency: SitePopupFrequency,
): number | null {
	if (frequency === 'ever') return null
	if (frequency === 'session') return 0
	return FREQUENCY_MS[frequency]
}

/**
 * Whether a visitor who last closed this popup at `closedAt` (ms, or null for
 * never) may see it again now. `session` is handled by the caller (storage
 * that lives for the session); here a session close always blocks.
 */
export function frequencyAllows(
	frequency: SitePopupFrequency,
	closedAt: number | null,
	now: number,
	closedThisSession = false,
): boolean {
	if (closedAt === null) return true
	if (frequency === 'ever') return false
	if (frequency === 'session') return !closedThisSession
	return now - closedAt >= FREQUENCY_MS[frequency]
}

/** Whether `now` is inside the popup's start and end (ISO strings or null). */
export function popupWindowOpen(
	startsAt: string | null,
	endsAt: string | null,
	now: number,
): boolean {
	if (startsAt) {
		const start = Date.parse(startsAt)
		if (Number.isFinite(start) && now < start) return false
	}
	if (endsAt) {
		const end = Date.parse(endsAt)
		if (Number.isFinite(end) && now >= end) return false
	}
	return true
}

/**
 * The one popup for a page view (#132): never on an excluded page; among those
 * whose pages, dates and frequency cap allow it, the most recently started
 * wins (a popup with no start counts as oldest). At most one.
 */
export function pickPopup<
	T extends Pick<
		PublicSitePopup,
		'id' | 'pages' | 'startsAt' | 'endsAt' | 'frequency'
	>,
>(
	popups: readonly T[],
	input: {
		pathname: string
		now: number
		/** When the visitor last closed each popup (ms), by id. */
		closedAt: Readonly<Record<string, number | undefined>>
		/** Popups closed in this browser session, by id. */
		closedThisSession?: ReadonlySet<string>
	},
): T | null {
	if (popupExcludedPath(input.pathname)) return null
	const eligible = popups.filter(
		(popup) =>
			popupMatchesPage(popup.pages, input.pathname) &&
			popupWindowOpen(popup.startsAt, popup.endsAt, input.now) &&
			frequencyAllows(
				popup.frequency,
				input.closedAt[popup.id] ?? null,
				input.now,
				input.closedThisSession?.has(popup.id) ?? false,
			),
	)
	if (eligible.length === 0) return null
	const started = (popup: T) =>
		popup.startsAt ? Date.parse(popup.startsAt) || 0 : 0
	return [...eligible].sort(
		(a, b) => started(b) - started(a) || a.id.localeCompare(b.id),
	)[0]!
}

/** The button of a popup with a coupon: the menu, with the code in the URL. */
export function popupCouponHref(code: string): string {
	return `/menu?coupon=${encodeURIComponent(code)}`
}

// ---------------------------------------------------------------------------
// Coupon
// ---------------------------------------------------------------------------

export type PopupCouponFacts = {
	status: string
	application: string
	channels: readonly string[]
	/** `YYYY-MM-DDTHH:MM` in the site's time zone, or null. */
	startsAt: string | null
	endsAt: string | null
	/** `YYYY-MM-DDTHH:MM` now in the site's time zone. */
	localNow: string
	totalLimit: number | null
	/** Counted uses so far (reserved and consumed); null when the region could not say. */
	uses: number | null
	/** Unarchived codes of the discount. */
	codes: readonly string[]
}

/**
 * A coupon a popup may carry: active, applied with a code, usable on the
 * website, inside its dates, not used up and with a code to show. The region
 * checks the code again at checkout.
 */
export function couponValidOnline(facts: PopupCouponFacts): boolean {
	if (facts.status !== 'active') return false
	if (facts.application !== 'code') return false
	if (!facts.channels.includes('web')) return false
	if (facts.startsAt && facts.localNow < facts.startsAt) return false
	if (facts.endsAt && facts.localNow >= facts.endsAt) return false
	if (
		facts.totalLimit !== null &&
		facts.uses !== null &&
		facts.uses >= facts.totalLimit
	) {
		return false
	}
	return facts.codes.length > 0
}
