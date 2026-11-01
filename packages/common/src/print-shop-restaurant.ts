import { z } from 'zod'
import {
	localeCopy,
	PRINT_MAX_PIECES_PER_DESIGN,
	type PrintCatalogExtension,
	type PrintQrTarget,
} from './print-shop.ts'

/**
 * The restaurant print vertical's catalog: table QR cards and table tents,
 * and QR codes that open ordering at a table, order-ahead for a location, or
 * table booking. Registered in `print-shop-catalog.ts`; the App side lives in
 * `apps/app/app/utils/print/restaurant/` and `components/print/restaurant/`.
 */

type CopyKey =
	| 'scanToOrder'
	| 'scanForMenu'
	| 'scanToBook'
	| 'orderAtTable'
	| 'orderAhead'
	| 'bookTable'
	| 'table'
	| 'scanForOffer'
	| 'offerHeadline'
	| 'offerCta'
	| 'offerCode'

const COPY: Record<string, Record<CopyKey, string>> = {
	en: {
		scanToOrder: 'Scan to order',
		scanForMenu: 'Scan for our menu',
		scanToBook: 'Scan to book',
		orderAtTable: 'Order and pay from your phone',
		orderAhead: 'Order ahead, skip the line',
		bookTable: 'Book your table',
		table: 'Table',
		scanForOffer: 'Scan for your offer',
		offerHeadline: 'A little something for you',
		offerCta: 'Scan to order. Your code is added for you.',
		offerCode: 'Code',
	},
	ar: {
		scanToOrder: 'امسح للطلب',
		scanForMenu: 'امسح لعرض القائمة',
		scanToBook: 'امسح للحجز',
		orderAtTable: 'اطلب وادفع من هاتفك',
		orderAhead: 'اطلب مسبقًا ووفّر وقت الانتظار',
		bookTable: 'احجز طاولتك',
		table: 'طاولة',
		scanForOffer: 'امسح للحصول على عرضك',
		offerHeadline: 'هدية صغيرة لك',
		offerCta: 'امسح للطلب، وسيُضاف الرمز تلقائيًا.',
		offerCode: 'الرمز',
	},
	es: {
		scanToOrder: 'Escanea para pedir',
		scanForMenu: 'Escanea para ver el menú',
		scanToBook: 'Escanea para reservar',
		orderAtTable: 'Pide y paga desde tu móvil',
		orderAhead: 'Pide con antelación y evita la fila',
		bookTable: 'Reserva tu mesa',
		table: 'Mesa',
		scanForOffer: 'Escanea para tu oferta',
		offerHeadline: 'Un detalle para ti',
		offerCta: 'Escanea para pedir. Tu código se añade solo.',
		offerCode: 'Código',
	},
	fr: {
		scanToOrder: 'Scannez pour commander',
		scanForMenu: 'Scannez pour voir le menu',
		scanToBook: 'Scannez pour réserver',
		orderAtTable: 'Commandez et payez depuis votre téléphone',
		orderAhead: 'Commandez à l’avance, sans attendre',
		bookTable: 'Réservez votre table',
		table: 'Table',
		scanForOffer: 'Scannez pour votre offre',
		offerHeadline: 'Un petit cadeau pour vous',
		offerCta: 'Scannez pour commander. Votre code est ajouté pour vous.',
		offerCode: 'Code',
	},
	de: {
		scanToOrder: 'Scannen und bestellen',
		scanForMenu: 'Scannen für die Speisekarte',
		scanToBook: 'Scannen und reservieren',
		orderAtTable: 'Mit dem Handy bestellen und bezahlen',
		orderAhead: 'Vorbestellen statt anstehen',
		bookTable: 'Tisch reservieren',
		table: 'Tisch',
		scanForOffer: 'Scannen für Ihr Angebot',
		offerHeadline: 'Eine kleine Aufmerksamkeit für Sie',
		offerCta: 'Scannen und bestellen. Der Code ist schon eingetragen.',
		offerCode: 'Code',
	},
	zh: {
		scanToOrder: '扫码点餐',
		scanForMenu: '扫码查看菜单',
		scanToBook: '扫码预订',
		orderAtTable: '用手机点餐和付款',
		orderAhead: '提前点餐，免排队',
		bookTable: '预订餐桌',
		table: '桌号',
		scanForOffer: '扫码领取优惠',
		offerHeadline: '给你的一份小心意',
		offerCta: '扫码点餐，优惠码自动填写。',
		offerCode: '优惠码',
	},
}

