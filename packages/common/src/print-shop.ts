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

export const PRINT_PRODUCT_KEYS = [
	'table_card',
	'poster',
	'flyer',
	'table_tent',
	'window_sticker',
] as const
export type PrintProductKey = (typeof PRINT_PRODUCT_KEYS)[number]

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
	/** Cards carry one QR per table and little text; pages carry more. */
	family: 'card' | 'page'
	/** Has a shipped (vendor) version; the rest are print-it-yourself. */
	shippable: boolean
	sizes: PrintSize[]
	/** Table tents fold: the artwork repeats upside down on the back panel. */
	folded?: boolean
	/** Featured menu items fit on this product. */
	featuredItems: boolean
}

export const PRINT_PRODUCTS: Record<PrintProductKey, PrintProduct> = {
	table_card: {
		key: 'table_card',
		family: 'card',
		shippable: true,
		featuredItems: false,
		sizes: [
			{ key: 'a6', widthMm: 105, heightMm: 148, label: 'A6 · 105 × 148 mm' },
			{ key: '4x6', widthMm: 102, heightMm: 152, label: '4 × 6 in' },
		],
	},
	poster: {
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
	flyer: {
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
	table_tent: {
		key: 'table_tent',
		family: 'card',
		shippable: false,
		folded: true,
		featuredItems: false,
		sizes: [
			{ key: '4x6', widthMm: 102, heightMm: 152, label: '4 × 6 in (folded)' },
		],
	},
	window_sticker: {
		key: 'window_sticker',
		family: 'card',
		shippable: false,
		featuredItems: false,
		sizes: [
			{ key: '200sq', widthMm: 200, heightMm: 200, label: '200 × 200 mm' },
		],
	},
}

export function getPrintSize(
	product: PrintProductKey,
	sizeKey: string,
): PrintSize | null {
	return (
		PRINT_PRODUCTS[product].sizes.find((size) => size.key === sizeKey) ?? null
	)
}

/** Bleed of the professional download; vendors may ask for their own. */
export const PRINT_DEFAULT_BLEED_MM = 3
/** Content keeps this far inside the trim. */
export const PRINT_SAFE_MM = 5

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

export const PRINT_MAX_FEATURED_ITEMS = 4
export const PRINT_MAX_TABLES_PER_DESIGN = 200
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

/** Where a print's QR code leads. Tokens are never stored on the design. */
export const printQrTargetSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('table'),
		tableIds: z
			.array(z.string().trim().min(1).max(100))
			.min(1)
			.max(PRINT_MAX_TABLES_PER_DESIGN),
	}),
	z.strictObject({
		kind: z.literal('menu'),
		locationId: z.string().trim().min(1).max(100),
	}),
	z.strictObject({
		kind: z.literal('reservations'),
		locationId: z.string().trim().min(1).max(100).nullable(),
	}),
	z.strictObject({
		kind: z.literal('site'),
		/** A path on the org's own site: never an external URL. */
		path: z
			.string()
			.trim()
			.max(200)
			.regex(/^\/(?!\/)[A-Za-z0-9\-._~/%?=&]*$/, 'Use a path on your site'),
	}),
	z.strictObject({ kind: z.literal('none') }),
])
export type PrintQrTarget = z.infer<typeof printQrTargetSchema>

const localizedText = (max: number) =>
	z.record(z.string().min(2).max(10), z.string().trim().max(max))

export const printDesignContentSchema = z.strictObject({
	/** One or two of the org's site locales; the first is the main language. */
	locales: z.array(z.string().min(2).max(10)).min(1).max(2),
	headline: localizedText(PRINT_TEXT_MAX.headline),
	body: localizedText(PRINT_TEXT_MAX.body),
	callToAction: localizedText(PRINT_TEXT_MAX.callToAction),
	qr: printQrTargetSchema,
	featuredItemIds: z
		.array(z.string().min(1).max(100))
		.max(PRINT_MAX_FEATURED_ITEMS)
		.default([]),
	/** Location whose address and menu prices the print shows. */
	locationId: z.string().min(1).max(100).nullable(),
	showAddress: z.boolean().default(true),
	showWebsite: z.boolean().default(true),
})
export type PrintDesignContent = z.infer<typeof printDesignContentSchema>

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
	/** "Table" in this locale, before the label on a table card. */
	tableWord: string
}

