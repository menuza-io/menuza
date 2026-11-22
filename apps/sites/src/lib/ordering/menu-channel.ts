import { normalizeFocalPoint } from '@repo/common/image-focal'
import {
	isSoldOn,
	parseMenuChannels,
	type MenuChannel,
} from '@repo/common/menu-channels'
import { dietaryTagsOf, getLocalizedMenuValue } from '@repo/common/menu-types'
import { readQrOrderingFeatures } from '@repo/common/qr-ordering'
// Top-level `import type` prevents Vite from evaluating `org.ts` (`cloudflare:workers`) in jsdom tests.
// eslint-disable-next-line import/consistent-type-specifier-style
import type { PublicSiteMenuPayload } from '../org.ts'
import {
	type CatalogIndex,
	isItemSoldOut,
	itemHasPriceRange,
	lowestAvailablePrice,
} from './catalog.ts'
import { decorateDishPhoto } from './dish-photo.ts'
import { orderLimitMetaFromMenus, type OrderLimitMeta } from './order-limits.ts'
import { buildPriceBook, type PriceBook } from './price-book.ts'
import {
	type ModifierGroup,
	type ModifierOption,
	type OrderingCategory,
	type OrderingItem,
} from './types.ts'

type FocalLike = { x?: unknown; y?: unknown } | null | undefined

/** A focal point from the payload; anything unreadable or central is the default. */
function focalOf(value: FocalLike) {
	return (value ? normalizeFocalPoint(value.x, value.y) : null) ?? undefined
}

/**
 * The running photo test of a dish (#192) with photo B resolved. The menu is
 * cached for everybody, so this only carries B: `imageUrl` stays photo A and
 * the browser picks.
 */
function photoTestOf(
	item: {
		photoTest?: {
			id: string
			imageUrlB: string
			imageFocalB?: FocalLike
			key?: string
		} | null
	},
	resolveImageUrl: (src: string | null | undefined) => string | null,
): OrderingItem['photoTest'] {
	const test = item.photoTest
	if (!test?.id) return undefined
	const imageUrlB = resolveImageUrl(test.imageUrlB)
	if (!imageUrlB) return undefined
	return {
		id: test.id,
		imageUrlB,
		imageFocalB: focalOf(test.imageFocalB) ?? null,
		...(test.key ? { key: test.key } : {}),
	}
}

/**
 * Reads `qr_ordering` flag payloads in the same fail-closed way as
 * `apps/tenant-api/src/services/order-service.ts` (`readQrOrderingFeatures`),
 * while also accepting a plain boolean for callers/tests.
 */
export function isQrOrderingEnabled(qrOrdering: unknown): boolean {
	if (typeof qrOrdering === 'boolean') return qrOrdering
	if (qrOrdering && typeof qrOrdering === 'object' && 'enabled' in qrOrdering) {
		return (qrOrdering as { enabled?: unknown }).enabled === true
	}
	return readQrOrderingFeatures(qrOrdering).enabled
}

/**
 * Extracts the `qr_poster` attribution source from a menu URL query string
 * (`?src=qr` or `?src=qr_poster`), matching `table-ordering.ts`.
 */
export function posterQuerySource(search: string): 'qr_poster' | null {
	const params = new URLSearchParams(search)
	const src = (params.get('src') ?? '').trim().toLowerCase()
	return src === 'qr' || src === 'qr_poster' ? 'qr_poster' : null
}

export type SiteMenuChannel = 'web' | 'qr'

/**
 * Mirrors `derivePublicOrderChannel` in `apps/tenant-api/src/services/order-service.ts`:
 * - Dine-in (`atTable`) always uses `'qr'`.
 * - Order-ahead poster (`source === 'qr_poster'`) uses `'qr'` when `qr_ordering` is enabled.
 * - Everything else uses `'web'`.
 */
export function deriveSiteMenuChannel(input: {
	atTable?: boolean
	source?: string | null
	qrOrdering?: unknown
}): SiteMenuChannel {
	if (input.atTable) return 'qr'
	if (input.source === 'qr_poster' && isQrOrderingEnabled(input.qrOrdering)) {
		return 'qr'
	}
	return 'web'
}

