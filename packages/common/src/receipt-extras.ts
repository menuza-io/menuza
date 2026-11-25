/**
 * Marketing codes on the guest receipt (#263): the logo, a review code and an
 * app or rewards code. One pure model decides what a receipt shows, so the
 * Station receipt, the App's live preview and a cloud printer's ticket agree.
 * The fiscal QR code on a KSA receipt always comes first and is never touched.
 */

/** Hosts a Google review link may point to. */
const REVIEW_HOSTS = [
	'google.com',
	'g.page',
	'goo.gl',
	'maps.app.goo.gl',
	'g.co',
] as const

export const REVIEW_URL_MAX_LENGTH = 500

/** The cleaned https review link, or null when it is empty or not a Google review page. */
export function cleanGoogleReviewUrl(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const text = value.trim()
	if (!text || text.length > REVIEW_URL_MAX_LENGTH) return null
	let url: URL
	try {
		url = new URL(text)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' || url.username || url.password) return null
	const host = url.hostname.toLowerCase()
	const ok = REVIEW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
	return ok ? url.toString() : null
}

// ---------------------------------------------------------------------------
// What a receipt shows (#263)
// ---------------------------------------------------------------------------

export const DEFAULT_REVIEW_CAPTION = 'Enjoyed it? Tell us'
export const DEFAULT_APP_CAPTION = 'Order ahead next time'
export const RECEIPT_CAPTION_MAX_LENGTH = 60

/** One code switch: on or off, with the caption the owner may reword. */
export type ReceiptCodeSetting = { show: boolean; caption: string | null }

/** Everything the owner can switch on, as the settings screen stores it. */
export type ReceiptExtrasConfig = {
	logo: boolean
	review: ReceiptCodeSetting
	app: ReceiptCodeSetting
}

/** Nothing switched on: a receipt prints exactly what it always did. */
export const DEFAULT_RECEIPT_EXTRAS: ReceiptExtrasConfig = {
	logo: false,
	review: { show: false, caption: null },
	app: { show: false, caption: null },
}

function cleanCaption(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const text = value
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, RECEIPT_CAPTION_MAX_LENGTH)
	return text || null
}

function codeSetting(value: unknown): ReceiptCodeSetting {
	const record =
		value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	return {
		show: record.show === true,
		caption: cleanCaption(record.caption),
	}
}

/** Reads stored settings; anything unreadable is off. */
export function readReceiptExtras(value: unknown): ReceiptExtrasConfig {
	const record =
		value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
	return {
		logo: record.logo === true,
		review: codeSetting(record.review),
		app: codeSetting(record.app),
	}
}

/** What is stored: only what differs from nothing switched on. */
export function compactReceiptExtras(
	config: ReceiptExtrasConfig,
): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {}
	if (config.logo) out.logo = true
	for (const key of ['review', 'app'] as const) {
		const setting = config[key]
		if (!setting.show && !setting.caption) continue
		out[key] = {
			...(setting.show ? { show: true } : {}),
			...(setting.caption ? { caption: setting.caption } : {}),
		}
	}
	return Object.keys(out).length > 0 ? out : undefined
}

/** The links the codes open. Null when the target does not exist. */
export type ReceiptTargets = {
	reviewUrl: string | null
	appUrl: string | null
}

/** Paper the receipt prints on, in millimetres. Station's own page is 72 mm. */
export type ReceiptWidthMm = 58 | 72 | 80

export type ReceiptKind = 'sale' | 'refund' | 'void'

export type ReceiptExtrasPlan = {
	/** Print the one-colour logo at the top. */
	logo: boolean
	/** Codes in print order, always after the fiscal code. */
	codes: Array<{ kind: 'review' | 'app'; url: string; caption: string }>
	/** Why codes that were switched on are not printed. */
	dropped: 'paper_width' | 'refund_or_void' | null
}

/**
 * How many marketing codes a receipt can carry without hurting the fiscal one.
 * A 58 mm roll cannot fit the ZATCA code and smaller codes beside it clearly,
 * so its marketing codes are dropped; a KSA receipt keeps its fiscal code first
 * and unchanged whatever happens here.
 */
export function codeCapacity(width: ReceiptWidthMm, fiscalQr: boolean): number {
	if (width === 58) return fiscalQr ? 0 : 2
	return 2
}

/**
 * One decision for every receipt (the till, a cloud printer and the settings
 * preview): what the owner switched on, which of it has a target, and whether
 * the paper has room. Refund and void slips never carry marketing.
 */
export function planReceiptExtras(input: {
	config: ReceiptExtrasConfig
	targets: ReceiptTargets
	logoUrl: string | null
	width: ReceiptWidthMm
	fiscalQr: boolean
	kind?: ReceiptKind
}): ReceiptExtrasPlan {
	const none: ReceiptExtrasPlan = { logo: false, codes: [], dropped: null }
	const { config, targets } = input
	const wanted: ReceiptExtrasPlan['codes'] = []
	if (config.review.show && targets.reviewUrl) {
		wanted.push({
			kind: 'review',
			url: targets.reviewUrl,
			caption: config.review.caption || DEFAULT_REVIEW_CAPTION,
		})
	}
	if (config.app.show && targets.appUrl) {
		wanted.push({
			kind: 'app',
			url: targets.appUrl,
			caption: config.app.caption || DEFAULT_APP_CAPTION,
		})
	}
	const wantsLogo = config.logo && Boolean(input.logoUrl)
	if ((input.kind ?? 'sale') !== 'sale') {
		return wantsLogo || wanted.length > 0
			? { ...none, dropped: 'refund_or_void' }
			: none
	}
	const room = codeCapacity(input.width, input.fiscalQr)
	if (wanted.length > room) {
		return { logo: wantsLogo, codes: [], dropped: 'paper_width' }
	}
	return { logo: wantsLogo, codes: wanted, dropped: null }
}

/** Longest the printed logo may be, in dots at 203 dpi (about 15 mm). */
export const RECEIPT_LOGO_MAX_HEIGHT_DOTS = 120
