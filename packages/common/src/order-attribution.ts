import { z } from 'zod'
import { sanitizeAttributionValue } from './short-links.ts'

/**
 * Where an online order came from (#115). The browser (Sites) or the customer
 * app sends what it kept from the link the guest followed: UTM values, the
 * Menuza campaign (`mzc`) and step (`mzs`) of a message, the short link
 * (`mzl`) of #159. The region stores it with the order (`attribution`, and
 * `attribution_source` for reports) and uses it only for reporting.
 *
 * Every value is at most 100 characters and loses its control characters; an
 * unknown field refuses the whole payload. A campaign, step or short link the
 * region does not know is dropped. The last non-direct touch within 7
 * days wins; that is decided where the touch is kept (the browser) and checked
 * again here (`touchedAt`). No cookie, no visitor id, no address, no user agent.
 */

export const ORDER_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** A guest who was sent a message and orders within this long is "reached" (14 days). */
export const REACHED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

const text = z
	.string()
	.max(100)
	.transform((value) => sanitizeAttributionValue(value) ?? undefined)
	.optional()

export const orderAttributionInputSchema = z.strictObject({
	utmSource: text,
	utmMedium: text,
	utmCampaign: text,
	utmContent: text,
	/** `mzc`: the broadcast or automation that carried the link. */
	campaignId: text,
	/** `mzs`: the automation step. */
	stepId: text,
	/** `mzl`: the short link followed. */
	shortLinkId: text,
	/** When the guest followed the link (epoch ms). */
	touchedAt: z.number().int().positive().optional(),
})
export type OrderAttributionInput = z.infer<typeof orderAttributionInputSchema>

export type StoredOrderAttribution = {
	utmSource?: string
	utmMedium?: string
	utmCampaign?: string
	utmContent?: string
	campaignId?: string
	stepId?: string
	shortLinkId?: string
	coupon?: string
	touchedAt?: number
}

/** The values `attribution_source` takes, and what a report groups by. */
export const ATTRIBUTION_SOURCES_FIXED = [
	'qr_table',
	'qr_poster',
	'short_link',
	'email',
	'sms',
	'campaign',
	'coupon',
	'direct',
] as const

export type BuiltAttribution = {
	attribution: StoredOrderAttribution | null
	source: string
}

/**
 * What an order stores. `orderSource` is the QR source of a table or poster
 * order, which stays as it is. A touch older than 7 days (or from the future)
 * is dropped. `shortLinkKnown` is whether the region has that short link: an
 * id it does not know is not kept. The coupon code comes from the order itself.
 */
export function buildOrderAttribution(input: {
	orderSource: 'qr_table' | 'qr_poster' | null
	attribution: OrderAttributionInput | null | undefined
	shortLinkKnown: boolean
	/** Whether the region has this broadcast or automation (`campaignId`). */
	campaignKnown: boolean
	/** Whether that automation has run this step (`stepId`). */
	stepKnown: boolean
	couponCode?: string | null
	now: number
}): BuiltAttribution {
	const stored: StoredOrderAttribution = {}
	const touch = input.attribution
	const touchedAt = touch?.touchedAt
	const fresh =
		touchedAt !== undefined &&
		touchedAt <= input.now + 5 * 60 * 1000 &&
		input.now - touchedAt <= ORDER_ATTRIBUTION_WINDOW_MS
	if (touch && fresh) {
		if (touch.utmSource) stored.utmSource = touch.utmSource
		if (touch.utmMedium) stored.utmMedium = touch.utmMedium
		if (touch.utmCampaign) stored.utmCampaign = touch.utmCampaign
		if (touch.utmContent) stored.utmContent = touch.utmContent
		// An id the region does not know is the visitor's invention: not kept, so
		// a crafted link cannot credit an order to a campaign or step that is
		// not this organization's.
		if (touch.campaignId && input.campaignKnown) {
			stored.campaignId = touch.campaignId
			if (touch.stepId && input.stepKnown) stored.stepId = touch.stepId
		}
		if (touch.shortLinkId && input.shortLinkKnown) {
			stored.shortLinkId = touch.shortLinkId
		}
		stored.touchedAt = touchedAt
	}
	const coupon = sanitizeAttributionValue(input.couponCode)
	if (coupon) stored.coupon = coupon

	let source = 'direct'
	if (input.orderSource) source = input.orderSource
	else if (stored.shortLinkId) source = 'short_link'
	else if (stored.campaignId) {
		const medium = stored.utmMedium?.toLowerCase()
		source =
			medium === 'email' ? 'email' : medium === 'sms' ? 'sms' : 'campaign'
	} else if (stored.utmSource) source = stored.utmSource.toLowerCase()
	else if (stored.coupon) source = 'coupon'

	const hasTouch = Object.keys(stored).some((key) => key !== 'touchedAt')
	return { attribution: hasTouch ? stored : null, source }
}

/** The order's attribution as it comes back from storage (JSON text or an object). */
export function parseStoredAttribution(
	value: unknown,
): StoredOrderAttribution | null {
	try {
		const raw = typeof value === 'string' ? JSON.parse(value) : value
		if (!raw || typeof raw !== 'object') return null
		const out: StoredOrderAttribution = {}
		for (const key of [
			'utmSource',
			'utmMedium',
			'utmCampaign',
			'utmContent',
			'campaignId',
			'stepId',
			'shortLinkId',
			'coupon',
		] as const) {
			const clean = sanitizeAttributionValue(
				(raw as Record<string, unknown>)[key],
			)
			if (clean) out[key] = clean
		}
		const at = (raw as Record<string, unknown>).touchedAt
		if (typeof at === 'number') out.touchedAt = at
		return Object.keys(out).length > 0 ? out : null
	} catch {
		return null
	}
}

/**
 * Words for "Came from: ..." on an order, from its source and attribution. A
 * plain label (not translated here: the callers translate the fixed sources).
 */
export function cameFrom(
	source: string | null | undefined,
	attribution: StoredOrderAttribution | null,
): { source: string; detail: string | null } {
	const key = source || 'direct'
	const detail =
		attribution?.utmCampaign ??
		attribution?.utmSource ??
		attribution?.coupon ??
		null
	return { source: key, detail }
}
