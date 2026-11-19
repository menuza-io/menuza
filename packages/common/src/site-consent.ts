/**
 * Guest consent for tracking tags on restaurant sites (#89). Pure logic, shared
 * by the Sites banner and its tests; the choice lives only in the guest's
 * browser and is never sent anywhere.
 *
 * Modes (set per site by the operator):
 * - `required`: tags stay off until the guest accepts;
 * - `notice`: tags load, with an opt-out;
 * - `off`: no banner (only allowed when the site has no tracking tags).
 *
 * A stored choice lasts six months and is asked again when the set of tags
 * changes. A browser that sends Global Privacy Control is treated as
 * "Reject non-essential" until the guest chooses otherwise. Essential storage
 * (cart, sign-in, language, this choice) never needs consent.
 */

export type ConsentMode = 'required' | 'notice' | 'off'

export const CONSENT_STORAGE_KEY = 'site-consent'
/** The choice is kept this long, then asked again (six months). */
export const CONSENT_MAX_AGE_MS = 183 * 24 * 60 * 60 * 1000

export type ConsentCategories = { analytics: boolean; marketing: boolean }

export type ConsentChoice = ConsentCategories & {
	/** Format version. */
	v: 1
	/** When it was made, ms since epoch. */
	at: number
	/** The tag set it was made for (`tagSignature`). */
	tags: string
}

export type SiteTagIds = {
	facebook?: string | null
	tiktok?: string | null
	googleTagManager?: string | null
	googleAnalytics?: string | null
}

/**
 * Which category each vendor needs: Google Analytics and Tag Manager need
 * analytics, the Meta and TikTok pixels need marketing.
 */
export const TAG_CATEGORY = {
	googleAnalytics: 'analytics',
	googleTagManager: 'analytics',
	facebook: 'marketing',
	tiktok: 'marketing',
} as const satisfies Record<keyof SiteTagIds, keyof ConsentCategories>

/** A stable fingerprint of the tags in use; a new pixel changes it. */
export function tagSignature(ids: SiteTagIds): string {
	return (
		[
			['ga', ids.googleAnalytics],
			['gtm', ids.googleTagManager],
			['fb', ids.facebook],
			['tt', ids.tiktok],
		] as const
	)
		.filter(([, value]) => value?.trim())
		.map(([key, value]) => `${key}:${value!.trim()}`)
		.sort()
		.join('|')
}

export function hasAnyTag(ids: SiteTagIds) {
	return tagSignature(ids) !== ''
}

type StorageLike = Pick<Storage, 'getItem'>

/** The stored choice, or null when none, malformed or older than six months. */
export function readConsentChoice(
	storage: StorageLike | null | undefined,
	now: number,
): ConsentChoice | null {
	let raw: string | null = null
	try {
		raw = storage?.getItem(CONSENT_STORAGE_KEY) ?? null
	} catch {
		return null
	}
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw) as Partial<ConsentChoice>
		if (
			parsed?.v !== 1 ||
			typeof parsed.at !== 'number' ||
			typeof parsed.tags !== 'string' ||
			typeof parsed.analytics !== 'boolean' ||
			typeof parsed.marketing !== 'boolean'
		) {
			return null
		}
		if (now - parsed.at >= CONSENT_MAX_AGE_MS || parsed.at > now + 60_000) {
			return null
		}
		return parsed as ConsentChoice
	} catch {
		return null
	}
}

export function makeConsentChoice(
	categories: ConsentCategories,
	tags: SiteTagIds,
	now: number,
): ConsentChoice {
	return {
		v: 1,
		at: now,
		tags: tagSignature(tags),
		analytics: categories.analytics,
		marketing: categories.marketing,
	}
}

/** Whether the browser sends Global Privacy Control (`navigator`-like). */
export function isGlobalPrivacyControl(
	nav: { globalPrivacyControl?: unknown } | null | undefined,
): boolean {
	return nav?.globalPrivacyControl === true
}

export type ConsentState = ConsentCategories & {
	/** The banner must be shown (no valid choice yet, or the tags changed). */
	askAgain: boolean
	/** Why the categories are what they are. */
	reason: 'off' | 'choice' | 'gpc' | 'default'
}

/**
 * What may load now. A valid stored choice wins (the guest chose, even over
 * GPC); otherwise GPC means Reject; otherwise Required keeps everything off
 * and Notice only keeps everything on. Either way, no valid choice means the
 * banner is shown, except for GPC, which already answered.
 */
export function resolveConsent(input: {
	mode: ConsentMode
	choice: ConsentChoice | null
	gpc: boolean
	tags: SiteTagIds
}): ConsentState {
	if (input.mode === 'off') {
		return { analytics: true, marketing: true, askAgain: false, reason: 'off' }
	}
	if (input.choice && input.choice.tags === tagSignature(input.tags)) {
		return {
			analytics: input.choice.analytics,
			marketing: input.choice.marketing,
			askAgain: false,
			reason: 'choice',
		}
	}
	if (input.gpc) {
		return {
			analytics: false,
			marketing: false,
			askAgain: false,
			reason: 'gpc',
		}
	}
	const granted = input.mode === 'notice'
	return {
		analytics: granted,
		marketing: granted,
		askAgain: true,
		reason: 'default',
	}
}

/** Which of the site's tags may load under a state. */
export function allowedTags(state: ConsentCategories, ids: SiteTagIds) {
	const allowed: Array<keyof SiteTagIds> = []
	for (const key of Object.keys(TAG_CATEGORY) as Array<keyof SiteTagIds>) {
		if (ids[key]?.trim() && state[TAG_CATEGORY[key]]) allowed.push(key)
	}
	return allowed
}
