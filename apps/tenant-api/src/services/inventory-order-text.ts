import {
	displayUnitFor,
	fromBaseQuantity,
	ORDER_LINK_MAX_LENGTH,
	roundForDisplay,
	type InventoryBaseUnit,
	type OrderTextLocale,
	type StandardUnit,
	type UnitSystem,
} from '@repo/inventory'
import { formatLocalDate } from '../lib/staff-email.ts'

/**
 * The words of an order and of a credit request, in English and Arabic. Plain
 * text only and NEVER money (a person without the cost grant can read the
 * order, and the text goes to a supplier's phone or inbox as it is). Numbers
 * are Latin digits in both languages, as on a Saudi invoice. The region writes
 * the text so a Station tablet and the App say the same thing.
 */

const UNIT_LABELS: Record<OrderTextLocale, Record<StandardUnit, string>> = {
	en: {
		g: 'g',
		kg: 'kg',
		oz: 'oz',
		lb: 'lb',
		ml: 'ml',
		l: 'L',
		fl_oz: 'fl oz',
		qt: 'qt',
		gal: 'gal',
		piece: 'pcs',
	},
	ar: {
		g: 'غ',
		kg: 'كغ',
		oz: 'أونصة',
		lb: 'رطل',
		ml: 'مل',
		l: 'لتر',
		fl_oz: 'أونصة سائلة',
		qt: 'ربع جالون',
		gal: 'جالون',
		piece: 'حبة',
	},
}

function number(value: number): string {
	return String(roundForDisplay(value))
}

/** A base quantity in the unit that reads best ("20 kg", "3 pcs"). */
export function formatQuantity(
	quantity: number,
	base: InventoryBaseUnit,
	system: UnitSystem,
	locale: OrderTextLocale,
): string {
	const unit = displayUnitFor(quantity, base, system)
	const amount = fromBaseQuantity(quantity, { kind: 'standard', unit }, base)
	const labels = UNIT_LABELS[locale]
	return `${number(amount)} ${labels[unit]}`
}

export type OrderTextLine = {
	itemName: string
	packName: string
	packs: number
	/** Base thousandths that will arrive. */
	quantity: number
	baseUnit: InventoryBaseUnit
}

export type RenderedText = { subject: string; text: string }

function lineText(
	line: OrderTextLine,
	system: UnitSystem,
	locale: OrderTextLocale,
): string {
	return `- ${line.itemName}: ${number(line.packs)} × ${line.packName} (${formatQuantity(line.quantity, line.baseUnit, system, locale)})`
}

function greeting(
	locale: OrderTextLocale,
	contactName: string | null,
	supplierName: string,
): string {
	const name = contactName?.trim() || supplierName
	return locale === 'ar' ? `مرحباً ${name}،` : `Hello ${name},`
}

export function renderOrderText(input: {
	locale: OrderTextLocale
	number: number
	supplierName: string
	contactName: string | null
	expectedDate: string | null
	note: string | null
	lines: readonly OrderTextLine[]
	unitSystem: UnitSystem
}): RenderedText {
	const { locale } = input
	const ar = locale === 'ar'
	const rows = [
		greeting(locale, input.contactName, input.supplierName),
		'',
		ar ? 'نرجو توريد الطلب التالي:' : 'Please supply the following order:',
		'',
		...input.lines.map((line) => lineText(line, input.unitSystem, locale)),
	]
	if (input.expectedDate) {
		rows.push(
			'',
			`${ar ? 'تاريخ التسليم المطلوب' : 'Delivery date'}: ${formatLocalDate(input.expectedDate, locale)}`,
		)
	}
	if (input.note?.trim()) {
		rows.push('', `${ar ? 'ملاحظة' : 'Note'}: ${input.note.trim()}`)
	}
	rows.push('', ar ? 'شكراً لكم.' : 'Thank you.')
	return {
		subject: ar ? `طلب شراء رقم ${input.number}` : `Order ${input.number}`,
		text: rows.join('\n'),
	}
}

