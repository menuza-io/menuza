/**
 * The ticket document a cloud printer prints (#117, #426, #263, #294, #167).
 *
 * One document model and three builders (kitchen ticket, guest receipt, test
 * ticket) feed every protocol encoder in `print-protocols.ts`. The builders
 * read the same field registry (`ticket-config.ts`), the same highlight rules
 * (`kitchen-ticket.ts`) and the same receipt-extras decision
 * (`receipt-extras.ts`) as the Station screens and the App's preview, so a
 * field hidden in Settings is hidden on paper too.
 *
 * Pure: no I/O. By construction a kitchen ticket has no field for a phone
 * number, an email address or a payment detail; only a receipt may show the
 * masked callback number, exactly as Station's receipt does.
 */
import {
	planReceiptExtras,
	type ReceiptExtrasConfig,
	type ReceiptTargets,
} from './receipt-extras.ts'
import {
	fieldStyle,
	type ResolvedTickets,
	type TicketType,
} from './ticket-config.ts'

export const TICKET_DOC_VERSION = 1
/** Characters per line in the printer's normal font, by paper width. */
export const TICKET_COLUMNS = { 58: 32, 80: 48 } as const
/** Printable dots across at 203 dpi. */
export const TICKET_DOTS = { 58: 384, 80: 576 } as const
export type TicketWidthMm = 58 | 80

export type TicketAlign = 'left' | 'center' | 'right'

/** A monochrome picture: rows of bits, most significant bit first, base64. */
export type TicketBitmap = { width: number; height: number; data: string }

export type TicketBlock =
	| {
			t: 'text'
			text: string
			align?: TicketAlign
			bold?: boolean
			large?: boolean
			/** White on black: readable with no colour at all. */
			invert?: boolean
			/** A drawn border, for printers that cannot invert. */
			boxed?: boolean
	  }
	| { t: 'row'; left: string; right: string; bold?: boolean }
	| { t: 'rule' }
	| { t: 'qr'; data: string; size: 'fiscal' | 'small'; caption?: string }
	| { t: 'image'; bitmap: TicketBitmap; align?: TicketAlign }
	| { t: 'feed'; lines: number }

export type TicketDoc = {
	v: typeof TICKET_DOC_VERSION
	kind: 'kitchen' | 'receipt' | 'test' | 'drawer' | 'label'
	widthMm: TicketWidthMm
	copies: number
	blocks: TicketBlock[]
	/** Open the cash drawer after printing (or alone, for a `drawer` job). */
	drawer?: boolean
	/** Some text is right to left: a printer without an Arabic font needs a picture. */
	rtl?: boolean
	/** Text needs characters a printer's built-in font does not have. */
	needsRaster?: boolean
	cut: boolean
}

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/u
// eslint-disable-next-line no-control-regex
const NOT_PRINTABLE = /[\u0000-\u001f\u007f]/g

export const hasArabic = (text: string) => ARABIC.test(text)

/** Whether text can be printed by a printer's own Latin font. */
export const isPlainPrintable = (text: string) =>
	[...text].every((char) => char.charCodeAt(0) < 0x250 || char === '€')

/** Something that reads as a phone number: seven or more digits with the usual separators. */
const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g

/**
 * Text a guest typed (a note, a name) with anything that looks like a phone
 * number taken out: a kitchen ticket never carries one, even when the guest
 * wrote theirs in the notes.
 */
export function scrubPhones(text: string | null | undefined): string {
	return (text ?? '').replace(PHONE_LIKE, (match) =>
		match.replace(/\D/g, '').length >= 7 ? '' : match,
	)
}

function clean(text: string | null | undefined, max = 120): string {
	return (text ?? '')
		.replace(NOT_PRINTABLE, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max)
}

// ---------------------------------------------------------------------------
// Words on paper
// ---------------------------------------------------------------------------

export type TicketLocale = 'en' | 'ar'

