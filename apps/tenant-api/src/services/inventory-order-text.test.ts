import { ORDER_LINK_MAX_LENGTH } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	buildMailtoLink,
	buildWhatsAppLink,
	formatQuantity,
	orderTextToHtml,
	renderCreditText,
	renderOrderText,
} from './inventory-order-text.ts'

describe('quantities', () => {
	it('reads in the unit that fits, in both languages, with Latin digits', () => {
		expect(formatQuantity(20_000_000, 'g', 'metric', 'en')).toBe('20 kg')
		expect(formatQuantity(500_000, 'g', 'metric', 'en')).toBe('500 g')
		expect(formatQuantity(1_500_000, 'g', 'metric', 'ar')).toBe('1.5 كغ')
		expect(formatQuantity(2_000_000, 'ml', 'metric', 'en')).toBe('2 L')
		expect(formatQuantity(3_000, 'piece', 'metric', 'en')).toBe('3 pcs')
		expect(formatQuantity(3_000, 'piece', 'metric', 'ar')).toBe('3 حبة')
		expect(formatQuantity(907_184, 'g', 'us', 'en')).toBe('2 lb')
	})
})

describe('order text', () => {
	const base = {
		number: 12,
		supplierName: 'Fresh Farms',
		contactName: null,
		note: null,
		unitSystem: 'metric' as const,
		lines: [
			{
				itemName: 'Chicken',
				packName: 'Box 10 kg',
				packs: 2.5,
				quantity: 25_000_000,
				baseUnit: 'g' as const,
			},
		],
	}

	it('never contains money, whatever the order carries', () => {
		const en = renderOrderText({
			...base,
			locale: 'en',
			expectedDate: '2031-03-06',
		})
		expect(en.subject).toBe('Order 12')
		expect(en.text).toBe(
			[
				'Hello Fresh Farms,',
				'',
				'Please supply the following order:',
				'',
				'- Chicken: 2.5 × Box 10 kg (25 kg)',
				'',
				'Delivery date: Thu, Mar 6',
				'',
				'Thank you.',
			].join('\n'),
		)
		expect(en.text).not.toMatch(/\d\.\d\d|SAR|price|total/i)
	})

	it('greets the contact person when there is one, and writes Arabic', () => {
		const ar = renderOrderText({
			...base,
			locale: 'ar',
			contactName: 'Omar',
			expectedDate: null,
			note: 'اتصل أولاً',
		})
		expect(ar.subject).toBe('طلب شراء رقم 12')
		expect(ar.text).toContain('مرحباً Omar،')
		expect(ar.text).toContain('- Chicken: 2.5 × Box 10 kg (25 كغ)')
		expect(ar.text).toContain('ملاحظة: اتصل أولاً')
		expect(ar.text).not.toContain('تاريخ التسليم')
	})

	it('writes a credit request for short and missing lines', () => {
		const text = renderCreditText({
			locale: 'en',
			orderNumber: 12,
			supplierName: 'Fresh Farms',
			contactName: null,
			deliveryDate: '2031-03-06',
			note: 'Third time',
			unitSystem: 'metric',
			lines: [
				{
					itemName: 'Chicken',
					packName: 'Box 10 kg',
					orderedQuantity: 40_000_000,
					receivedQuantity: 10_000_000,
					shortQuantity: 30_000_000,
					kind: 'short',
					baseUnit: 'g',
				},
				{
					itemName: 'Lamb',
					packName: null,
					orderedQuantity: 5_000_000,
					receivedQuantity: 0,
					shortQuantity: 5_000_000,
					kind: 'missing',
					baseUnit: 'g',
				},
			],
		})
		expect(text.subject).toBe('Credit request for order 12')
		expect(text.text).toContain(
			'- Chicken (Box 10 kg): ordered 40 kg, received 10 kg (short 30 kg)',
		)
		expect(text.text).toContain('- Lamb: ordered 5 kg, not delivered')
		expect(text.text).toContain('Note: Third time')
		const ar = renderCreditText({
			locale: 'ar',
			orderNumber: 12,
			supplierName: 'Fresh Farms',
			contactName: null,
			deliveryDate: '2031-03-06',
			note: null,
			unitSystem: 'metric',
			lines: [
				{
					itemName: 'Lamb',
					packName: null,
					orderedQuantity: 5_000_000,
					receivedQuantity: 0,
					shortQuantity: 5_000_000,
					kind: 'missing',
					baseUnit: 'g',
				},
			],
		})
		expect(ar.text).toContain('- Lamb: المطلوب 5 كغ، لم يصل')
	})
})

describe('links and email', () => {
	it('builds a wa.me link from the digits of the phone, with and without a number', () => {
		expect(buildWhatsAppLink('+966 (55) 000-1111', 'Hi there\nLine 2')).toBe(
			'https://wa.me/966550001111?text=Hi%20there%0ALine%202',
		)
		expect(buildWhatsAppLink(null, 'Hi')).toBe('https://wa.me/?text=Hi')
	})

	it('builds a mailto and drops a link that is too long to open', () => {
		expect(buildMailtoLink('a@b.example', 'Order 1', 'Body\nmore')).toBe(
			'mailto:a@b.example?subject=Order%201&body=Body%0Amore',
		)
		expect(buildMailtoLink(null, 'S', 'B')).toBe('mailto:?subject=S&body=B')
		const long = 'x'.repeat(ORDER_LINK_MAX_LENGTH)
		expect(buildWhatsAppLink('123', long)).toBeNull()
		expect(buildMailtoLink('a@b.example', 'S', long)).toBeNull()
	})

	it('escapes the text in the email body and sets the direction', () => {
		const html = orderTextToHtml('<b>x</b> & "y"\n\nline', 'ar')
		expect(html).toContain('dir="rtl"')
		expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;')
		expect(html).not.toContain('<b>')
		expect(orderTextToHtml('a', 'en')).toContain('dir="ltr"')
	})
})
