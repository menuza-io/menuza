import {
	repriceHandoffCart,
	type HandoffCartItem,
	type HandoffCartOption,
	type RepriceMenu,
} from './voice-order-handoff'

/**
 * "Back to your order" (#150): a cart reminder links to `<site>/menu#cart=TOKEN`.
 * The token lives in the URL FRAGMENT only: the Sites server, its logs and the
 * Referer header never see it. It is read here from `location.hash` (never the
 * query string), removed from the address bar before anything else runs, and
 * sent from the browser straight to tenant-api in the `X-Cart-Token` header.
 * It is never logged, stored or shown.
 *
 * The saved cart holds ids and quantities only. The cart is rebuilt from the
 * menu published now (`repriceHandoffCart`): prices, names and availability
 * always come from the menu, and anything that can no longer be ordered is
 * dropped with a notice.
 */

export const CART_PARAM = 'cart'
export const CART_TOKEN_HEADER = 'X-Cart-Token'
const TOKEN_PATTERN = /^\d{10,16}\.[A-Za-z0-9_-]{1,64}\.[0-9a-f]{64}$/

function fragmentParams(href: string): URLSearchParams | null {
	const hash = new URL(href).hash.slice(1)
	return hash.includes('=') ? new URLSearchParams(hash) : null
}

/** Whether the address carries a cart token in its fragment (valid or not). */
export function hasCartParam(href: string): boolean {
	return fragmentParams(href)?.has(CART_PARAM) === true
}

/** The token from the fragment only, or null when absent or malformed. */
export function getCartToken(href: string): string | null {
	const value = fragmentParams(href)?.get(CART_PARAM) ?? null
	return value && TOKEN_PATTERN.test(value) ? value : null
}

/** The same address (path, query, other fragment parts) without the cart token. */
export function stripCartParam(href: string): string {
	const url = new URL(href)
	const fragment = fragmentParams(href)
	let hash = url.hash
	if (fragment?.has(CART_PARAM)) {
		fragment.delete(CART_PARAM)
		const rest = fragment.toString()
		hash = rest ? `#${rest}` : ''
	}
	return `${url.pathname}${url.search}${hash}`
}

export type SavedCartLine = {
	itemId: string
	variantId?: string
	quantity: number
	options?: Array<{
		groupId: string
		optionId: string
		half?: 'whole' | 'left' | 'right'
		quantity?: number
	}>
}

export type SavedCart = {
	locationId: string
	currency: string
	lines: SavedCartLine[]
}

export type CartLinkResult =
	| { status: 'loaded'; cart: SavedCart }
	| { status: 'expired' }
	| { status: 'error' }

function asLine(value: unknown): SavedCartLine | null {
	if (!value || typeof value !== 'object') return null
	const v = value as Record<string, unknown>
	if (typeof v.itemId !== 'string' || !v.itemId) return null
	if (
		typeof v.quantity !== 'number' ||
		!Number.isSafeInteger(v.quantity) ||
		v.quantity < 1
	) {
		return null
	}
	const options: NonNullable<SavedCartLine['options']> = []
	for (const raw of Array.isArray(v.options) ? v.options : []) {
		if (!raw || typeof raw !== 'object') continue
		const o = raw as Record<string, unknown>
		if (typeof o.groupId !== 'string' || typeof o.optionId !== 'string') continue
		options.push({
			groupId: o.groupId,
			optionId: o.optionId,
			...(o.half === 'whole' || o.half === 'left' || o.half === 'right'
				? { half: o.half }
				: {}),
			...(typeof o.quantity === 'number' ? { quantity: o.quantity } : {}),
		})
	}
	return {
		itemId: v.itemId,
		...(typeof v.variantId === 'string' && v.variantId
			? { variantId: v.variantId }
			: {}),
		quantity: Math.min(99, v.quantity),
		options,
	}
}

/**
 * Reads the saved cart. A forged, expired or missing link is one answer (404):
 * `expired`, and the cart is left alone.
 */
export async function fetchSavedCart(options: {
	tenantApiUrl: string
	token: string
	binding: { slug?: string; host?: string }
	fetchImpl?: typeof fetch
}): Promise<CartLinkResult> {
	const params = new URLSearchParams()
	if (options.binding.host) params.set('host', options.binding.host)
	if (options.binding.slug) params.set('slug', options.binding.slug)
	try {
		const response = await (options.fetchImpl ?? fetch)(
			`${options.tenantApiUrl}/orders/cart-link?${params}`,
			{
				cache: 'no-store',
				credentials: 'omit',
				headers: { [CART_TOKEN_HEADER]: options.token },
			},
		)
		if (response.status === 404) return { status: 'expired' }
		if (!response.ok) return { status: 'error' }
		const data = (await response.json()) as { cart?: Record<string, unknown> }
		const raw = data.cart
		if (!raw || typeof raw.locationId !== 'string') return { status: 'error' }
		const lines = (Array.isArray(raw.lines) ? raw.lines : [])
			.map(asLine)
			.filter((line): line is SavedCartLine => line !== null)
		if (!lines.length) return { status: 'expired' }
		return {
			status: 'loaded',
			cart: {
				locationId: raw.locationId,
				currency: typeof raw.currency === 'string' ? raw.currency : '',
				lines,
			},
		}
	} catch {
		return { status: 'error' }
	}
}

/** Saved lines as the menu page's cart shape, with placeholders the menu replaces. */
export function savedLinesToCart(lines: SavedCartLine[]): HandoffCartItem[] {
	return lines.map((line, index) => {
		const options: HandoffCartOption[] = (line.options ?? []).map((option) => ({
			groupId: option.groupId,
			groupName: '',
			optionId: option.optionId,
			optionName: '',
			priceDelta: 0,
			...(option.half ? { half: option.half } : {}),
			...(option.quantity && option.quantity > 1
				? { quantity: option.quantity }
				: {}),
		}))
		return {
			id: `cart_restore_${index}_${Math.random().toString(36).slice(2, 8)}`,
			itemId: line.itemId,
			...(line.variantId ? { variantId: line.variantId } : {}),
			name: '',
			basePrice: 0,
			unitPrice: 0,
			quantity: line.quantity,
			options,
			instructions: '',
		}
	})
}

export type RestoreResult = {
	cart: HandoffCartItem[]
	/** Names of dropped dishes the menu still knows (an unavailable dish). */
	removedNames: string[]
	/** How many saved lines could not be ordered any more. */
	droppedCount: number
}

/**
 * Rebuilds the cart from the live menu. Quantities are kept; prices come from
 * the menu, never from the link; unavailable items, variants and options are
 * dropped.
 */
export function restoreCart(
	lines: SavedCartLine[],
	menus: RepriceMenu[],
): RestoreResult {
	const saved = savedLinesToCart(lines)
	const result = repriceHandoffCart(saved, menus)
	return {
		cart: result.cart,
		removedNames: result.removed,
		droppedCount: saved.length - result.cart.length,
	}
}