const WORDS = {
	en: {
		kitchenTicket: 'KITCHEN TICKET',
		changesOnly: 'KITCHEN TICKET: CHANGES ONLY',
		cancelled: 'CANCELLED',
		reprint: 'REPRINT',
		pickup: 'Pickup',
		delivery: 'Delivery',
		dineIn: 'Dine in',
		takeaway: 'Takeaway',
		driveThrough: 'Drive-through',
		table: 'Table',
		allergy: 'ALLERGY',
		attention: 'ATTENTION',
		longPrep: 'LONG PREP',
		guestAllergy: 'ALLERGY STATED BY GUEST',
		checkId: 'CHECK ID',
		testOrder: 'TEST ORDER',
		utensilsYes: 'Utensils: yes',
		utensilsNo: 'No utensils',
		largeOrder: 'Large order',
		paid: 'Paid',
		unpaid: 'Unpaid',
		station: 'Station',
		subtotal: 'Subtotal',
		discount: 'Discount',
		tax: 'Tax',
		vatIncluded: 'VAT included',
		tip: 'Tip',
		total: 'Total',
		change: 'Change',
		refunded: 'Refunded',
		balanceDue: 'Balance due',
		vatNo: 'VAT No.',
		taxInvoice: 'Simplified tax invoice',
		invoice: 'Invoice',
		thankYou: 'Thank you!',
		servedBy: 'Served by',
		testTitle: 'TEST PRINT',
		notASale: 'THIS IS NOT A SALE',
		testBody: 'If you can read this, the printer works.',
		printer: 'Printer',
		location: 'Location',
		paperWidth: 'Paper',
		drawerTest: 'Drawer test',
		deliverTo: 'Deliver to',
		taken: 'Taken off',
		forPerson: 'For',
		labelMade: 'Made',
		labelOpened: 'Opened',
		labelUseBy: 'Use by',
		labelMadeBy: 'By',
		labelQuantity: 'Qty',
	},
	ar: {
		kitchenTicket: 'تذكرة المطبخ',
		changesOnly: 'تذكرة المطبخ: التغييرات فقط',
		cancelled: 'ملغاة',
		reprint: 'إعادة طباعة',
		pickup: 'استلام',
		delivery: 'توصيل',
		dineIn: 'في المطعم',
		takeaway: 'سفري',
		driveThrough: 'من السيارة',
		table: 'طاولة',
		allergy: 'حساسية',
		attention: 'انتباه',
		longPrep: 'تحضير طويل',
		guestAllergy: 'الضيف ذكر حساسية',
		checkId: 'تحقق من الهوية',
		testOrder: 'طلب تجريبي',
		utensilsYes: 'أدوات المائدة: نعم',
		utensilsNo: 'بدون أدوات مائدة',
		largeOrder: 'طلب كبير',
		paid: 'مدفوع',
		unpaid: 'غير مدفوع',
		station: 'المحطة',
		subtotal: 'المجموع الفرعي',
		discount: 'خصم',
		tax: 'الضريبة',
		vatIncluded: 'شامل الضريبة',
		tip: 'البقشيش',
		total: 'الإجمالي',
		change: 'الباقي',
		refunded: 'مسترد',
		balanceDue: 'المبلغ المستحق',
		vatNo: 'الرقم الضريبي',
		taxInvoice: 'فاتورة ضريبية مبسطة',
		invoice: 'فاتورة',
		thankYou: 'شكراً لك!',
		servedBy: 'خدمك',
		testTitle: 'طباعة تجريبية',
		notASale: 'هذه ليست عملية بيع',
		testBody: 'إذا كنت تقرأ هذا فالطابعة تعمل.',
		printer: 'الطابعة',
		location: 'الموقع',
		paperWidth: 'الورق',
		drawerTest: 'اختبار الدرج',
		deliverTo: 'التوصيل إلى',
		taken: 'تمت إزالته',
		forPerson: 'لـ',
		labelMade: 'تاريخ التحضير',
		labelOpened: 'تاريخ الفتح',
		labelUseBy: 'يستخدم قبل',
		labelMadeBy: 'بواسطة',
		labelQuantity: 'الكمية',
	},
} satisfies Record<TicketLocale, Record<string, string>>

export type TicketWords = (typeof WORDS)['en']