const copy = (locale: string, key: CopyKey) => localeCopy(COPY, locale, key)

/**
 * A discount from Marketing, Discounts. A code discount names the code to
 * print (`codeId`); an automatic one has none (`null`) and the code just
 * opens the menu where the offer shows.
 */
export type RestaurantCouponTarget = {
	kind: 'coupon'
	discountId: string
	codeId: string | null
}

/** `['all']` means every live table at proof and approval time. */
export type RestaurantTableTarget = { kind: 'table'; tableIds: string[] }
export type RestaurantMenuTarget = { kind: 'menu'; locationId: string }
export type RestaurantReservationsTarget = {
	kind: 'reservations'
	locationId: string | null
}

export function isTableTarget(
	target: PrintQrTarget,
): target is PrintQrTarget & RestaurantTableTarget {
	return target.kind === 'table' && Array.isArray(target.tableIds)
}

const TABLE_TARGETS = ['table', 'menu', 'reservations', 'site'] as const
const COUPON_TARGETS = ['coupon', 'menu', 'site'] as const

export const restaurantPrintCatalog: PrintCatalogExtension = {
	products: [
		{
			key: 'table_card',
			family: 'card',
			shippable: true,
			featuredItems: false,
			qrTargets: TABLE_TARGETS,
			sizes: [
				{ key: 'a6', widthMm: 105, heightMm: 148, label: 'A6 · 105 × 148 mm' },
				{ key: '4x6', widthMm: 102, heightMm: 152, label: '4 × 6 in' },
			],
		},
		{
			key: 'table_tent',
			family: 'card',
			shippable: false,
			folded: true,
			featuredItems: false,
			qrTargets: TABLE_TARGETS,
			sizes: [
				{ key: '4x6', widthMm: 102, heightMm: 152, label: '4 × 6 in (folded)' },
			],
		},
		{
			// Shipped once Admin maps a vendor SKU per size (Admin, Print shop).
			key: 'coupon_card',
			family: 'card',
			shippable: true,
			featuredItems: false,
			qrTargets: COUPON_TARGETS,
			sizes: [
				{ key: 'a6', widthMm: 105, heightMm: 148, label: 'A6 · 105 × 148 mm' },
				{ key: '4x6', widthMm: 102, heightMm: 152, label: '4 × 6 in' },
			],
		},
	],
	productOrder: [
		'table_card',
		'poster',
		'flyer',
		'coupon_card',
		'table_tent',
		'window_sticker',
	],
	qrTargets: [
		{
			kind: 'table',
			perPiece: true,
			schema: z.strictObject({
				kind: z.literal('table'),
				tableIds: z
					.array(z.string().trim().min(1).max(100))
					.min(1)
					.max(PRINT_MAX_PIECES_PER_DESIGN),
			}),
			copy: (locale) => ({
				headline: copy(locale, 'scanToOrder'),
				callToAction: copy(locale, 'orderAtTable'),
				qrCaption: copy(locale, 'scanToOrder'),
			}),
			pieceWord: (locale) => copy(locale, 'table'),
		},
		{
			kind: 'menu',
			schema: z.strictObject({
				kind: z.literal('menu'),
				locationId: z.string().trim().min(1).max(100),
			}),
			copy: (locale) => ({
				headline: copy(locale, 'orderAhead'),
				callToAction: copy(locale, 'scanForMenu'),
				qrCaption: copy(locale, 'scanToOrder'),
			}),
		},
		{
			kind: 'coupon',
			schema: z.strictObject({
				kind: z.literal('coupon'),
				discountId: z.string().trim().min(1).max(100),
				codeId: z.string().trim().min(1).max(100).nullable(),
			}),
			copy: (locale) => ({
				headline: copy(locale, 'offerHeadline'),
				callToAction: copy(locale, 'offerCta'),
				qrCaption: copy(locale, 'scanForOffer'),
			}),
			// The code is printed where a table's label would be.
			pieceWord: (locale) => copy(locale, 'offerCode'),
		},
		{
			kind: 'reservations',
			schema: z.strictObject({
				kind: z.literal('reservations'),
				locationId: z.string().trim().min(1).max(100).nullable(),
			}),
			copy: (locale) => ({
				headline: copy(locale, 'bookTable'),
				callToAction: copy(locale, 'scanToBook'),
				qrCaption: copy(locale, 'scanToBook'),
			}),
		},
	],
}