/**
 * `PublicSiteMenuPayload.features` does not yet include `qrOrdering` from
 * `public-menu-context.server.ts`. When omitted, preserve `qr_poster` behavior
 * until the payload exposes the flag; when present, enforce it strictly.
 */
export function resolveSiteQrOrdering(
	features?: { qrOrdering?: unknown } | null,
): unknown {
	return features?.qrOrdering !== undefined
		? features.qrOrdering
		: { enabled: true, dineIn: true, online: true }
}

/**
 * Browser-safe media URL resolver (avoids importing `varlock/env` from `~/lib/media`
 * in client-side scripts).
 */
export function resolveClientMediaUrl(
	src: string | null | undefined,
	appUrl: string,
): string | null {
	if (!src) return null
	if (
		src.startsWith('data:') ||
		src.startsWith('blob:') ||
		src.startsWith('http://') ||
		src.startsWith('https://')
	) {
		return src
	}
	const origin = appUrl.replace(/\/$/, '')
	if (!origin) return src
	return src.startsWith('/') ? `${origin}${src}` : `${origin}/${src}`
}

export function buildSiteMenuFetchUrl(input: {
	appUrl: string
	slug?: string | null
	host?: string | null
	lng?: string | null
	locationId?: string | null
	channel: MenuChannel
	preview?: boolean
}): string {
	const params = new URLSearchParams()
	if (input.host) params.set('host', input.host)
	else if (input.slug) params.set('slug', input.slug)
	if (input.lng) params.set('lng', input.lng)
	if (input.locationId) params.set('locationId', input.locationId)
	params.set('channel', input.channel)
	if (input.preview) params.set('preview', '1')
	return `${input.appUrl.replace(/\/$/, '')}/resources/sites/menu?${params.toString()}`
}

type PublicOverrideEntry = NonNullable<
	PublicSiteMenuPayload['locationOverrides']
>[string][number]

function buildOverrideMap(
	payload: PublicSiteMenuPayload | null | undefined,
	locationId: string | null,
): Map<string, PublicOverrideEntry> {
	return new Map(
		(locationId ? (payload?.locationOverrides?.[locationId] ?? []) : []).map(
			(entry) => [entry.entityId, entry],
		),
	)
}

function isOverrideOff(
	overrides: Map<string, PublicOverrideEntry>,
	entityId: string,
): boolean {
	const ov = overrides.get(entityId)
	return (
		ov?.isEnabled === false ||
		ov?.availabilityStatus === 'unavailable' ||
		ov?.availabilityStatus === 'hidden'
	)
}