export const ticketWords = (locale: string | null | undefined): TicketWords =>
	WORDS[locale === 'ar' ? 'ar' : 'en']

// ---------------------------------------------------------------------------
// Assembling a document
// ---------------------------------------------------------------------------

class DocBuilder {
	readonly blocks: TicketBlock[] = []
	rtl = false
	needsRaster = false
	constructor(readonly widthMm: TicketWidthMm) {}

	private note(text: string) {
		if (hasArabic(text)) this.rtl = true
		if (!isPlainPrintable(text)) this.needsRaster = true
	}
	text(
		text: string | null | undefined,
		style: Omit<Extract<TicketBlock, { t: 'text' }>, 't' | 'text'> = {},
	) {
		const body = clean(text, 400)
		if (!body) return
		// A leading indent (options under a dish) is part of the layout.
		const indent = /^ {1,4}/.exec(text ?? '')?.[0] ?? ''
		const value = `${indent}${body}`
		this.note(value)
		this.blocks.push({ t: 'text', text: value, ...style })
	}
	row(left: string, right: string, bold = false) {
		this.note(left)
		this.note(right)
		this.blocks.push({ t: 'row', left: clean(left), right: clean(right), bold })
	}
	rule() {
		this.blocks.push({ t: 'rule' })
	}
	push(block: TicketBlock) {
		this.blocks.push(block)
	}
	finish(
		kind: TicketDoc['kind'],
		copies: number,
		extra: Partial<TicketDoc> = {},
	): TicketDoc {
		return {
			v: TICKET_DOC_VERSION,
			kind,
			widthMm: this.widthMm,
			copies: Math.max(1, Math.min(5, Math.round(copies) || 1)),
			blocks: this.blocks,
			...(this.rtl ? { rtl: true } : {}),
			...(this.needsRaster ? { needsRaster: true } : {}),
			cut: true,
			...extra,
		}
	}
}

export type HighlightKind = 'allergy' | 'attention' | 'long_prep'

/** The marks on paper: fixed words, a box or inverse text, never colour. */
function markBlock(
	words: TicketWords,
	highlight: HighlightKind,
	text: string,
): Extract<TicketBlock, { t: 'text' }> {
	const label =
		highlight === 'allergy'
			? words.allergy
			: highlight === 'long_prep'
				? words.longPrep
				: words.attention
	return {
		t: 'text',
		text: `${label}: ${text}`,
		bold: true,
		...(highlight === 'allergy' ? { invert: true } : { boxed: true }),
	}
}

export type KitchenLineInput = {
	quantity: number
	/** The kitchen's name for the dish when it has one, else the guest name. */
	name: string
	variant?: string | null
	highlight?: HighlightKind | null
	options?: Array<{
		name: string
		quantity?: number
		groupName?: string | null
		highlight?: HighlightKind | null
	}>
	note?: string | null
	courseName?: string | null
	held?: boolean
	/** A group order (#170): whose dish this is, the first name they gave. */
	forName?: string | null
}

export type KitchenTicketInput = {
	number: string
	/** The time as the location reads it, already formatted. */
	time: string
	orderType: 'pickup' | 'delivery' | 'dine_in' | 'takeaway' | 'drive_through'
	tableLabel?: string | null
	/** First name only, for pickup. Never a phone number or an email. */
	guestFirstName?: string | null
	dueTime?: string | null
	/** Only when the printer's location turned delivery addresses on. */
	deliveryAddress?: string | null
	stationName?: string | null
	utensilsRequested?: boolean | null
	largeOrderExtraMinutes?: number | null
	largeOrder?: boolean
	paid?: boolean | null
	guestAllergy?: boolean
	checkId?: boolean
	/** A free test order (#119): "TEST ORDER" in a box, so nobody cooks it. */
	testOrder?: boolean
	reprint?: boolean
	kind?: 'full' | 'changes' | 'cancelled'
	removed?: Array<{ quantity: number; name: string }>
	lines: KitchenLineInput[]
}