/** One printed piece (a table card per table; one page otherwise). */
export type PrintPiece = {
	/** Table label on a table card, else null. */
	tableLabel: string | null
	qrUrl: string | null
}

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
	pieces: PrintPiece[]
	/** Menu facts the stale check compares on re-order. */
	facts: {
		featured: Array<{ id: string; name: string; price: string }>
		tables: Array<{ id: string; label: string; tokenVersion: number }>
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

type CopyKey =
	| 'scanToOrder'
	| 'scanForMenu'
	| 'scanToBook'
	| 'scanToVisit'
	| 'orderAtTable'
	| 'orderAhead'
	| 'bookTable'
	| 'visitUs'
	| 'table'

const COPY: Record<string, Record<CopyKey, string>> = {
	en: {
		scanToOrder: 'Scan to order',
		scanForMenu: 'Scan for our menu',
		scanToBook: 'Scan to book',
		scanToVisit: 'Scan to visit us',
		orderAtTable: 'Order and pay from your phone',
		orderAhead: 'Order ahead, skip the line',
		bookTable: 'Book your table',
		visitUs: 'Visit us online',
		table: 'Table',
	},
	ar: {
		scanToOrder: 'امسح للطلب',
		scanForMenu: 'امسح لعرض القائمة',
		scanToBook: 'امسح للحجز',
		scanToVisit: 'امسح لزيارتنا',
		orderAtTable: 'اطلب وادفع من هاتفك',
		orderAhead: 'اطلب مسبقًا ووفّر وقت الانتظار',
		bookTable: 'احجز طاولتك',
		visitUs: 'زورونا على الإنترنت',
		table: 'طاولة',
	},
	es: {
		scanToOrder: 'Escanea para pedir',
		scanForMenu: 'Escanea para ver el menú',
		scanToBook: 'Escanea para reservar',
		scanToVisit: 'Escanea para visitarnos',
		orderAtTable: 'Pide y paga desde tu móvil',
		orderAhead: 'Pide con antelación y evita la fila',
		bookTable: 'Reserva tu mesa',
		visitUs: 'Visítanos en línea',
		table: 'Mesa',
	},
	fr: {
		scanToOrder: 'Scannez pour commander',
		scanForMenu: 'Scannez pour voir le menu',
		scanToBook: 'Scannez pour réserver',
		scanToVisit: 'Scannez pour nous rendre visite',
		orderAtTable: 'Commandez et payez depuis votre téléphone',
		orderAhead: 'Commandez à l’avance, sans attendre',
		bookTable: 'Réservez votre table',
		visitUs: 'Retrouvez-nous en ligne',
		table: 'Table',
	},
	de: {
		scanToOrder: 'Scannen und bestellen',
		scanForMenu: 'Scannen für die Speisekarte',
		scanToBook: 'Scannen und reservieren',
		scanToVisit: 'Scannen und besuchen',
		orderAtTable: 'Mit dem Handy bestellen und bezahlen',
		orderAhead: 'Vorbestellen statt anstehen',
		bookTable: 'Tisch reservieren',
		visitUs: 'Besuchen Sie uns online',
		table: 'Tisch',
	},
	zh: {
		scanToOrder: '扫码点餐',
		scanForMenu: '扫码查看菜单',
		scanToBook: '扫码预订',
		scanToVisit: '扫码访问我们',
		orderAtTable: '用手机点餐和付款',
		orderAhead: '提前点餐，免排队',
		bookTable: '预订餐桌',
		visitUs: '在线访问我们',
		table: '桌号',
	},
}

export const PRINT_COPY_LOCALES = Object.keys(COPY)

export function printCopy(locale: string, key: CopyKey): string {
	const base = locale.split('-')[0]!.toLowerCase()
	return (COPY[base] ?? COPY.en!)[key]
}

/** Default headline and QR caption for a target, in one locale. */
export function defaultPrintCopy(
	locale: string,
	target: PrintQrTarget['kind'],
): { headline: string; callToAction: string; qrCaption: string } {
	switch (target) {
		case 'table':
			return {
				headline: printCopy(locale, 'scanToOrder'),
				callToAction: printCopy(locale, 'orderAtTable'),
				qrCaption: printCopy(locale, 'scanToOrder'),
			}
		case 'menu':
			return {
				headline: printCopy(locale, 'orderAhead'),
				callToAction: printCopy(locale, 'scanForMenu'),
				qrCaption: printCopy(locale, 'scanToOrder'),
			}
		case 'reservations':
			return {
				headline: printCopy(locale, 'bookTable'),
				callToAction: printCopy(locale, 'scanToBook'),
				qrCaption: printCopy(locale, 'scanToBook'),
			}
		default:
			return {
				headline: printCopy(locale, 'visitUs'),
				callToAction: printCopy(locale, 'scanToVisit'),
				qrCaption: printCopy(locale, 'scanToVisit'),
			}
	}
}

/** Which QR targets a product accepts. */
export function printTargetsFor(
	product: PrintProductKey,
): ReadonlyArray<PrintQrTarget['kind']> {
	if (product === 'table_card' || product === 'table_tent') {
		return ['table', 'menu', 'reservations', 'site']
	}
	return ['menu', 'reservations', 'site', 'none']
}

// ---------------------------------------------------------------------------
// Shipped orders (US only in v1)
// ---------------------------------------------------------------------------

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
	recipientName: z
		.string()
		.trim()
		.min(2, 'Enter who receives the parcel')
		.max(80),
	recipientPhone: z
		.string()
		.trim()
		.regex(/^\+?[\d\s\-().]{7,25}$/, 'Enter a phone number for the carrier'),
	line1: z.string().trim().min(3, 'Enter a street address').max(120),
	line2: z.string().trim().max(120).optional(),
	city: z.string().trim().min(2, 'Enter a city').max(80),
	state: z.enum(PRINT_US_STATES, { message: 'Choose a state' }),
	postalCode: z
		.string()
		.trim()
		.regex(/^\d{5}(-\d{4})?$/, 'Enter a 5-digit ZIP code'),
	country: z.literal('US'),
})
export type PrintShippingAddress = z.infer<typeof printShippingAddressSchema>

export const printOrderLineSchema = z.strictObject({
	designId: z.string().min(1).max(100),
	/** Copies of every piece (a table-card set prints each table this many times). */
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
export const PRINT_VENDOR_CHECK_HOLDS: readonly string[] = [
	'vendor_unknown',
	'stale_claim',
	'submission_error',
]