export function buildChannelMenuCategories(
	payload: PublicSiteMenuPayload | null | undefined,
	options: {
		channel: MenuChannel
		locationId: string | null
		locale: string
		defaultLocale: string
		resolveImageUrl: (src: string | null | undefined) => string | null
	},
): OrderingCategory[] {
	const overrides = buildOverrideMap(payload, options.locationId)
	const t = (val: string | null | undefined) =>
		getLocalizedMenuValue(val, options.locale, options.defaultLocale)

	const localizeOption = (
		option: PublicSiteMenuPayload['menus'][number]['categories'][number]['items'][number]['modifierGroups'][number]['options'][number],
	): ModifierOption => ({
		id: option.id,
		displayName: t(option.displayName),
		description: option.description ? t(option.description) : '',
		imageUrl: options.resolveImageUrl(option.imageUrl),
		imageFocal: focalOf(option.imageFocal),
		price: option.price ?? 0,
		priceWhole: option.priceWhole,
		priceLeft: option.priceLeft,
		priceRight: option.priceRight,
		calories: option.calories,
		minSelections: option.minSelections,
		maxSelections: option.maxSelections,
		isDefault: Boolean((option as { isDefault?: boolean }).isDefault),
		availabilityStatus: option.availabilityStatus,
		nestedModifierGroups: (option.nestedModifierGroups ?? []).map(
			localizeGroup,
		),
	})

	const localizeGroup = (
		group: PublicSiteMenuPayload['menus'][number]['categories'][number]['items'][number]['modifierGroups'][number],
	): ModifierGroup => ({
		id: group.id,
		name: t(group.name),
		selectionType: group.selectionType,
		minSelections: group.minSelections ?? 0,
		maxSelections: group.maxSelections ?? null,
		availabilityStatus: group.availabilityStatus,
		options: (group.options ?? []).map(localizeOption),
	})

	const localizeItem = (
		item: PublicSiteMenuPayload['menus'][number]['categories'][number]['items'][number],
		menu: PublicSiteMenuPayload['menus'][number],
	): OrderingItem => ({
		id: item.id,
		displayName: t(item.displayName),
		description: item.description ? t(item.description) : '',
		price: item.price,
		imageUrl: options.resolveImageUrl(item.imageUrl),
		imageFocal: focalOf(item.imageFocal),
		photoTest: photoTestOf(item, options.resolveImageUrl),
		variations: {
			groups: (item.variations?.groups ?? []).map((group) => ({
				id: group.id,
				name: t(group.name),
				values: group.values.map((value) => ({
					id: value.id,
					name: t(value.name),
				})),
			})),
			variants: (item.variations?.variants ?? []).map((variant) => ({
				...variant,
				imageUrl: options.resolveImageUrl(variant.imageUrl),
				imageFocal: focalOf(variant.imageFocal),
			})),
		},
		modifierGroups: (item.modifierGroups ?? []).map(localizeGroup),
		isVegetarian: item.isVegetarian,
		isGlutenFree: item.isGlutenFree,
		isAlcohol: item.isAlcohol,
		dietaryTags: dietaryTagsOf(item),
		allergens: item.allergens ?? [],
		calorieMin: item.calorieMin,
		calorieMax: item.calorieMax,
		isPopular: item.isPopular,
		isUpsell: item.isUpsell === true,
		excludeFromDiscounts: item.excludeFromDiscounts === true,
		availabilityStatus: item.availabilityStatus,
		channels: item.channels,
		specialInstructions: menu.specialInstructions !== false,
	})

	const localizeCategory = (
		category: PublicSiteMenuPayload['menus'][number]['categories'][number],
		menu: PublicSiteMenuPayload['menus'][number],
	): OrderingCategory => ({
		id: category.id,
		displayName: t(category.displayName),
		description: category.description ? t(category.description) : '',
		upsellCategoryIds: category.upsellCategoryIds ?? [],
		channels: category.channels,
		items: (category.items ?? [])
			.filter(
				(item) =>
					!isOverrideOff(overrides, item.id) &&
					isSoldOn(options.channel, {
						item,
						override: overrides.get(item.id),
					}),
			)
			.map((item) => localizeItem(item, menu)),
		subcategories: (category.subcategories ?? [])
			.filter(
				(sub) =>
					sub.availabilityStatus !== 'unavailable' &&
					!isOverrideOff(overrides, sub.id) &&
					isSoldOn(options.channel, {
						category: sub,
						override: overrides.get(sub.id),
					}),
			)
			.map((sub) => localizeCategory(sub, menu)),
	})

	const countItems = (cat: OrderingCategory): number =>
		cat.items.length +
		(cat.subcategories ?? []).reduce((sum, sub) => sum + countItems(sub), 0)

	const pruneEmpty = (cat: OrderingCategory): OrderingCategory | null => {
		const subcategories = (cat.subcategories ?? [])
			.map(pruneEmpty)
			.filter((sub): sub is OrderingCategory => sub !== null)
		const next = { ...cat, subcategories }
		return countItems(next) > 0 ? next : null
	}

	const categories: OrderingCategory[] = []
	for (const menu of payload?.menus ?? []) {
		if (
			menu.availabilityStatus === 'unavailable' ||
			isOverrideOff(overrides, menu.id) ||
			!isSoldOn(options.channel, {
				menu,
				override: overrides.get(menu.id),
			})
		) {
			continue
		}
		for (const category of menu.categories) {
			if (
				category.availabilityStatus === 'unavailable' ||
				category.parentId ||
				isOverrideOff(overrides, category.id) ||
				!isSoldOn(options.channel, {
					category,
					override: overrides.get(category.id),
				})
			) {
				continue
			}
			const localized = pruneEmpty(localizeCategory(category, menu))
			if (localized) categories.push(localized)
		}
	}
	return categories
}