const orderTypeWord = (
	words: TicketWords,
	type: KitchenTicketInput['orderType'],
) =>
	({
		pickup: words.pickup,
		delivery: words.delivery,
		dine_in: words.dineIn,
		takeaway: words.takeaway,
		drive_through: words.driveThrough,
	})[type]

export function buildKitchenTicket(input: {
	ticket: KitchenTicketInput
	tickets?: ResolvedTickets | null
	widthMm: TicketWidthMm
	copies?: number
	locale?: string | null
}): TicketDoc {
	const words = ticketWords(input.locale)
	const f = (key: string) => fieldStyle(input.tickets, 'kitchen', key)
	const doc = new DocBuilder(input.widthMm)
	const ticket = input.ticket
	const style = (key: string) => {
		const s = f(key)
		return {
			...(s.bold ? { bold: true as const } : {}),
			...(s.large ? { large: true as const } : {}),
		}
	}
	const title =
		ticket.kind === 'cancelled'
			? words.cancelled
			: ticket.kind === 'changes'
				? words.changesOnly
				: words.kitchenTicket
	if (ticket.kind === 'cancelled' || f('ticketTitle').show) {
		doc.text(title, { align: 'center', bold: true, ...style('ticketTitle') })
	}
	if (ticket.reprint) {
		doc.text(words.reprint, { align: 'center', boxed: true, bold: true })
	}
	if (ticket.stationName) {
		doc.text(`${words.station}: ${ticket.stationName}`, { align: 'center' })
	}
	if (f('dateTime').show) {
		doc.text(ticket.time, { align: 'center', ...style('dateTime') })
	}
	if (f('orderNumber').show) {
		doc.text(`#${ticket.number}`, {
			align: 'center',
			bold: true,
			large: true,
		})
	}
	if (f('orderType').show) {
		const parts = [
			orderTypeWord(words, ticket.orderType),
			ticket.tableLabel ? `${words.table} ${clean(ticket.tableLabel, 20)}` : '',
			ticket.guestFirstName
				? clean(scrubPhones(ticket.guestFirstName), 20)
				: '',
			ticket.dueTime ?? '',
		].filter(Boolean)
		doc.text(parts.join(' · '), { align: 'center', ...style('orderType') })
	}
	if (ticket.deliveryAddress) {
		doc.text(`${words.deliverTo}: ${clean(ticket.deliveryAddress, 200)}`, {
			align: 'left',
		})
	}
	// The whole header of a guest who said someone in the party has an allergy
	// (#294), and the ID check for alcohol (#167): words in a box or inverse.
	if (ticket.guestAllergy) {
		doc.text(words.guestAllergy, {
			align: 'center',
			bold: true,
			invert: true,
		})
	}
	if (ticket.checkId) {
		doc.text(words.checkId, { align: 'center', bold: true, boxed: true })
	}
	if (ticket.testOrder) {
		doc.text(words.testOrder, { align: 'center', bold: true, boxed: true })
	}
	if (typeof ticket.utensilsRequested === 'boolean' && f('utensils').show) {
		doc.text(ticket.utensilsRequested ? words.utensilsYes : words.utensilsNo, {
			align: 'center',
			bold: true,
		})
	}
	if ((ticket.largeOrderExtraMinutes ?? 0) > 0 || ticket.largeOrder) {
		if (f('largeOrder').show) {
			doc.text(
				(ticket.largeOrderExtraMinutes ?? 0) > 0
					? `${words.largeOrder} +${ticket.largeOrderExtraMinutes} min`
					: words.largeOrder,
				{ align: 'center' },
			)
		}
	}
	if (typeof ticket.paid === 'boolean') {
		doc.text(ticket.paid ? words.paid : words.unpaid, {
			align: 'center',
			bold: true,
		})
	}
	doc.rule()
	let course: string | null | undefined
	let person: string | null | undefined
	for (const line of ticket.lines) {
		// A group order (#170): the dishes of each person under "For Sam".
		if (line.forName && line.forName !== person) {
			person = line.forName
			doc.text(`${words.forPerson} ${clean(scrubPhones(line.forName), 40)}`, {
				bold: true,
			})
		}
		if (f('courses').show && line.courseName && line.courseName !== course) {
			course = line.courseName
			doc.text(`${line.courseName}${line.held ? ' (held)' : ''}`, {
				bold: true,
			})
		}
		const dish = `${line.quantity}x ${clean(scrubPhones(line.name), 80)}${
			line.variant ? ` (${clean(line.variant, 40)})` : ''
		}`
		if (line.highlight && f('highlights').show) {
			doc.push(markBlock(words, line.highlight, dish))
		} else {
			doc.text(dish, { bold: true, ...style('items') })
		}
		if (f('itemOptions').show) {
			for (const option of line.options ?? []) {
				const text = `+ ${option.quantity && option.quantity > 1 ? `${option.quantity}x ` : ''}${
					option.groupName ? `${clean(option.groupName, 30)}: ` : ''
				}${clean(scrubPhones(option.name), 80)}`
				if (option.highlight && f('highlights').show) {
					doc.push(markBlock(words, option.highlight, text))
				} else {
					doc.text(`  ${text}`, style('itemOptions'))
				}
			}
		}
		if (line.note && f('itemNotes').show) {
			doc.text(`  "${clean(scrubPhones(line.note), 280)}"`, style('itemNotes'))
		}
	}
	if (ticket.kind === 'changes' && (ticket.removed?.length ?? 0) > 0) {
		doc.rule()
		doc.text(words.taken, { bold: true })
		for (const removed of ticket.removed ?? []) {
			doc.text(`  ${removed.quantity}x ${clean(scrubPhones(removed.name), 80)}`)
		}
	}
	return doc.finish('kitchen', input.copies ?? 1)
}

