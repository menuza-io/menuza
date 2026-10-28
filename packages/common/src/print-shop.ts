import { z } from 'zod'

/**
 * Print shop: branded print templates operators design in the App and either
 * download as a print-ready PDF or order shipped. Shared, PII-free catalog,
 * flags and design schemas for App and Admin. Physical sizes are millimetres;
 * money is integer cents.
 */

// ---------------------------------------------------------------------------
// Feature flags (control plane ConfigFlag, default off, only literal `true`)
// ---------------------------------------------------------------------------

export const PRINT_SHOP_FLAG_KEYS = {
	enabled: 'print_shop.enabled',
	shipping: 'print_shop.shipping',
} as const

export type PrintShopFeatures = { enabled: boolean; shipping: boolean }

export function foldPrintShopFeatures(raw: {
	enabled?: unknown
	shipping?: unknown
}): PrintShopFeatures {
	const enabled = raw.enabled === true
	return { enabled, shipping: enabled && raw.shipping === true }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * A product key. The core ships posters, flyers and window stickers; a
 * vertical adds its own through `createPrintCatalog` (see
 * `print-shop-catalog.ts`). Keys are stored on designs and orders: keep them
 * stable once used.
 */
export type PrintProductKey = string

export const PRINT_TEMPLATE_STYLES = ['classic', 'bold', 'minimal'] as const
export type PrintTemplateStyle = (typeof PRINT_TEMPLATE_STYLES)[number]

/** Bump when a template's layout changes; saved designs pin the version. */
export const PRINT_TEMPLATE_VERSION = 1

export type PrintSize = {
	key: string
	widthMm: number
	heightMm: number
	/** Shown to operators as-is (dimensions are not translated). */
	label: string
}

export type PrintProduct = {
	key: PrintProductKey
	/** Cards carry one QR per piece and little text; pages carry more. */
	family: 'card' | 'page'
	/** Has a shipped (vendor) version; the rest are print-it-yourself. */
	shippable: boolean
	sizes: PrintSize[]
	/** Folded cards repeat the artwork upside down on the back panel. */
	folded?: boolean
	/** Featured items (from the vertical's item source) fit on this product. */
	featuredItems: boolean
	/**
	 * QR targets this product accepts, in the order the editor lists them.
	 * Default: every single-piece target, then "no QR code".
	 */
	qrTargets?: readonly string[]
}

const CORE_PRODUCTS: PrintProduct[] = [
	{
		key: 'poster',
		family: 'page',
		shippable: true,
		featuredItems: true,
		sizes: [
			{ key: 'a3', widthMm: 297, heightMm: 420, label: 'A3 · 297 × 420 mm' },
			{ key: 'a2', widthMm: 420, heightMm: 594, label: 'A2 · 420 × 594 mm' },
			{ key: '18x24', widthMm: 457, heightMm: 610, label: '18 × 24 in' },
		],
	},
	{
		key: 'flyer',
		family: 'page',
		shippable: true,
		featuredItems: true,
		sizes: [
			{ key: 'a5', widthMm: 148, heightMm: 210, label: 'A5 · 148 × 210 mm' },
			{ key: 'a4', widthMm: 210, heightMm: 297, label: 'A4 · 210 × 297 mm' },
			{ key: 'letter', widthMm: 216, heightMm: 279, label: 'US Letter' },
		],
	},
	{
		key: 'window_sticker',
		family: 'card',
		shippable: false,
		featuredItems: false,
		sizes: [
			{ key: '200sq', widthMm: 200, heightMm: 200, label: '200 × 200 mm' },
		],
	},
]

/** Bleed of the professional download; vendors may ask for their own. */
export const PRINT_DEFAULT_BLEED_MM = 3
/** Content keeps this far inside the trim. */
export const PRINT_SAFE_MM = 5

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

export const PRINT_MAX_FEATURED_ITEMS = 4
/** Pieces one design may print (a card per seat, desk or booth). */
export const PRINT_MAX_PIECES_PER_DESIGN = 200
export const PRINT_TEXT_MAX = {
	headline: 80,
	body: 280,
	callToAction: 60,
} as const

export const PRINT_DOWNLOAD_FORMATS = ['home', 'pro'] as const
export type PrintDownloadFormat = (typeof PRINT_DOWNLOAD_FORMATS)[number]

export const PRINT_HOME_SHEETS = ['letter', 'a4'] as const
export type PrintHomeSheet = (typeof PRINT_HOME_SHEETS)[number]
export const PRINT_HOME_SHEET_SIZES: Record<
	PrintHomeSheet,
	{ widthMm: number; heightMm: number }
> = {
	letter: { widthMm: 216, heightMm: 279 },
	a4: { widthMm: 210, heightMm: 297 },
}

/**
 * Where a print's QR code leads. The core has a page of the organization's
 * own site and no QR code; a vertical adds kinds of its own. Codes and
 * tokens are never stored on the design: the vertical resolves them when the
 * proof is drawn or approved.
 */
export type PrintQrTarget = { kind: string } & Record<string, unknown>

export type PrintTargetCopy = {
	headline: string
	callToAction: string
	qrCaption: string
}

export type PrintQrTargetSpec = {
	kind: string
	/** A strict object with `kind: z.literal(kind)`. */
	schema: z.ZodType<PrintQrTarget>
	/** Resolves to one piece per item (a card each), not a single page. */
	perPiece?: boolean
	/** Default words for this target, in one locale. */
	copy(locale: string): PrintTargetCopy
	/** Word printed before a piece's label, in one locale ("Desk 4"). */
	pieceWord?(locale: string): string
}

/** Path on the org's own site: never an external URL. */
export const printSitePathSchema = z
	.string()
	.trim()
	.max(200)
	.regex(/^\/(?!\/)[A-Za-z0-9\-._~/%?=&]*$/, 'Use a path on your site')

const SITE_TARGET: PrintQrTargetSpec = {
	kind: 'site',
	schema: z.strictObject({
		kind: z.literal('site'),
		path: printSitePathSchema,
	}),
	copy: (locale) => ({
		headline: printCopy(locale, 'visitUs'),
		callToAction: printCopy(locale, 'scanToVisit'),
		qrCaption: printCopy(locale, 'scanToVisit'),
	}),
}

const NO_QR_TARGET: PrintQrTargetSpec = {
	kind: 'none',
	schema: z.strictObject({ kind: z.literal('none') }),
	copy: SITE_TARGET.copy,
}

/** The path of a site target, or null for any other kind. */
export function printSitePath(target: PrintQrTarget): string | null {
	return target.kind === 'site' && typeof target.path === 'string'
		? target.path
		: null
}

const localizedText = (max: number) =>
	z.record(z.string().min(2).max(10), z.string().trim().max(max))

export type PrintDesignContent = {
	/** One or two of the org's site locales; the first is the main language. */
	locales: string[]
	headline: Record<string, string>
	body: Record<string, string>
	callToAction: Record<string, string>
	qr: PrintQrTarget
	featuredItemIds: string[]
	/** The vertical's scope whose address and item prices the print shows. */
	scopeId: string | null
	showAddress: boolean
	showWebsite: boolean
}

/**
 * Everything a template needs, resolved at proof or approval time. The
 * approved snapshot is exactly this, so a re-order reprints what was proofed.
 */
export type PrintBrand = {
	name: string
	logoDataUri: string | null
	background: string
	foreground: string
	muted: string
	primary: string
	primaryForeground: string
	accent: string
	accentForeground: string
	headingFont: string
	bodyFont: string
}

export type PrintFeaturedItem = {
	id: string
	name: string
	price: string
	imageDataUri: string | null
}

export type PrintArtworkCopy = {
	locale: string
	dir: 'ltr' | 'rtl'
	headline: string
	body: string
	callToAction: string
	qrCaption: string
	/** Word before a piece's label in this locale, when the target has one. */
	pieceWord: string | null
}

/** One printed piece (a card per item of a per-piece target; else a page). */
export type PrintPiece = {
	/** Label printed on the piece, or null. */
	label: string | null
	qrUrl: string | null
}

/**
 * A versioned fact behind a piece. A re-order compares these with what the
 * vertical resolves now: a piece removed, renamed or with a renewed code
 * would print something that no longer works.
 */
export type PrintPieceFact = { id: string; label: string; version: number }

export type PrintSnapshot = {
	product: PrintProductKey
	sizeKey: string
	style: PrintTemplateStyle
	templateVersion: number
	brand: PrintBrand
	copy: PrintArtworkCopy[]
	featured: PrintFeaturedItem[]
	address: string | null
	website: string | null
	/** The target as designed (re-resolved for the pre-order check). */
	qr: PrintQrTarget
	pieces: PrintPiece[]
	/** Facts the stale check compares on re-order. */
	facts: {
		featured: Array<{ id: string; name: string; price: string }>
		pieces: PrintPieceFact[]
	}
}

const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur'])
export function localeDirection(locale: string): 'ltr' | 'rtl' {
	return RTL_LOCALES.has(locale.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr'
}

/** UTM tags on every printed QR (no redirect service: prints never break). */
export function printUtmParams(designId: string): Record<string, string> {
	return {
		utm_source: 'print',
		utm_medium: 'qr',
		utm_campaign: designId,
	}
}

// ---------------------------------------------------------------------------
// Default copy per locale (the org's site locales: en, ar, es, fr, de, zh)
// ---------------------------------------------------------------------------

/** Picks a locale's words from words-per-locale, English as the fallback. */
export function localeCopy<Key extends string>(
	byLocale: Record<string, Record<Key, string>>,
	locale: string,
	key: Key,
): string {
	const base = locale.split('-')[0]!.toLowerCase()
	return (byLocale[base] ?? byLocale.en!)[key]
}

type CopyKey = 'scanToVisit' | 'visitUs'

const COPY: Record<string, Record<CopyKey, string>> = {
	en: { scanToVisit: 'Scan to visit us', visitUs: 'Visit us online' },
	ar: { scanToVisit: 'امسح لزيارتنا', visitUs: 'زورونا على الإنترنت' },
	es: { scanToVisit: 'Escanea para visitarnos', visitUs: 'Visítanos en línea' },
	fr: {
		scanToVisit: 'Scannez pour nous rendre visite',
		visitUs: 'Retrouvez-nous en ligne',
	},
	de: {
		scanToVisit: 'Scannen und besuchen',
		visitUs: 'Besuchen Sie uns online',
	},
	zh: { scanToVisit: '扫码访问我们', visitUs: '在线访问我们' },
}

export const PRINT_COPY_LOCALES = Object.keys(COPY)

export function printCopy(locale: string, key: CopyKey): string {
	return localeCopy(COPY, locale, key)
}

// ---------------------------------------------------------------------------
// The catalog a deployment prints (core plus its vertical)
// ---------------------------------------------------------------------------

export type PrintCatalogExtension = {
	/** Extra products. Keys must not repeat a core product's. */
	products?: PrintProduct[]
	/** Product keys in the order the "new print" form lists them. */
	productOrder?: readonly string[]
	/** Extra QR targets. Kinds must not repeat `site` or `none`. */
	qrTargets?: PrintQrTargetSpec[]
}

export type PrintCatalog = {
	products: Readonly<Record<PrintProductKey, PrintProduct>>
	/** Every product key, in listing order. */
	productKeys: readonly PrintProductKey[]
	qrTargets: Readonly<Record<string, PrintQrTargetSpec>>
	isProduct(key: string): boolean
	getSize(product: PrintProductKey, sizeKey: string): PrintSize | null
	/** QR target kinds a product accepts, in editor order. */
	targetsFor(product: PrintProductKey): readonly string[]
	qrTargetSchema: z.ZodType<PrintQrTarget>
	designContentSchema: z.ZodType<PrintDesignContent>
	defaultCopy(locale: string, kind: string): PrintTargetCopy
	pieceWord(locale: string, kind: string): string | null
}

export function createPrintCatalog(
	extension: PrintCatalogExtension = {},
): PrintCatalog {
	const products: Record<string, PrintProduct> = {}
	for (const product of [...CORE_PRODUCTS, ...(extension.products ?? [])]) {
		if (products[product.key]) {
			throw new Error(`Duplicate print product: ${product.key}`)
		}
		products[product.key] = product
	}
	const order = extension.productOrder ?? []
	const productKeys = [
		...order.filter((key) => products[key]),
		...Object.keys(products).filter((key) => !order.includes(key)),
	]

	const targets: Record<string, PrintQrTargetSpec> = {}
	for (const target of [
		...(extension.qrTargets ?? []),
		SITE_TARGET,
		NO_QR_TARGET,
	]) {
		if (targets[target.kind]) {
			throw new Error(`Duplicate print QR target: ${target.kind}`)
		}
		targets[target.kind] = target
	}
	const singlePiece = Object.values(targets)
		.filter((target) => !target.perPiece && target.kind !== 'none')
		.map((target) => target.kind)

	const qrTargetSchema = z
		.object({ kind: z.string().min(1).max(40) })
		.passthrough()
		.superRefine((value, ctx) => {
			const spec = targets[value.kind]
			const parsed = spec?.schema.safeParse(value)
			if (!parsed?.success) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: spec ? 'Invalid QR code target' : 'Unknown QR code target',
					path: parsed?.error.issues[0]?.path ?? ['kind'],
				})
			}
		})
		.transform((value) => targets[value.kind]!.schema.parse(value))

	const designContentSchema = z.strictObject({
		locales: z.array(z.string().min(2).max(10)).min(1).max(2),
		headline: localizedText(PRINT_TEXT_MAX.headline),
		body: localizedText(PRINT_TEXT_MAX.body),
		callToAction: localizedText(PRINT_TEXT_MAX.callToAction),
		qr: qrTargetSchema,
		featuredItemIds: z
			.array(z.string().min(1).max(100))
			.max(PRINT_MAX_FEATURED_ITEMS)
			.default([]),
		scopeId: z.string().min(1).max(100).nullable(),
		showAddress: z.boolean().default(true),
		showWebsite: z.boolean().default(true),
	}) as unknown as z.ZodType<PrintDesignContent>

	return {
		products,
		productKeys,
		qrTargets: targets,
		isProduct: (key) => Object.prototype.hasOwnProperty.call(products, key),
		getSize: (product, sizeKey) =>
			products[product]?.sizes.find((size) => size.key === sizeKey) ?? null,
		targetsFor: (product) =>
			products[product]?.qrTargets?.filter((kind) => targets[kind]) ?? [
				...singlePiece,
				'none',
			],
		qrTargetSchema: qrTargetSchema as unknown as z.ZodType<PrintQrTarget>,
		designContentSchema,
		defaultCopy: (locale, kind) => (targets[kind] ?? SITE_TARGET).copy(locale),
		pieceWord: (locale, kind) => targets[kind]?.pieceWord?.(locale) ?? null,
	}
}