export function buildChannelUpsellCategories(
	payload: PublicSiteMenuPayload | null | undefined,
	options: {
		channel: MenuChannel
		locationId: string | null
		locale: string
		defaultLocale: string
		resolveImageUrl: (src: string | null | undefined) => string | null
	},
): OrderingCategory[] {
	const overrides = buildOverrideMap(payload, options.locationId)
	const upsellCategory = (
		category: PublicSiteMenuPayload['menus'][number]['categories'][number],
	): OrderingCategory => ({
		id: category.id,
		displayName: '',
		upsellCategoryIds: category.upsellCategoryIds ?? [],
		channels: category.channels,
		items: (category.items ?? [])
			.filter(
				(item) =>
					!isOverrideOff(overrides, item.id) &&
					isSoldOn(options.channel, {
						item,
						override: overrides.get(item.id),
					}),
			)
			.map((item) => ({
				id: item.id,
				displayName: getLocalizedMenuValue(
					item.displayName,
					options.locale,
					options.defaultLocale,
				),
				price: item.price,
				imageUrl: options.resolveImageUrl(item.imageUrl),
				imageFocal: focalOf(item.imageFocal),
				photoTest: photoTestOf(item, options.resolveImageUrl),
				isUpsell: item.isUpsell === true,
				availabilityStatus: item.availabilityStatus,
				channels: item.channels,
				variations: {
					groups: (item.variations?.groups ?? []).map((group) => ({
						id: group.id,
						name: '',
						values: [],
					})),
					variants: (item.variations?.variants ?? []).map((variant) => ({
						id: variant.id,
						valueIds: [],
						price: variant.price,
						availabilityStatus: variant.availabilityStatus,
					})),
				},
				modifierGroups: (item.modifierGroups ?? []).map((group) => ({
					id: group.id,
					name: '',
					selectionType: group.selectionType,
					minSelections: group.minSelections ?? 0,
					maxSelections: group.maxSelections ?? null,
					options: [],
				})),
			})),
		subcategories: (category.subcategories ?? [])
			.filter(
				(sub) =>
					sub.availabilityStatus !== 'unavailable' &&
					!isOverrideOff(overrides, sub.id) &&
					isSoldOn(options.channel, {
						category: sub,
						override: overrides.get(sub.id),
					}),
			)
			.map(upsellCategory),
	})

	return (payload?.menus ?? [])
		.filter(
			(menu) =>
				menu.availabilityStatus !== 'unavailable' &&
				!isOverrideOff(overrides, menu.id) &&
				isSoldOn(options.channel, {
					menu,
					override: overrides.get(menu.id),
				}),
		)
		.flatMap((menu) =>
			menu.categories
				.filter(
					(category) =>
						category.availabilityStatus !== 'unavailable' &&
						!category.parentId &&
						!isOverrideOff(overrides, category.id) &&
						isSoldOn(options.channel, {
							category,
							override: overrides.get(category.id),
						}),
				)
				.map(upsellCategory),
		)
}

export function collectUnavailableVariantIds(
	payload: PublicSiteMenuPayload | null | undefined,
): string[] {
	const ids = new Set<string>()
	const walk = (
		category: PublicSiteMenuPayload['menus'][number]['categories'][number],
	) => {
		for (const item of category.items ?? []) {
			for (const variant of item.variations?.variants ?? []) {
				if (variant.availabilityStatus === 'unavailable') {
					ids.add(variant.id)
				}
			}
		}
		for (const child of category.subcategories ?? []) walk(child)
	}
	for (const menu of payload?.menus ?? []) {
		for (const category of menu.categories ?? []) walk(category)
	}
	return [...ids]
}