export type ReceiptLineInput = {
	quantity: number
	name: string
	variant?: string | null
	totalCents: number
	options?: Array<{ name: string; quantity?: number; totalCents?: number }>
	note?: string | null
}

export type ReceiptInput = {
	businessName: string
	vatNumber?: string | null
	time: string
	number: string
	orderType: KitchenTicketInput['orderType']
	tableLabel?: string | null
	/** First name and the masked callback number, exactly as Station prints them. */
	guestName?: string | null
	phoneMasked?: string | null
	servedBy?: string | null
	invoiceNumber?: string | null
	currency: string
	lines: ReceiptLineInput[]
	subtotalCents: number
	adjustments?: Array<{ label: string; cents: number }>
	/** Charges on top of the items (delivery, service, packaging), shown as they were charged. */
	fees?: Array<{ label: string; cents: number }>
	taxCents: number
	taxInclusive?: boolean
	taxRatePercent?: number | null
	tipCents?: number
	totalCents: number
	payments?: Array<{ label: string; cents: number }>
	changeCents?: number
	refunds?: Array<{ label: string; cents: number }>
	balanceCents?: number
	/** The ZATCA code of a signed invoice, printed first of all codes. */
	fiscalQr?: string | null
	checkId?: boolean
	/** A free test order (#119): "TEST ORDER" in a box. */
	testOrder?: boolean
	kind?: 'sale' | 'refund' | 'void'
	reprint?: boolean
}

export type ReceiptExtrasInput = {
	config: ReceiptExtrasConfig
	targets: ReceiptTargets
	/** The one-colour logo, already converted, or null. */
	logo: TicketBitmap | null
}

const moneyText = (cents: number, currency: string, locale: string) => {
	try {
		return new Intl.NumberFormat(locale === 'ar' ? 'ar-SA' : 'en-US', {
			style: 'currency',
			currency,
		}).format(cents / 100)
	} catch {
		return (cents / 100).toFixed(2)
	}
}

