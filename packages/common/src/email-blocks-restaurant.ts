import { buildLinkTemplatePath } from './links.ts'
import { z } from 'zod'
import {
	emailBlockIdSchema,
	emailUrlSchema,
	type EmailRenderContext,
} from './email-block-base.ts'

/**
 * The restaurant vertical's email blocks: a dish (or up to three in a row) and
 * a coupon box. Registered in `email-blocks.ts` in one place, the way the print
 * shop registers its vertical, so the generic block core carries no menu words.
 *
 * Dish data is resolved at design time from the live menu and frozen into the
 * stored HTML (a sent email never changes). The block keeps a `snapshot` of what
 * it froze so the editor can tell when the menu has moved on since.
 */

export const EMAIL_MENU_ITEM_MAX = 3
export const EMAIL_COUPON_STYLES = ['box', 'ticket'] as const
export type EmailCouponStyle = (typeof EMAIL_COUPON_STYLES)[number]

const itemIdSchema = z.string().min(1).max(100)

/** One dish as it was when the email was saved. */
export const emailMenuItemSnapshotItemSchema = z.object({
	itemId: itemIdSchema,
	name: z.string().max(200),
	description: z.string().max(500).default(''),
	/** Price at the chosen location (or the base price), in minor units. */
	priceMinor: z.number().int().min(0).max(100_000_000).nullable(),
	currency: z.string().max(3).default(''),
	/** Menu photo URL (absolute or an App-relative path), before any transform. */
	imageUrl: emailUrlSchema.default(''),
	/** Where the Order button goes, relative to the site origin (`/menu?item=…`). */
	path: z
		.string()
		.max(500)
		.refine((value) => value === '' || /^\/(?!\/)/.test(value), {
			message: 'Path must be relative',
		})
		.default(''),
})
export type EmailMenuItemSnapshotItem = z.infer<
	typeof emailMenuItemSnapshotItemSchema
>

export const emailMenuItemSnapshotSchema = z.object({
	resolvedAt: z.string().max(40).default(''),
	items: z.array(emailMenuItemSnapshotItemSchema).max(EMAIL_MENU_ITEM_MAX),
})
export type EmailMenuItemSnapshot = z.infer<typeof emailMenuItemSnapshotSchema>

export const emailMenuItemBlockSchema = z.object({
	id: emailBlockIdSchema,
	type: z.literal('menu_item'),
	config: z.object({
		itemIds: z.array(itemIdSchema).max(EMAIL_MENU_ITEM_MAX).default([]),
		/** One location's prices; null means the base price. */
		locationId: z.string().max(100).nullable().default(null),
		showPrice: z.boolean().default(true),
		showDescription: z.boolean().default(true),
		snapshot: emailMenuItemSnapshotSchema.nullable().default(null),
	}),
})

export const emailCouponBlockSchema = z.object({
	id: emailBlockIdSchema,
	type: z.literal('coupon'),
	config: z.object({
		style: z.enum(EMAIL_COUPON_STYLES).default('box'),
	}),
})

export type EmailMenuItemBlock = z.infer<typeof emailMenuItemBlockSchema>
export type EmailCouponBlock = z.infer<typeof emailCouponBlockSchema>

export const EMAIL_RESTAURANT_BLOCK_TYPES = ['menu_item', 'coupon'] as const
export type EmailRestaurantBlockType =
	(typeof EMAIL_RESTAURANT_BLOCK_TYPES)[number]

export const emailRestaurantBlockSchemas = [
	emailMenuItemBlockSchema,
	emailCouponBlockSchema,
] as const

export function getDefaultRestaurantEmailBlock(
	type: EmailRestaurantBlockType,
	id: string,
): EmailMenuItemBlock | EmailCouponBlock {
	switch (type) {
		case 'menu_item':
			return {
				id,
				type,
				config: {
					itemIds: [],
					locationId: null,
					showPrice: true,
					showDescription: true,
					snapshot: null,
				},
			}
		case 'coupon':
			return { id, type, config: { style: 'box' } }
	}
}

/** What changed on the menu since a block was saved. */
export type MenuItemChange = {
	blockId: string
	itemId: string
	kind: 'price' | 'unavailable'
}

/**
 * The dishes of a block that no longer match the live menu: a different price
 * at the block's location, or a dish that left the live menu (archived,
 * unavailable, hidden at the location). Pure so the editor and the tests share
 * it; `live` is the pickable menu for the block's location.
 */