/**
 * Filters an already-loaded `OrderingCategory[]` list client-side when channel
 * changes before (or without) a network refetch.
 */
export function filterOrderingCategoriesForChannel(
	categories: readonly OrderingCategory[],
	channel: MenuChannel,
): OrderingCategory[] {
	const filterCat = (category: OrderingCategory): OrderingCategory | null => {
		if (!isSoldOn(channel, { category })) return null
		const items = (category.items ?? []).filter((item) =>
			isSoldOn(channel, { item }),
		)
		const subcategories = (category.subcategories ?? [])
			.map(filterCat)
			.filter((sub): sub is OrderingCategory => sub !== null)
		const total =
			items.length +
			subcategories.reduce(
				(sum, sub) =>
					sum +
					sub.items.length +
					(sub.subcategories ?? []).reduce((s, c) => s + c.items.length, 0),
				0,
			)
		if (total === 0) return null
		return { ...category, items, subcategories }
	}
	return categories
		.map(filterCat)
		.filter((cat): cat is OrderingCategory => cat !== null)
}

export function syncMenuCatalogInPlace(
	catalog: CatalogIndex,
	categories: OrderingCategory[],
): void {
	catalog.items.clear()
	catalog.categories.clear()
	catalog.itemCategoryIds.clear()

	const walk = (category: OrderingCategory, ancestors: string[]) => {
		const path = [...ancestors, category.id]
		catalog.categories.set(category.id, category)
		for (const item of category.items ?? []) {
			if (!catalog.items.has(item.id)) catalog.items.set(item.id, item)
			const existing = catalog.itemCategoryIds.get(item.id) ?? []
			catalog.itemCategoryIds.set(
				item.id,
				Array.from(new Set([...existing, ...path])),
			)
		}
		for (const sub of category.subcategories ?? []) walk(sub, path)
	}
	for (const category of categories) walk(category, [])
}