export function buildReceipt(input: {
	receipt: ReceiptInput
	tickets?: ResolvedTickets | null
	extras?: ReceiptExtrasInput | null
	widthMm: TicketWidthMm
	copies?: number
	locale?: string | null
}): TicketDoc {
	const words = ticketWords(input.locale)
	const locale = input.locale === 'ar' ? 'ar' : 'en'
	const f = (key: string) => fieldStyle(input.tickets, 'receipt', key)
	const receipt = input.receipt
	const money = (cents: number) => moneyText(cents, receipt.currency, locale)
	const doc = new DocBuilder(input.widthMm)
	const style = (key: string) => {
		const s = f(key)
		return {
			...(s.bold ? { bold: true as const } : {}),
			...(s.large ? { large: true as const } : {}),
		}
	}
	// The logo, the review code and the app code (#263): one decision for every
	// receipt. Refund and void slips never carry them.
	const plan = input.extras
		? planReceiptExtras({
				config: input.extras.config,
				targets: input.extras.targets,
				logoUrl: input.extras.logo ? 'logo' : null,
				width: input.widthMm,
				fiscalQr: Boolean(receipt.fiscalQr),
				kind: receipt.kind ?? 'sale',
			})
		: { logo: false, codes: [], dropped: null }
	if (plan.logo && input.extras?.logo) {
		doc.push({ t: 'image', bitmap: input.extras.logo, align: 'center' })
	}
	if (receipt.reprint) {
		doc.text(words.reprint, { align: 'center', boxed: true, bold: true })
	}
	if (f('businessName').show) {
		doc.text(receipt.businessName, {
			align: 'center',
			bold: true,
			...style('businessName'),
		})
	}
	if (receipt.vatNumber) {
		doc.text(`${words.vatNo} ${receipt.vatNumber}`, {
			align: 'center',
			...style('vatNumber'),
		})
		if (receipt.invoiceNumber) {
			doc.text(words.taxInvoice, {
				align: 'center',
				bold: true,
				...style('invoiceTitle'),
			})
		}
	}
	if (f('dateTime').show) {
		doc.text(receipt.time, { align: 'center', ...style('dateTime') })
	}
	if (f('orderNumber').show) {
		doc.text(`#${receipt.number}`, { align: 'center', bold: true })
	}
	if (receipt.invoiceNumber) {
		doc.text(`${words.invoice} ${receipt.invoiceNumber}`, {
			align: 'center',
			...style('invoiceNumber'),
		})
	}
	if (f('orderType').show) {
		doc.text(
			[
				orderTypeWord(words, receipt.orderType),
				receipt.tableLabel
					? `${words.table} ${clean(receipt.tableLabel, 20)}`
					: '',
			]
				.filter(Boolean)
				.join(' · '),
			{ align: 'center', ...style('orderType') },
		)
	}
	if (f('guestContact').show && (receipt.guestName || receipt.phoneMasked)) {
		doc.text(
			[clean(receipt.guestName, 40), receipt.phoneMasked ?? '']
				.filter(Boolean)
				.join(' · '),
			{ align: 'center', ...style('guestContact') },
		)
	}
	if (receipt.servedBy && f('servedBy').show) {
		doc.text(`${words.servedBy} ${clean(receipt.servedBy, 40)}`, {
			align: 'center',
			...style('servedBy'),
		})
	}
	if (receipt.checkId) {
		doc.text(words.checkId, { align: 'center', bold: true, boxed: true })
	}
	if (receipt.testOrder) {
		doc.text(words.testOrder, { align: 'center', bold: true, boxed: true })
	}
	doc.rule()
	for (const line of receipt.lines) {
		doc.row(
			`${line.quantity}x ${clean(line.name, 60)}${line.variant ? ` (${clean(line.variant, 30)})` : ''}`,
			money(line.totalCents),
			Boolean('bold' in style('items')),
		)
		if (f('itemOptions').show) {
			for (const option of line.options ?? []) {
				doc.row(
					`  + ${option.quantity && option.quantity > 1 ? `${option.quantity}x ` : ''}${clean(option.name, 60)}`,
					option.totalCents ? money(option.totalCents) : '',
				)
			}
		}
		if (line.note && f('itemNotes').show) {
			doc.text(`  "${clean(line.note, 200)}"`)
		}
	}
	doc.rule()
	if (f('subtotal').show) doc.row(words.subtotal, money(receipt.subtotalCents))
	if (f('discounts').show) {
		for (const adjustment of receipt.adjustments ?? []) {
			doc.row(clean(adjustment.label, 40), money(-adjustment.cents))
		}
	}
	for (const fee of receipt.fees ?? []) {
		doc.row(clean(fee.label, 40), money(fee.cents))
	}
	doc.row(
		`${receipt.taxInclusive ? words.vatIncluded : words.tax}${
			receipt.taxRatePercent ? ` (${receipt.taxRatePercent}%)` : ''
		}`,
		money(receipt.taxCents),
	)
	if ((receipt.tipCents ?? 0) > 0 && f('tip').show) {
		doc.row(words.tip, money(receipt.tipCents ?? 0))
	}
	doc.row(words.total, money(receipt.totalCents), true)
	if (f('payments').show) {
		for (const payment of receipt.payments ?? []) {
			doc.row(clean(payment.label, 40), money(payment.cents))
		}
	}
	if ((receipt.changeCents ?? 0) > 0 && f('change').show) {
		doc.row(words.change, money(receipt.changeCents ?? 0))
	}
	if (f('refunds').show) {
		for (const refund of receipt.refunds ?? []) {
			doc.row(clean(refund.label, 40), money(-refund.cents))
		}
	}
	if ((receipt.balanceCents ?? 0) > 0 && f('balanceDue').show) {
		doc.row(words.balanceDue, money(receipt.balanceCents ?? 0), true)
	}
	// The ZATCA code stays first, full size and unchanged; marketing codes come
	// after it, smaller, each with its caption.
	if (receipt.fiscalQr) {
		doc.push({ t: 'qr', data: receipt.fiscalQr, size: 'fiscal' })
	}
	for (const code of plan.codes) {
		doc.push({ t: 'qr', data: code.url, size: 'small', caption: code.caption })
	}
	if (f('thankYou').show) {
		doc.text(words.thankYou, { align: 'center', ...style('thankYou') })
	}
	return doc.finish('receipt', input.copies ?? 1, { drawer: false })
}

