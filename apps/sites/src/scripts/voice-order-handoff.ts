export type HandoffCartOption = {
	groupId: string
	groupName: string
	optionId: string
	optionName: string
	priceDelta: number
	half?: 'whole' | 'left' | 'right'
	/** Size/variant echo for display; the order API prices it from `variantId`. */
	variation?: boolean
}

export type HandoffCartItem = {
	id: string
	itemId: string
	variantId?: string
	name: string
	basePrice: number
	unitPrice: number
	quantity: number
	options: HandoffCartOption[]
	instructions: string
}

export type FulfillmentMode = 'pickup' | 'delivery'

export type VoiceOrderHandoffResult =
	| {
			status: 'loaded'
			cart: HandoffCartItem[]
			locationId: string | null
			fulfillmentMode: FulfillmentMode | null
	  }
	| { status: 'expired' }
	| { status: 'error' }

export const HANDOFF_PARAM = 'handoff'
/** The name order links used before the phone agent sent generic links. */
const LEGACY_ORDER_PARAM = 'order'
const TOKEN_PARAMS = [HANDOFF_PARAM, LEGACY_ORDER_PARAM]
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/

/**
 * Phone agent links carry the token in the fragment (`#handoff=TOKEN`) so it
 * never reaches the Sites server, its logs, or the Referer header.
 */
function hashParams(url: URL): URLSearchParams | null {
	const hash = url.hash.slice(1)
	if (!hash.includes('=')) return null
	return new URLSearchParams(hash)
}

/** The raw token from the fragment, or from the query string used by older links. */
function rawTokenValue(url: URL): string | null {
	const fragment = hashParams(url)
	for (const name of TOKEN_PARAMS) {
		const value = fragment?.get(name) ?? url.searchParams.get(name)
		if (value !== null) return value
	}
	return null
}

export function hasHandoffParam(href: string): boolean {
	return rawTokenValue(new URL(href)) !== null
}

export function getHandoffToken(href: string): string | null {
	const token = rawTokenValue(new URL(href))
	return token && TOKEN_PATTERN.test(token) ? token : null
}