export type CreditTextLine = {
	itemName: string
	packName: string | null
	orderedQuantity: number
	receivedQuantity: number
	shortQuantity: number
	kind: 'short' | 'missing'
	baseUnit: InventoryBaseUnit
}

export function renderCreditText(input: {
	locale: OrderTextLocale
	orderNumber: number
	supplierName: string
	contactName: string | null
	/** The business date the delivery was received. */
	deliveryDate: string
	note: string | null
	lines: readonly CreditTextLine[]
	unitSystem: UnitSystem
}): RenderedText {
	const { locale } = input
	const ar = locale === 'ar'
	const q = (quantity: number, line: CreditTextLine) =>
		formatQuantity(quantity, line.baseUnit, input.unitSystem, locale)
	const rows = [
		greeting(locale, input.contactName, input.supplierName),
		'',
		ar
			? `استلمنا بتاريخ ${formatLocalDate(input.deliveryDate, locale)} توريدة الطلب رقم ${input.orderNumber} وكانت ناقصة في الأصناف التالية:`
			: `Our delivery on ${formatLocalDate(input.deliveryDate, locale)} for order ${input.orderNumber} was short on:`,
		'',
		...input.lines.map((line) => {
			const pack = line.packName ? ` (${line.packName})` : ''
			if (ar) {
				return line.kind === 'missing'
					? `- ${line.itemName}${pack}: المطلوب ${q(line.orderedQuantity, line)}، لم يصل`
					: `- ${line.itemName}${pack}: المطلوب ${q(line.orderedQuantity, line)}، المستلم ${q(line.receivedQuantity, line)} (النقص ${q(line.shortQuantity, line)})`
			}
			return line.kind === 'missing'
				? `- ${line.itemName}${pack}: ordered ${q(line.orderedQuantity, line)}, not delivered`
				: `- ${line.itemName}${pack}: ordered ${q(line.orderedQuantity, line)}, received ${q(line.receivedQuantity, line)} (short ${q(line.shortQuantity, line)})`
		}),
	]
	if (input.note?.trim()) {
		rows.push('', `${ar ? 'ملاحظة' : 'Note'}: ${input.note.trim()}`)
	}
	rows.push(
		'',
		ar
			? 'نرجو إصدار إشعار دائن أو توريد الكمية الناقصة.'
			: 'Please send a credit note or the missing goods.',
		'',
		ar ? 'شكراً لكم.' : 'Thank you.',
	)
	return {
		subject: ar
			? `طلب إشعار دائن للطلب رقم ${input.orderNumber}`
			: `Credit request for order ${input.orderNumber}`,
		text: rows.join('\n'),
	}
}

/** `https://wa.me/<digits>?text=…`, or null when it would be too long to open. */
export function buildWhatsAppLink(
	phone: string | null,
	text: string,
): string | null {
	const digits = (phone ?? '').replace(/\D/g, '')
	const link = `https://wa.me/${digits}?text=${encodeURIComponent(text)}`
	return link.length > ORDER_LINK_MAX_LENGTH ? null : link
}

/** `mailto:<email>?subject=…&body=…`, or null when it would be too long. */
export function buildMailtoLink(
	email: string | null,
	subject: string,
	text: string,
): string | null {
	const link = `mailto:${email ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`
	return link.length > ORDER_LINK_MAX_LENGTH ? null : link
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/** The email body: the same text, escaped, one paragraph per block, right to left in Arabic. */
export function orderTextToHtml(text: string, locale: OrderTextLocale): string {
	const body = text
		.split('\n')
		.map((line) => (line === '' ? '<br>' : `<div>${escapeHtml(line)}</div>`))
		.join('')
	return `<div dir="${locale === 'ar' ? 'rtl' : 'ltr'}" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1d1c1a">${body}</div>`
}