/** A test ticket (#426): marked, never a sale, and printed through the same path. */
export function buildTestTicket(input: {
	printerName: string
	locationName: string
	widthMm: TicketWidthMm
	time: string
	locale?: string | null
	drawer?: boolean
}): TicketDoc {
	const words = ticketWords(input.locale)
	const doc = new DocBuilder(input.widthMm)
	doc.text(words.testTitle, { align: 'center', bold: true, large: true })
	doc.text(words.notASale, {
		align: 'center',
		bold: true,
		invert: true,
	})
	doc.rule()
	doc.text(`${words.printer}: ${clean(input.printerName, 60)}`)
	doc.text(`${words.location}: ${clean(input.locationName, 60)}`)
	doc.text(`${words.paperWidth}: ${input.widthMm} mm`)
	doc.text(input.time)
	doc.rule()
	doc.text(words.testBody, { align: 'center' })
	return doc.finish('test', 1, { drawer: input.drawer === true })
}

/**
 * A time as a label shows it: day, month and 24-hour time in the location's
 * time zone, with Latin digits so a printer without an Arabic font reads it.
 */
export function formatLabelTime(at: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone,
		day: '2-digit',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).formatToParts(new Date(at))
	const get = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? ''
	const hour = get('hour') === '24' ? '00' : get('hour')
	return `${get('day')} ${get('month')} ${hour}:${get('minute')}`
}

/**
 * A food-safety label (#523): what is in the container, when it was made (or
 * opened) and when to throw it out. The name is printed in English and, when the
 * item has one, in Arabic. 2 inch labels are the 58 mm layout (32 columns).
 * Never carries a person's phone or any money.
 */
