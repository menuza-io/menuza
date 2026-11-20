import {
	decodeReorderPayload,
	reorderResponseSchema,
	REORDER_PAYLOAD_PARAM,
} from '@repo/common/customer-orders'
import { asLine, type SavedCartLine } from './cart-restore'
import { tenantFetch } from '~/lib/client-auth'

/**
 * "Order again" and "Finish this order" (#112): the Orders page links to
 * `<site>/menu#reorder=<order id>`. The id rides in the URL FRAGMENT, so the
 * Sites server never sees it; the menu page reads it, removes it from the
 * address bar, and asks the region (browser direct, as the signed-in guest) for
 * the order's catalog ids. The cart is then rebuilt from the menu published
 * now by `restoreCart`: prices, names and availability come from the menu,
 * never from the order, and a line that cannot be ordered exactly as it was
 * (a dish, size or option that is gone) is left out whole, never made
 * differently. The result says how many were left out.
 */

export const REORDER_PARAM = 'reorder'
const ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/

function fragmentParams(href: string): URLSearchParams | null {
	const hash = new URL(href, 'https://site.invalid').hash.slice(1)
	return hash.includes('=') ? new URLSearchParams(hash) : null
}

/** Whether the address carries a reorder id in its fragment (valid or not). */
export function hasReorderParam(href: string): boolean {
	return fragmentParams(href)?.has(REORDER_PARAM) === true
}

export function getReorderId(href: string): string | null {
	const value = fragmentParams(href)?.get(REORDER_PARAM) ?? null
	return value && ORDER_ID.test(value) ? value : null
}

export function stripReorderParam(href: string): string {
	const url = new URL(href, 'https://site.invalid')
	const fragment = fragmentParams(href)
	let hash = url.hash
	if (fragment?.has(REORDER_PARAM)) {
		fragment.delete(REORDER_PARAM)
		const rest = fragment.toString()
		hash = rest ? `#${rest}` : ''
	}
	return `${url.pathname}${url.search}${hash}`
}

/** `/menu#reorder=<id>`, with the page's language prefix. */
export function reorderHref(orderId: string, localePrefix = ''): string {
	return `${localePrefix}/menu#${REORDER_PARAM}=${encodeURIComponent(orderId)}`
}

export type ReorderFetch =
	| {
			status: 'loaded'
			cart: { locationId: string; lines: SavedCartLine[] }
			/** Lines the order had, before the live menu is asked. */
			lineCount: number
	  }
	| { status: 'signed_out' }
	| { status: 'not_found' }
	| { status: 'not_reorderable' }
	| { status: 'error' }

/** Reads the order's catalog ids from the region as the signed-in guest. */
export async function fetchReorder(
	orderId: string,
	fetcher: typeof tenantFetch = tenantFetch,
): Promise<ReorderFetch> {
	try {
		const { session, response } = await fetcher(
			`/customer/orders/${encodeURIComponent(orderId)}/reorder`,
			{ cache: 'no-store' },
		)
		if (session === 'signed_out') return { status: 'signed_out' }
		if (session === 'transient') return { status: 'error' }
		if (response.status === 404) return { status: 'not_found' }
		if (response.status === 409) return { status: 'not_reorderable' }
		if (!response.ok) return { status: 'error' }
		const parsed = reorderResponseSchema.safeParse(await response.json())
		if (!parsed.success) return { status: 'error' }
		const lines = parsed.data.lines
			.map((line) =>
				asLine({
					itemId: line.itemId,
					variantId: line.variantId ?? undefined,
					quantity: line.quantity,
					options: line.options.map((option) => ({
						groupId: option.groupId,
						optionId: option.optionId,
						quantity: option.quantity,
						...(option.half ? { half: option.half } : {}),
					})),
				}),
			)
			.filter((line): line is SavedCartLine => line !== null)
		if (lines.length === 0) return { status: 'not_reorderable' }
		return {
			status: 'loaded',
			cart: { locationId: parsed.data.locationId, lines },
			lineCount: parsed.data.lines.length,
		}
	} catch {
		return { status: 'error' }
	}
}

/**
 * The customer app has no cart: it opens the menu with the order's catalog ids
 * in `#reorderlines=` (ids and counts only, never sent to a server). Returns
 * the lines in the same shape as a fetched reorder, or null when the fragment
 * is absent or not a valid payload.
 */
export function getReorderPayload(
	href: string,
): { locationId: string; lines: SavedCartLine[] } | null {
	const decoded = decodeReorderPayload(
		fragmentParams(href)?.get(REORDER_PAYLOAD_PARAM),
	)
	if (!decoded) return null
	const lines = decoded.lines
		.map((line) => asLine(line))
		.filter((line): line is SavedCartLine => line !== null)
	return lines.length ? { locationId: decoded.locationId, lines } : null
}

export function hasReorderPayloadParam(href: string): boolean {
	return fragmentParams(href)?.has(REORDER_PAYLOAD_PARAM) === true
}

export function stripReorderPayloadParam(href: string): string {
	const url = new URL(href, 'https://site.invalid')
	const fragment = fragmentParams(href)
	let hash = url.hash
	if (fragment?.has(REORDER_PAYLOAD_PARAM)) {
		fragment.delete(REORDER_PAYLOAD_PARAM)
		const rest = fragment.toString()
		hash = rest ? `#${rest}` : ''
	}
	return `${url.pathname}${url.search}${hash}`
}