// ---------------------------------------------------------------------------
// Shipped orders (US only in v1)
// ---------------------------------------------------------------------------

/** Print vendors a product and size can be mapped to (Admin catalog). */
export const PRINT_VENDOR_NAMES = ['gelato', 'prodigi'] as const

export const PRINT_MAX_ORDER_LINES = 20
export const PRINT_MAX_COPIES = 500

export const PRINT_US_STATES = [
	'AL',
	'AK',
	'AZ',
	'AR',
	'CA',
	'CO',
	'CT',
	'DE',
	'DC',
	'FL',
	'GA',
	'HI',
	'ID',
	'IL',
	'IN',
	'IA',
	'KS',
	'KY',
	'LA',
	'ME',
	'MD',
	'MA',
	'MI',
	'MN',
	'MS',
	'MO',
	'MT',
	'NE',
	'NV',
	'NH',
	'NJ',
	'NM',
	'NY',
	'NC',
	'ND',
	'OH',
	'OK',
	'OR',
	'PA',
	'RI',
	'SC',
	'SD',
	'TN',
	'TX',
	'UT',
	'VT',
	'VA',
	'WA',
	'WV',
	'WI',
	'WY',
] as const

export const printShippingAddressSchema = z.strictObject({
	// Forms send an empty field as missing: each needs its own message. The
	// messages are codes the App translates (`print-form-errors.ts`).
	recipientName: z
		.string({ required_error: 'recipient_name' })
		.trim()
		.min(2, 'recipient_name')
		.max(80),
	recipientPhone: z
		.string({ required_error: 'recipient_phone' })
		.trim()
		.regex(/^\+?[\d\s\-().]{7,25}$/, 'recipient_phone'),
	line1: z
		.string({ required_error: 'street' })
		.trim()
		.min(3, 'street')
		.max(120),
	line2: z.string().trim().max(120).optional(),
	city: z.string({ required_error: 'city' }).trim().min(2, 'city').max(80),
	state: z.enum(PRINT_US_STATES, { message: 'state' }),
	postalCode: z
		.string({ required_error: 'postal_code' })
		.trim()
		.regex(/^\d{5}(-\d{4})?$/, 'postal_code'),
	country: z.literal('US'),
})
export type PrintShippingAddress = z.infer<typeof printShippingAddressSchema>