export function buildLabelDoc(input: {
	nameEn: string
	nameAr?: string | null
	kind: 'made' | 'opened'
	madeAtLabel: string
	useByLabel?: string | null
	madeBy?: string | null
	quantityLabel?: string | null
	storageNote?: string | null
	widthMm?: TicketWidthMm
	copies?: number
	locale?: string | null
}): TicketDoc {
	const words = ticketWords(input.locale)
	const doc = new DocBuilder(input.widthMm ?? 58)
	doc.text(input.nameEn, { align: 'center', bold: true, large: true })
	if (input.nameAr) {
		doc.text(input.nameAr, { align: 'center', bold: true, large: true })
	}
	doc.rule()
	doc.row(
		input.kind === 'opened' ? words.labelOpened : words.labelMade,
		input.madeAtLabel,
	)
	if (input.useByLabel) {
		doc.row(words.labelUseBy, input.useByLabel, true)
	}
	if (input.madeBy) doc.row(words.labelMadeBy, input.madeBy)
	if (input.quantityLabel) doc.row(words.labelQuantity, input.quantityLabel)
	if (input.storageNote) {
		doc.rule()
		doc.text(input.storageNote, { align: 'center' })
	}
	return doc.finish('label', input.copies ?? 1, { cut: true })
}

/** A job that only opens the cash drawer (#426). */
export function buildDrawerJob(widthMm: TicketWidthMm): TicketDoc {
	return {
		v: TICKET_DOC_VERSION,
		kind: 'drawer',
		widthMm,
		copies: 1,
		blocks: [],
		drawer: true,
		cut: false,
	}
}

/** True when a printer without the needed font must be sent a picture. */
export function needsPicture(
	doc: Pick<TicketDoc, 'needsRaster' | 'rtl'>,
	printer: { arabicFont?: boolean },
): boolean {
	if (doc.rtl && !printer.arabicFont) return true
	return doc.needsRaster === true && !printer.arabicFont
}

/** Whether any text in a document looks like a phone number (a guard for tests and logs). */
export function docMentionsPhone(doc: TicketDoc): boolean {
	const text = doc.blocks
		.flatMap((block) =>
			block.t === 'text'
				? [block.text]
				: block.t === 'row'
					? [block.left, block.right]
					: [],
		)
		.join('\n')
	return /(?:\+?\d[\d\s().-]{6,}\d)/.test(text)
}

const PAY_RATE = /pay\s*rate|wage|salary|hourly/i

/** A clock slip (#278). First name, action, time and the shift length. Never a pay rate. */
export function buildClockSlipDoc(input: {
	firstName: string
	action: 'in' | 'out'
	atLabel: string
	/** Hours and minutes worked, only on clock out. */
	shiftTotalLabel?: string | null
}): TicketDoc {
	const blocks: TicketBlock[] = [
		{ t: 'text', text: 'Time clock', align: 'center', bold: true },
		{ t: 'rule' },
		{ t: 'row', left: 'Name', right: input.firstName },
		{
			t: 'row',
			left: 'Action',
			right: input.action === 'in' ? 'Clock in' : 'Clock out',
		},
		{ t: 'row', left: 'Time', right: input.atLabel },
	]
	if (input.action === 'out' && input.shiftTotalLabel) {
		blocks.push({ t: 'row', left: 'Shift', right: input.shiftTotalLabel })
	}
	blocks.push({ t: 'feed', lines: 2 })
	const doc: TicketDoc = {
		v: TICKET_DOC_VERSION,
		kind: 'receipt',
		widthMm: 80,
		copies: 1,
		blocks,
		cut: true,
	}
	if (PAY_RATE.test(JSON.stringify(doc))) {
		throw new Error('A clock slip must not carry a pay rate')
	}
	return doc
}

/** The Z report as a ticket (#278). Money totals only. */
export function buildShiftReportDoc(input: {
	businessDate: string
	terminal: string
	lines: ReadonlyArray<{ label: string; value: string }>
}): TicketDoc {
	const blocks: TicketBlock[] = [
		{ t: 'text', text: 'Shift report', align: 'center', bold: true },
		{ t: 'row', left: input.terminal, right: input.businessDate },
		{ t: 'rule' },
		...input.lines.map((line): TicketBlock => ({
			t: 'row',
			left: line.label,
			right: line.value,
		})),
		{ t: 'feed', lines: 2 },
	]
	return {
		v: TICKET_DOC_VERSION,
		kind: 'receipt',
		widthMm: 80,
		copies: 1,
		blocks,
		cut: true,
	}
}

export type { TicketType }