function createMenuItemCardElement(
	doc: Document,
	item: OrderingItem,
	options: {
		formatMoney: (amount: number) => string
		fromLabel: string
		soldOutLabel: string
		popularLabel: string
	},
): HTMLLIElement {
	const soldOut = isItemSoldOut(item)
	const li = doc.createElement('li')
	li.className = [
		'js-item-card group relative flex min-h-36 gap-4 rounded-xl border p-4 [&.hidden]:hidden',
		soldOut
			? 'border-dashed border-border bg-muted/40'
			: 'surface surface-interactive cursor-pointer',
	].join(' ')
	li.dataset.itemId = item.id
	li.dataset.soldOut = soldOut ? 'true' : 'false'
	li.dataset.search =
		`${item.displayName} ${item.description ?? ''}`.toLocaleLowerCase()
	li.dataset.diet = (item.dietaryTags ?? []).join(' ')
	if (soldOut) li.setAttribute('aria-disabled', 'true')

	const body = doc.createElement('div')
	body.className = 'flex min-w-0 flex-1 flex-col'

	const h3 = doc.createElement('h3')
	h3.className = [
		'text-base leading-snug font-semibold text-pretty sm:text-lg sm:leading-snug',
		soldOut ? 'text-muted-foreground' : 'text-foreground',
	].join(' ')

	const btn = doc.createElement('button')
	btn.type = 'button'
	btn.className =
		"js-item-open block w-full text-start after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring disabled:cursor-default"
	btn.setAttribute('aria-haspopup', 'dialog')
	btn.disabled = soldOut

	const nameSpan = doc.createElement('span')
	nameSpan.className = 'line-clamp-2'
	nameSpan.textContent = item.displayName
	btn.appendChild(nameSpan)
	h3.appendChild(btn)
	body.appendChild(h3)

	if (item.description) {
		const desc = doc.createElement('p')
		desc.className =
			'mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground'
		desc.textContent = item.description
		body.appendChild(desc)
	}

	if (item.isPopular && !soldOut && options.popularLabel) {
		const meta = doc.createElement('div')
		meta.className = 'mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5'
		const badge = doc.createElement('span')
		badge.className = 'badge tone-brand'
		badge.textContent = options.popularLabel
		meta.appendChild(badge)
		body.appendChild(meta)
	}

	const footer = doc.createElement('div')
	footer.className = 'mt-auto flex items-end justify-between gap-3 pt-3'
	if (soldOut) {
		const badge = doc.createElement('span')
		badge.className = 'badge tone-solid'
		badge.textContent = options.soldOutLabel
		footer.appendChild(badge)
	} else {
		const priceBlock = doc.createElement('span')
		priceBlock.className = 'js-price-block inline-flex items-baseline gap-1.5'
		if (itemHasPriceRange(item)) {
			const from = doc.createElement('span')
			from.className = 'text-sm text-muted-foreground'
			from.textContent = options.fromLabel
			priceBlock.appendChild(from)
		}
		const priceWrap = doc.createElement('span')
		priceWrap.className =
			'price font-heading text-lg leading-none text-foreground'
		const priceNow = doc.createElement('span')
		priceNow.className = 'js-price-now'
		priceNow.textContent = options.formatMoney(lowestAvailablePrice(item))
		priceWrap.appendChild(priceNow)
		priceBlock.appendChild(priceWrap)
		footer.appendChild(priceBlock)

		const soldBadge = doc.createElement('span')
		soldBadge.className = 'js-sold-out-badge badge tone-solid'
		soldBadge.hidden = true
		soldBadge.textContent = options.soldOutLabel
		footer.appendChild(soldBadge)

		const dailyLeft = doc.createElement('span')
		dailyLeft.className = 'js-daily-left badge tone-warning'
		dailyLeft.hidden = true
		footer.appendChild(dailyLeft)
	}
	body.appendChild(footer)
	li.appendChild(body)

	if (item.imageUrl) {
		const thumb = doc.createElement('div')
		thumb.className =
			'relative size-28 shrink-0 self-start overflow-hidden rounded-lg bg-placeholder sm:size-32'
		const img = doc.createElement('img')
		img.src = item.imageUrl
		img.alt = ''
		img.loading = 'lazy'
		img.decoding = 'async'
		img.width = 128
		img.height = 128
		decorateDishPhoto(img, {
			itemId: item.id,
			focal: item.imageFocal,
			test: item.photoTest,
		})
		img.className = [
			'size-full object-cover transition-transform duration-300 ease-out motion-reduce:transition-none',
			soldOut ? 'opacity-50 grayscale' : 'group-hover:scale-103',
		].join(' ')
		thumb.appendChild(img)
		li.appendChild(thumb)
	}
	return li
}

/**
 * Synchronizes the rendered menu DOM (category sections, item cards, nav links,
 * and popular rail) to match `categories` for the active channel.
 * Preserves existing SSR cards where present, removes items not sold on this
 * channel, and creates cards/sections for channel-only items (e.g. `qr`-only).
 */