/** Returns the same URL (path, other params, other fragment) without the handoff token. */
export function stripHandoffParam(href: string): string {
	const url = new URL(href)
	const fragment = hashParams(url)
	let hash = url.hash
	for (const name of TOKEN_PARAMS) url.searchParams.delete(name)
	if (fragment && TOKEN_PARAMS.some((name) => fragment.has(name))) {
		for (const name of TOKEN_PARAMS) fragment.delete(name)
		const rest = fragment.toString()
		hash = rest ? `#${rest}` : ''
	}
	return `${url.pathname}${url.search}${hash}`
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeOption(raw: unknown): HandoffCartOption | null {
	if (!raw || typeof raw !== 'object') return null
	const o = raw as Record<string, unknown>
	const groupId = asString(o.groupId)
	const optionId = asString(o.optionId)
	if (!groupId || !optionId) return null
	const option: HandoffCartOption = {
		groupId,
		groupName: asString(o.groupName),
		optionId,
		optionName: asString(o.optionName),
		priceDelta: asNumber(o.priceDelta),
	}
	if (o.half === 'whole' || o.half === 'left' || o.half === 'right') {
		option.half = o.half
	}
	return option
}

/** Coerces the tenant-api payload into the menu page's localStorage cart shape. */
export function normalizeHandoffCart(raw: unknown): HandoffCartItem[] {
	if (!Array.isArray(raw)) return []
	const items: HandoffCartItem[] = []
	for (const entry of raw) {
		if (!entry || typeof entry !== 'object') continue
		const e = entry as Record<string, unknown>
		const itemId = asString(e.itemId)
		if (!itemId) continue
		const quantity = Math.min(
			99,
			Math.max(1, Math.trunc(asNumber(e.quantity)) || 1),
		)
		const basePrice = asNumber(e.basePrice)
		const item: HandoffCartItem = {
			id:
				asString(e.id) ||
				`cart_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
			itemId,
			name: asString(e.name),
			basePrice,
			unitPrice:
				typeof e.unitPrice === 'number' ? asNumber(e.unitPrice) : basePrice,
			quantity,
			options: Array.isArray(e.options)
				? e.options
						.map(normalizeOption)
						.filter((o): o is HandoffCartOption => o !== null)
				: [],
			instructions: asString(e.instructions),
		}
		const variantId = asString(e.variantId)
		if (variantId) item.variantId = variantId
		items.push(item)
	}
	return items
}

export function normalizeFulfillmentMode(
	value: unknown,
): FulfillmentMode | null {
	return value === 'pickup' || value === 'delivery' ? value : null
}

export async function fetchVoiceOrderHandoff(options: {
	tenantApiUrl: string
	token: string
	binding: { slug?: string; host?: string }
}): Promise<VoiceOrderHandoffResult> {
	const params = new URLSearchParams()
	if (options.binding.host) params.set('host', options.binding.host)
	if (options.binding.slug) params.set('slug', options.binding.slug)
	try {
		const response = await fetch(
			`${options.tenantApiUrl}/voice/handoffs/${encodeURIComponent(options.token)}?${params}`,
			{ cache: 'no-store', credentials: 'omit' },
		)
		if (response.status === 410) return { status: 'expired' }
		if (!response.ok) return { status: 'error' }
		// `{ path, payload, scopeId, expiresAt }`; for order links the payload
		// is `{ cart, fulfillmentMode }` and the scope is the location.
		const data = (await response.json()) as Record<string, unknown>
		const payload =
			data.payload && typeof data.payload === 'object'
				? (data.payload as Record<string, unknown>)
				: {}
		const cart = normalizeHandoffCart(payload.cart)
		if (!cart.length) return { status: 'error' }
		return {
			status: 'loaded',
			cart,
			locationId: asString(data.scopeId) || null,
			fulfillmentMode: normalizeFulfillmentMode(payload.fulfillmentMode),
		}
	} catch {
		return { status: 'error' }
	}
}

type RepriceMenuOption = {
	id: string
	displayName: string
	price?: number | null
	priceWhole?: number | null
	priceLeft?: number | null
	priceRight?: number | null
	availabilityStatus?: string
	nestedModifierGroups?: RepriceModifierGroup[]
}

type RepriceModifierGroup = {
	id: string
	name: string
	selectionType?: string
	minSelections?: number | null
	maxSelections?: number | null
	availabilityStatus?: string
	options?: RepriceMenuOption[]
}

type RepriceMenuItem = {
	id: string
	displayName: string
	price: number
	availabilityStatus?: string
	variations?: {
		groups?: Array<{
			id: string
			name: string
			values?: Array<{ id: string; name: string }>
		}>
		variants?: Array<{
			id: string
			valueIds: string[]
			price: number
			availabilityStatus?: string
		}>
	}
	modifierGroups?: RepriceModifierGroup[]
}

type RepriceCategory = {
	availabilityStatus?: string
	items?: RepriceMenuItem[]
	subcategories?: RepriceCategory[]
}

export type RepriceMenu = {
	availabilityStatus?: string
	categories?: RepriceCategory[]
}

export type RepriceResult = {
	cart: HandoffCartItem[]
	/** Names of lines that can no longer be ordered as described. */
	removed: string[]
	/** True when at least one kept line now costs something different. */
	pricesChanged: boolean
}

const unavailable = (entry: { availabilityStatus?: string } | undefined) =>
	entry?.availabilityStatus === 'unavailable'

function collectItems(menus: RepriceMenu[]): Map<string, RepriceMenuItem> {
	const items = new Map<string, RepriceMenuItem>()
	const visit = (category: RepriceCategory) => {
		if (unavailable(category)) return
		for (const item of category.items ?? []) {
			if (!items.has(item.id)) items.set(item.id, item)
		}
		for (const sub of category.subcategories ?? []) visit(sub)
	}
	for (const menu of menus) {
		if (unavailable(menu)) continue
		for (const category of menu.categories ?? []) visit(category)
	}
	return items
}

/** Same pricing the item modal uses for each kind of selection. */
function optionPrice(
	option: RepriceMenuOption,
	half: HandoffCartOption['half'],
	pizza: boolean,
): number {
	const price = option.price || 0
	if (!pizza) return price
	if (half === 'left') return option.priceLeft ?? price / 2
	if (half === 'right') return option.priceRight ?? price / 2
	return option.priceWhole ?? price
}

/**
 * Checks selections for a list of groups and, recursively, the groups nested
 * under each chosen option. Returns the repriced options in group order, or
 * null when a selection is gone, unavailable, or breaks a min/max rule.
 */
function resolveGroups(
	groups: RepriceModifierGroup[],
	selectedByGroup: Map<string, HandoffCartOption[]>,
	used: Set<HandoffCartOption>,
	seenGroups = new Set<string>(),
): HandoffCartOption[] | null {
	const resolved: HandoffCartOption[] = []
	for (const group of groups) {
		// A group shared by several options is checked once.
		if (seenGroups.has(group.id)) continue
		seenGroups.add(group.id)
		const selected = selectedByGroup.get(group.id) ?? []
		const groupOff = unavailable(group)
		if (groupOff && selected.length) return null
		if (groupOff) continue
		const min = group.minSelections ?? 0
		const max = group.maxSelections ?? null
		if (selected.length < min) return null
		if (max !== null && max > 0 && selected.length > max) return null

		const pizza = group.selectionType === 'pizza'
		for (const choice of selected) {
			const option = group.options?.find((o) => o.id === choice.optionId)
			if (!option || unavailable(option)) return null
			used.add(choice)
			const next: HandoffCartOption = {
				groupId: group.id,
				groupName: group.name,
				optionId: option.id,
				optionName: option.displayName,
				priceDelta: optionPrice(option, choice.half, pizza),
			}
			if (choice.half) next.half = choice.half
			resolved.push(next)
			const nested = resolveGroups(
				option.nestedModifierGroups ?? [],
				selectedByGroup,
				used,
				seenGroups,
			)
			if (!nested) return null
			resolved.push(...nested)
		}
	}
	return resolved
}

function repriceLine(
	line: HandoffCartItem,
	item: RepriceMenuItem | undefined,
): HandoffCartItem | null {
	if (!item || unavailable(item)) return null

	const variationGroups = item.variations?.groups ?? []
	let basePrice = item.price
	const variationOptions: HandoffCartOption[] = []
	if (variationGroups.length) {
		const variant = item.variations?.variants?.find(
			(candidate) => candidate.id === line.variantId,
		)
		if (!variant || unavailable(variant)) return null
		basePrice = variant.price
		variationGroups.forEach((group, index) => {
			const valueId = variant.valueIds[index]
			const value = group.values?.find((candidate) => candidate.id === valueId)
			variationOptions.push({
				groupId: group.id,
				groupName: group.name,
				optionId: valueId ?? '',
				optionName: value?.name ?? '',
				priceDelta: 0,
				variation: true,
			})
		})
	} else if (line.variantId) {
		return null
	}

	const variationGroupIds = new Set(variationGroups.map((group) => group.id))
	const selectedByGroup = new Map<string, HandoffCartOption[]>()
	const modifierChoices = line.options.filter(
		(option) => !variationGroupIds.has(option.groupId),
	)
	for (const option of modifierChoices) {
		selectedByGroup.set(option.groupId, [
			...(selectedByGroup.get(option.groupId) ?? []),
			option,
		])
	}

	const used = new Set<HandoffCartOption>()
	const modifiers = resolveGroups(
		item.modifierGroups ?? [],
		selectedByGroup,
		used,
	)
	// Every choice must belong to the item's current groups (or a group nested
	// under another chosen option); leftovers mean the menu was restructured.
	if (!modifiers || used.size !== modifierChoices.length) return null

	const unitPrice =
		basePrice + modifiers.reduce((sum, option) => sum + option.priceDelta, 0)
	const repriced: HandoffCartItem = {
		id: line.id,
		itemId: item.id,
		name: item.displayName,
		basePrice,
		unitPrice,
		quantity: line.quantity,
		options: [...variationOptions, ...modifiers],
		instructions: line.instructions,
	}
	if (line.variantId) repriced.variantId = line.variantId
	return repriced
}

/**
 * Rebuilds a phone-order cart from the menu that is published now. Prices,
 * names, and availability always come from the menu; the handoff only says
 * which item, size, and options the caller chose.
 */
export function repriceHandoffCart(
	cart: HandoffCartItem[],
	menus: RepriceMenu[],
): RepriceResult {
	const items = collectItems(menus)
	const kept: HandoffCartItem[] = []
	const removed: string[] = []
	let pricesChanged = false
	for (const line of cart) {
		const repriced = repriceLine(line, items.get(line.itemId))
		if (!repriced) {
			removed.push(line.name || items.get(line.itemId)?.displayName || '')
			continue
		}
		if (Math.abs(repriced.unitPrice - line.unitPrice) > 0.004) {
			pricesChanged = true
		}
		kept.push(repriced)
	}
	return { cart: kept, removed: removed.filter(Boolean), pricesChanged }
}

/** Short, non-reversible key so the bearer token itself is never persisted. */
export async function handoffGuardKey(token: string): Promise<string> {
	try {
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(token),
		)
		const hex = Array.from(new Uint8Array(digest).slice(0, 8))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
		return `menuza_voice_order_${hex}`
	} catch {
		return `menuza_voice_order_${token.slice(0, 8)}`
	}
}