export const printOrderLineSchema = z.strictObject({
	designId: z.string().min(1).max(100),
	/** Copies of every piece (a set of cards prints each card this many times). */
	quantity: z.number().int().min(1).max(PRINT_MAX_COPIES),
})

export const PRINT_ORDER_STATUS_VALUES = [
	'quote',
	'awaiting_payment',
	'paid',
	'submitting',
	'cancelling',
	'submitted',
	'in_production',
	'shipped',
	'delivered',
	'held',
	'failed',
	'cancelled',
	'refunded',
] as const
export type PrintOrderStatus = (typeof PRINT_ORDER_STATUS_VALUES)[number]

/** Statuses an operator may still cancel themselves (production not started). */
export const PRINT_SELF_CANCEL_STATUSES: readonly PrintOrderStatus[] = [
	'quote',
	'awaiting_payment',
	'paid',
	'submitted',
	'held',
]

/**
 * Holds where a vendor may have an order we never recorded (a send that
 * timed out, a crashed request). Only Admin, after checking the vendor, may
 * retry, refund or record them; the operator cannot cancel them.
 */
/**
 * Holds after the prints were made and shipped (a parcel back at the vendor,
 * a vendor failure after shipping): Admin reships or refunds; sending again
 * is refused, since nothing is left to send.
 */
export const PRINT_AFTER_SHIPPING_HOLDS: readonly string[] = [
	'vendor_returned',
	'vendor_after_shipping',
]

export const PRINT_VENDOR_CHECK_HOLDS: readonly string[] = [
	'vendor_unknown',
	'stale_claim',
	'submission_error',
]