export function syncMenuDomForChannel(
	doc: Document,
	categories: readonly OrderingCategory[],
	options: {
		formatMoney: (amount: number) => string
		fromLabel: string
		soldOutLabel: string
		popularLabel: string
	},
): void {
	const sectionsRoot = doc.querySelector<HTMLElement>('[data-menu-categories]')
	const existingCards = new Map<string, HTMLElement>()
	for (const card of doc.querySelectorAll<HTMLElement>('.js-item-card')) {
		const id = card.dataset.itemId
		if (id && !existingCards.has(id)) existingCards.set(id, card)
	}

	const activeItemIds = new Set<string>()
	const activeCategoryIds = new Set<string>()
	const popularItemIds = new Set<string>()

	const collectIds = (cat: OrderingCategory) => {
		activeCategoryIds.add(cat.id)
		for (const item of cat.items ?? []) {
			activeItemIds.add(item.id)
			if (item.isPopular) popularItemIds.add(item.id)
		}
		for (const sub of cat.subcategories ?? []) collectIds(sub)
	}
	for (const cat of categories) collectIds(cat)

	// Update popular rail visibility
	const popularRail = doc.querySelector<HTMLElement>('[data-popular-rail]')
	if (popularRail) {
		let visiblePopular = 0
		for (const card of popularRail.querySelectorAll<HTMLElement>(
			'.js-popular-card',
		)) {
			const id = card.dataset.itemId
			const keep = Boolean(id && popularItemIds.has(id))
			card.hidden = !keep
			card.classList.toggle('hidden', !keep)
			if (keep) visiblePopular += 1
		}
		popularRail.hidden = visiblePopular < 2
	}

	if (!sectionsRoot) return

	const syncItemList = (
		listEl: HTMLUListElement,
		items: readonly OrderingItem[],
	) => {
		const targetNodes: HTMLElement[] = []
		for (const item of items) {
			const existing = existingCards.get(item.id)
			if (existing) {
				existing.hidden = false
				existing.classList.remove('hidden')
				targetNodes.push(existing)
			} else {
				const created = createMenuItemCardElement(doc, item, options)
				existingCards.set(item.id, created)
				targetNodes.push(created)
			}
		}
		listEl.replaceChildren(...targetNodes)
	}

	// Remove sections for categories not in the active channel
	const existingSections = new Map<string, HTMLElement>()
	for (const section of sectionsRoot.querySelectorAll<HTMLElement>(
		'[data-category-section]',
	)) {
		const catId = section.id.replace(/^category-/, '')
		if (!activeCategoryIds.has(catId)) {
			section.remove()
		} else {
			existingSections.set(catId, section)
		}
	}

	for (const category of categories) {
		let section = existingSections.get(category.id)
		if (!section) {
			section = doc.createElement('section')
			section.id = `category-${category.id}`
			section.setAttribute('data-category-section', '')
			section.className =
				'mt-12 first-of-type:mt-0 sm:mt-14 scroll-mt-32 focus:outline-none lg:scroll-mt-28'
			section.setAttribute('aria-labelledby', `category-${category.id}-title`)

			const header = doc.createElement('header')
			header.className = 'mb-4 sm:mb-5'
			const h2 = doc.createElement('h2')
			h2.id = `category-${category.id}-title`
			h2.className =
				'text-2xl font-bold tracking-tight text-foreground sm:text-3xl'
			h2.textContent = category.displayName
			header.appendChild(h2)
			if (category.description) {
				const p = doc.createElement('p')
				p.className =
					'mt-1.5 line-clamp-2 max-w-2xl text-sm leading-relaxed text-muted-foreground'
				p.textContent = category.description
				header.appendChild(p)
			}
			section.appendChild(header)
			sectionsRoot.appendChild(section)
			existingSections.set(category.id, section)
		}

		// Sync direct items list
		let directList = section.querySelector<HTMLUListElement>(':scope > ul')
		if (category.items.length > 0) {
			if (!directList) {
				directList = doc.createElement('ul')
				directList.className = 'grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4'
				const firstSub = section.querySelector('[data-category-group]')
				if (firstSub) section.insertBefore(directList, firstSub)
				else section.appendChild(directList)
			}
			syncItemList(directList, category.items)
		} else if (directList) {
			directList.remove()
		}

		// Sync subcategories (groups)
		const existingGroups = new Map<string, HTMLElement>()
		for (const group of section.querySelectorAll<HTMLElement>(
			'[data-category-group]',
		)) {
			const groupId = group.id.replace(/^category-/, '')
			existingGroups.set(groupId, group)
		}

		const renderSubcategory = (
			parentEl: HTMLElement,
			sub: OrderingCategory,
			headingTag: 'h3' | 'h4',
		) => {
			let group = existingGroups.get(sub.id)
			if (!group) {
				group = doc.createElement('div')
				group.id = `category-${sub.id}`
				group.setAttribute('data-category-group', '')
				group.className =
					headingTag === 'h3'
						? 'mt-8 scroll-mt-32 focus:outline-none lg:scroll-mt-28'
						: 'mt-6 scroll-mt-32 focus:outline-none lg:scroll-mt-28'
				const h = doc.createElement(headingTag)
				h.className =
					headingTag === 'h3'
						? 'mb-3 text-base font-semibold text-foreground'
						: 'mb-2 text-sm font-semibold text-foreground'
				h.textContent = sub.displayName
				group.appendChild(h)
				parentEl.appendChild(group)
			}
			let subList = group.querySelector<HTMLUListElement>(':scope > ul')
			if (sub.items.length > 0) {
				if (!subList) {
					subList = doc.createElement('ul')
					subList.className = 'grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4'
					group.appendChild(subList)
				}
				syncItemList(subList, sub.items)
			} else if (subList) {
				subList.remove()
			}
			for (const nested of sub.subcategories ?? []) {
				renderSubcategory(group, nested, 'h4')
			}
		}

		for (const [groupId, group] of existingGroups) {
			if (!activeCategoryIds.has(groupId)) group.remove()
		}
		for (const sub of category.subcategories ?? []) {
			renderSubcategory(section, sub, 'h3')
		}
	}

	// Sync category navigation links
	for (const nav of doc.querySelectorAll<HTMLElement>('[data-category-nav]')) {
		const isRail = nav.dataset.categoryNav === 'rail'
		const existingLinks = new Map<string, HTMLAnchorElement>()
		for (const link of nav.querySelectorAll<HTMLAnchorElement>(
			'a[data-category-id]',
		)) {
			const id = link.dataset.categoryId
			if (id) existingLinks.set(id, link)
		}
		const nextLinks: HTMLAnchorElement[] = []
		for (const category of categories) {
			let link = existingLinks.get(category.id)
			if (!link) {
				link = doc.createElement('a')
				link.href = `#category-${category.id}`
				link.dataset.categoryId = category.id
				link.className = isRail
					? 'block min-h-11 truncate rounded-md px-3 py-3 text-sm font-medium text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground focus-ring motion-reduce:transition-none aria-[current=true]:bg-muted aria-[current=true]:text-foreground'
					: "relative inline-flex min-h-11 shrink-0 items-center px-3 text-sm font-semibold whitespace-nowrap text-muted-foreground transition-colors duration-150 ease-out after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary after:opacity-0 after:transition-opacity after:content-[''] hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none motion-reduce:after:transition-none aria-[current=true]:text-foreground aria-[current=true]:after:opacity-100 [&.hidden]:hidden"
				link.textContent = category.displayName
			}
			link.classList.remove('hidden')
			nextLinks.push(link)
		}
		nav.replaceChildren(...nextLinks)
	}

	const emptyCatalog = doc.getElementById('menu-empty-catalog')
	const catalogGrid = doc.getElementById('menu-catalog-grid')
	if (emptyCatalog && catalogGrid) {
		const empty = categories.length === 0
		emptyCatalog.hidden = !empty
		emptyCatalog.classList.toggle('hidden', !empty)
		catalogGrid.hidden = empty
		catalogGrid.classList.toggle('hidden', empty)
	}

	// Keep unused parameter warning away if no items needed PriceBook/OrderLimit
	void activeItemIds
}

export function buildChannelCheckoutSync(
	payload: PublicSiteMenuPayload,
	options: {
		channel: MenuChannel
		locationId: string | null
		locale: string
		defaultLocale: string
		resolveImageUrl: (src: string | null | undefined) => string | null
	},
): {
	upsellCategories: OrderingCategory[]
	priceBook: PriceBook
	orderLimits: OrderLimitMeta
	unavailableVariantIds: string[]
} {
	return {
		upsellCategories: buildChannelUpsellCategories(payload, options),
		priceBook: buildPriceBook(payload, options.locationId),
		orderLimits: orderLimitMetaFromMenus(payload.menus ?? []),
		unavailableVariantIds: collectUnavailableVariantIds(payload),
	}
}

export { parseMenuChannels }