export function menuItemChanges(
	block: EmailMenuItemBlock,
	live: ReadonlyMap<string, { priceMinor: number | null }>,
): MenuItemChange[] {
	const changes: MenuItemChange[] = []
	for (const frozen of block.config.snapshot?.items ?? []) {
		const now = live.get(frozen.itemId)
		if (!now) {
			changes.push({
				blockId: block.id,
				itemId: frozen.itemId,
				kind: 'unavailable',
			})
		} else if (now.priceMinor !== frozen.priceMinor) {
			changes.push({ blockId: block.id, itemId: frozen.itemId, kind: 'price' })
		}
	}
	return changes
}

/**
 * Block-level problems the pre-send check reports (#232): a dish block with no
 * dish, a coupon block when the message carries no coupon.
 */
export type RestaurantBlockProblem = {
	blockId: string
	code: 'empty_menu_item' | 'empty_coupon'
}

export function restaurantBlockProblems(
	block: EmailMenuItemBlock | EmailCouponBlock,
	context: { hasCoupon: boolean },
): RestaurantBlockProblem[] {
	if (block.type === 'menu_item') {
		return block.config.itemIds.length === 0 ||
			(block.config.snapshot?.items.length ?? 0) === 0
			? [{ blockId: block.id, code: 'empty_menu_item' }]
			: []
	}
	return context.hasCoupon ? [] : [{ blockId: block.id, code: 'empty_coupon' }]
}

/** The coupon button URL is a merge-token path, escaped by `replaceMergeTokensInHtml`. */
export const EMAIL_COUPON_BUTTON_PATH = buildLinkTemplatePath('coupon', {
	coupon: '{{couponCode}}',
})

/**
 * A URL on the organization's own site, or '' when the origin is unknown or the
 * path is not relative. Order links and the coupon button go through this, so
 * stored data can never point a button at another host.
 */
export function emailSiteUrl(
	context: Pick<EmailRenderContext, 'siteOrigin'>,
	path: string,
): string {
	const origin = context.siteOrigin?.trim().replace(/\/+$/, '')
	if (!origin || !/^https?:\/\//i.test(origin)) return ''
	if (!/^\/(?!\/)/.test(path)) return ''
	return `${origin}${path}`
}

/**
 * A menu photo through the image transform at email width: 600 px divided among
 * the dishes in a row, at 2x for sharp screens. Without a transform host (local
 * development) the original URL is used.
 */
export function emailImageUrl(
	src: string,
	options: { columns: number; transformBase?: string | null },
): string {
	const base = options.transformBase?.trim().replace(/\/+$/, '')
	if (!src || !base || !/^https?:\/\//i.test(src)) return src
	const width = Math.round((560 / Math.max(1, options.columns)) * 2)
	let path: string
	try {
		const url = new URL(src)
		path = `${url.pathname}${url.search}`
	} catch {
		return src
	}
	return `${base}/cdn-cgi/image/width=${width},format=jpeg,quality=85${path}`
}

/** `1250` in `USD` as "$12.50", in the email's language. */
export function formatEmailPrice(
	minor: number,
	currency: string,
	locale: string,
): string {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: currency || 'USD',
		}).format(minor / 100)
	} catch {
		return (minor / 100).toFixed(2)
	}
}

const ORDER_LABELS: Record<string, string> = {
	en: 'Order',
	ar: 'اطلب',
	es: 'Pedir',
	fr: 'Commander',
	de: 'Bestellen',
	zh: '订购',
}

/** The Order button label on a dish, in the email's language. */
export function orderButtonLabel(locale: string | undefined): string {
	const language = (locale ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en'
	return ORDER_LABELS[language] ?? ORDER_LABELS.en!
}

const COUPON_BUTTON_LABELS: Record<string, string> = {
	en: 'Use it now',
	ar: 'استخدمه الآن',
	es: 'Úsalo ahora',
	fr: 'Utilisez-le maintenant',
	de: 'Jetzt einlösen',
	zh: '立即使用',
}

/** The coupon block's button label, in the email's language. */
export function couponButtonLabel(locale: string | undefined): string {
	const language = (locale ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en'
	return COUPON_BUTTON_LABELS[language] ?? COUPON_BUTTON_LABELS.en!
}

const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur'])

/** Reading direction for an email in this language. */
export function emailDirectionFor(locale: string | null | undefined) {
	const language = (locale ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en'
	return RTL_LANGUAGES.has(language) ? ('rtl' as const) : ('ltr' as const)
}
