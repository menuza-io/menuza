import { describe, expect, it } from 'vitest'
import {
	buildDrawerJob,
	buildLabelDoc,
	formatLabelTime,
	buildKitchenTicket,
	buildReceipt,
	buildTestTicket,
	docMentionsPhone,
	needsPicture,
	scrubPhones,
	type KitchenTicketInput,
	type TicketDoc,
} from './print-ticket.ts'
import { DEFAULT_RECEIPT_EXTRAS } from './receipt-extras.ts'
import { resolveTickets } from './ticket-config.ts'

const texts = (doc: TicketDoc) =>
	doc.blocks.flatMap((block) =>
		block.t === 'text'
			? [block.text]
			: block.t === 'row'
				? [`${block.left}|${block.right}`]
				: block.t === 'qr'
					? [`QR:${block.size}:${block.caption ?? ''}`]
					: [],
	)

const ticket = (
	over: Partial<KitchenTicketInput> = {},
): KitchenTicketInput => ({
	number: 'W-0951',
	time: '18 Nov, 14:02',
	orderType: 'pickup',
	guestFirstName: 'Rana',
	lines: [
		{
			quantity: 2,
			name: 'Burger',
			options: [
				{ name: 'No onions', highlight: 'attention' },
				{ name: 'Extra cheese' },
			],
			note: 'well done',
		},
		{ quantity: 1, name: 'Satay', highlight: 'allergy' },
		{ quantity: 1, name: 'Fries' },
	],
	...over,
})

describe('the kitchen ticket document', () => {
	it('carries the order, the dishes, options and notes', () => {
		const doc = buildKitchenTicket({ ticket: ticket(), widthMm: 80 })
		const lines = texts(doc)
		expect(lines).toContain('KITCHEN TICKET')
		expect(lines).toContain('#W-0951')
		expect(lines).toContain('Pickup · Rana')
		expect(lines).toContain('2x Burger')
		expect(lines).toContain('  + Extra cheese')
		expect(lines).toContain('  "well done"')
		expect(doc.kind).toBe('kitchen')
		expect(doc.cut).toBe(true)
	})

	it('prints a group order under "For Sam" once per person (#170)', () => {
		const doc = buildKitchenTicket({
			ticket: ticket({
				lines: [
					{ quantity: 1, name: 'Burger', forName: 'Hana' },
					{ quantity: 1, name: 'Fries', forName: 'Sam' },
					{ quantity: 2, name: 'Salad', forName: 'Sam' },
					{ quantity: 1, name: 'Soup', forName: 'Lee' },
				],
			}),
			widthMm: 80,
		})
		const lines = texts(doc)
		const heads = lines.filter((line) => line.startsWith('For '))
		expect(heads).toEqual(['For Hana', 'For Sam', 'For Lee'])
		expect(lines.indexOf('For Sam')).toBeLessThan(lines.indexOf('1x Fries'))
		expect(lines.indexOf('1x Fries')).toBeLessThan(lines.indexOf('For Lee'))
		// A normal ticket has none.
		expect(
			texts(buildKitchenTicket({ ticket: ticket(), widthMm: 80 })).some((l) =>
				l.startsWith('For '),
			),
		).toBe(false)
	})

	it('marks highlighted lines with words and a box or inverse text, never colour', () => {
		const doc = buildKitchenTicket({ ticket: ticket(), widthMm: 80 })
		const attention = doc.blocks.find(
			(b) => b.t === 'text' && b.text.includes('No onions'),
		)
		const allergy = doc.blocks.find(
			(b) => b.t === 'text' && b.text.includes('Satay'),
		)
		expect(attention).toMatchObject({ boxed: true })
		expect((attention as { text: string }).text).toBe('ATTENTION: + No onions')
		expect(allergy).toMatchObject({ invert: true })
		expect((allergy as { text: string }).text).toBe('ALLERGY: 1x Satay')
		// A dish with no highlight prints as it always did.
		const plain = doc.blocks.find(
			(b) => b.t === 'text' && b.text === '1x Fries',
		)
		expect(plain).toBeDefined()
		expect((plain as { boxed?: boolean }).boxed).toBeUndefined()
	})

	it('highlights the whole header when the guest stated an allergy, and says Check ID', () => {
		const doc = buildKitchenTicket({
			ticket: ticket({ guestAllergy: true, checkId: true }),
			widthMm: 58,
		})
		expect(doc.blocks).toContainEqual(
			expect.objectContaining({
				text: 'ALLERGY STATED BY GUEST',
				invert: true,
			}),
		)
		expect(doc.blocks).toContainEqual(
			expect.objectContaining({ text: 'CHECK ID', boxed: true }),
		)
		const quiet = buildKitchenTicket({ ticket: ticket(), widthMm: 58 })
		expect(texts(quiet).join('\n')).not.toMatch(/CHECK ID|STATED BY GUEST/)
	})

	it('never carries a phone number, even one a guest typed into a note or name', () => {
		const doc = buildKitchenTicket({
			ticket: ticket({
				guestFirstName: '+1 555 123 4567',
				lines: [
					{
						quantity: 1,
						name: 'Pizza',
						note: 'call me on 555-123-4567 when ready',
						options: [{ name: 'Olives 0551234567' }],
					},
				],
			}),
			widthMm: 80,
		})
		expect(docMentionsPhone(doc)).toBe(false)
		expect(JSON.stringify(doc)).not.toMatch(/555|0551234567/)
		expect(scrubPhones('table 12, 2 pizzas')).toBe('table 12, 2 pizzas')
	})

	it('shows the delivery address only when asked to, and never payment details', () => {
		const withAddress = buildKitchenTicket({
			ticket: ticket({ orderType: 'delivery', deliveryAddress: '12 Main St' }),
			widthMm: 80,
		})
		expect(texts(withAddress).join('\n')).toContain('Deliver to: 12 Main St')
		const without = buildKitchenTicket({
			ticket: ticket({ orderType: 'delivery' }),
			widthMm: 80,
		})
		expect(texts(without).join('\n')).not.toContain('Deliver to')
		expect(JSON.stringify(without)).not.toMatch(/card|cvv|iban|payment/i)
	})

	it("follows the location's ticket settings: a hidden field is hidden on paper", () => {
		const tickets = resolveTickets({
			kitchen: { itemNotes: { show: false }, highlights: { show: false } },
		})
		const doc = buildKitchenTicket({ ticket: ticket(), tickets, widthMm: 80 })
		const lines = texts(doc).join('\n')
		expect(lines).not.toContain('well done')
		expect(lines).not.toContain('ALLERGY:')
	})

	it('prints a cancellation slip and only the changes when asked', () => {
		const cancelled = buildKitchenTicket({
			ticket: ticket({ kind: 'cancelled' }),
			widthMm: 80,
		})
		expect(texts(cancelled)[0]).toBe('CANCELLED')
		const changes = buildKitchenTicket({
			ticket: ticket({
				kind: 'changes',
				removed: [{ quantity: 1, name: 'Salad' }],
			}),
			widthMm: 80,
		})
		expect(texts(changes).join('\n')).toContain('Taken off')
	})

	it('speaks Arabic and says it needs a picture on a printer with no Arabic font', () => {
		const doc = buildKitchenTicket({
			ticket: ticket({ lines: [{ quantity: 1, name: 'شاورما' }] }),
			widthMm: 80,
			locale: 'ar',
		})
		expect(doc.rtl).toBe(true)
		expect(needsPicture(doc, { arabicFont: false })).toBe(true)
		expect(needsPicture(doc, { arabicFont: true })).toBe(false)
		const latin = buildKitchenTicket({ ticket: ticket(), widthMm: 80 })
		expect(needsPicture(latin, { arabicFont: false })).toBe(false)
	})
})

describe('the receipt document', () => {
	const receipt = {
		businessName: 'Cafe Bloom',
		vatNumber: '300000000000003',
		time: '18 Nov, 14:02',
		number: 'T1-0042',
		orderType: 'dine_in' as const,
		tableLabel: '4',
		phoneMasked: '•••• 0111',
		guestName: 'Jordan',
		invoiceNumber: '7',
		currency: 'USD',
		lines: [{ quantity: 2, name: 'Burger', totalCents: 2300 }],
		subtotalCents: 2300,
		taxCents: 230,
		totalCents: 2530,
		payments: [{ label: 'Paid · Cash', cents: 3000 }],
		changeCents: 470,
		fiscalQr: 'ZATCA-PAYLOAD',
		checkId: true,
	}
	const extras = {
		config: {
			logo: true,
			review: { show: true, caption: null },
			app: { show: true, caption: null },
		},
		targets: {
			reviewUrl: 'https://g.page/r/x/review',
			appUrl: 'https://s.test/get-app',
		},
		logo: { width: 8, height: 1, data: 'gA==' },
	}

	it('keeps the ZATCA code first and unchanged, with the logo on top and the codes after', () => {
		const doc = buildReceipt({ receipt, extras, widthMm: 80 })
		expect(doc.blocks[0]).toMatchObject({ t: 'image' })
		const qrs = doc.blocks.filter((b) => b.t === 'qr')
		expect(qrs).toHaveLength(3)
		expect(qrs[0]).toEqual({ t: 'qr', data: 'ZATCA-PAYLOAD', size: 'fiscal' })
		expect(qrs[1]).toMatchObject({
			size: 'small',
			caption: 'Enjoyed it? Tell us',
		})
		expect(qrs[2]).toMatchObject({
			size: 'small',
			caption: 'Order ahead next time',
		})
		// The fiscal block is the same with or without marketing.
		const plain = buildReceipt({ receipt, widthMm: 80 })
		expect(plain.blocks.find((b) => b.t === 'qr')).toEqual(qrs[0])
	})

	it('drops the marketing codes, never the fiscal one, on a 58 mm roll', () => {
		const doc = buildReceipt({ receipt, extras, widthMm: 58 })
		const qrs = doc.blocks.filter((b) => b.t === 'qr')
		expect(qrs).toEqual([{ t: 'qr', data: 'ZATCA-PAYLOAD', size: 'fiscal' }])
	})

	it('offers no review code without a link, and none on refund or void slips', () => {
		const noReview = buildReceipt({
			receipt,
			extras: { ...extras, targets: { ...extras.targets, reviewUrl: null } },
			widthMm: 80,
		})
		expect(
			noReview.blocks.filter((b) => b.t === 'qr' && b.size === 'small'),
		).toHaveLength(1)
		const refund = buildReceipt({
			receipt: { ...receipt, kind: 'refund' },
			extras,
			widthMm: 80,
		})
		expect(refund.blocks.filter((b) => b.t === 'qr')).toHaveLength(1)
		expect(refund.blocks.some((b) => b.t === 'image')).toBe(false)
	})

	it('prints Check ID, the masked callback number and the totals', () => {
		const doc = buildReceipt({
			receipt,
			extras: { ...extras, config: DEFAULT_RECEIPT_EXTRAS },
			widthMm: 80,
		})
		const lines = texts(doc).join('\n')
		expect(lines).toContain('CHECK ID')
		expect(lines).toContain('Jordan · •••• 0111')
		expect(lines).toContain('Total|$25.30')
		expect(doc.blocks.some((b) => b.t === 'image')).toBe(false)
	})
})

describe('the test ticket and the drawer job (#426)', () => {
	it('is clearly marked as not a sale', () => {
		const doc = buildTestTicket({
			printerName: 'Bar',
			locationName: 'Main St',
			widthMm: 80,
			time: '18 Nov, 14:02',
		})
		const lines = texts(doc)
		expect(lines[0]).toBe('TEST PRINT')
		expect(lines).toContain('THIS IS NOT A SALE')
		expect(doc.kind).toBe('test')
		expect(JSON.stringify(doc)).not.toMatch(/total|tax|invoice/i)
	})

	it('a drawer job prints nothing and opens the drawer', () => {
		const doc = buildDrawerJob(80)
		expect(doc.blocks).toEqual([])
		expect(doc.drawer).toBe(true)
		expect(doc.cut).toBe(false)
	})
})

describe('food-safety labels (#523)', () => {
	const base = {
		nameEn: 'Garlic sauce',
		kind: 'made' as const,
		madeAtLabel: '27 Nov 14:05',
		useByLabel: '30 Nov 14:05',
		madeBy: 'Sara',
		quantityLabel: '2 L',
		storageNote: 'Keep at 4 C',
	}

	it('prints the name, made time, use-by time, maker and quantity on 2 inch stock', () => {
		const doc = buildLabelDoc(base)
		expect(doc.kind).toBe('label')
		expect(doc.widthMm).toBe(58)
		expect(texts(doc)).toEqual([
			'Garlic sauce',
			'Made|27 Nov 14:05',
			'Use by|30 Nov 14:05',
			'By|Sara',
			'Qty|2 L',
			'Keep at 4 C',
		])
		expect(doc.rtl).toBeUndefined()
		expect(docMentionsPhone(doc)).toBe(false)
	})

	it('shows the Arabic name when the item has one, and asks for a picture without an Arabic font', () => {
		const doc = buildLabelDoc({ ...base, nameAr: 'صلصة الثوم' })
		expect(texts(doc).slice(0, 2)).toEqual(['Garlic sauce', 'صلصة الثوم'])
		expect(doc.rtl).toBe(true)
		expect(needsPicture(doc, { arabicFont: false })).toBe(true)
		expect(needsPicture(doc, { arabicFont: true })).toBe(false)
		expect(texts(buildLabelDoc(base))).not.toContain('صلصة الثوم')
	})

	it('says Opened for a stock item and leaves out what it does not know', () => {
		const doc = buildLabelDoc({
			nameEn: 'Tahini',
			kind: 'opened',
			madeAtLabel: '27 Nov 09:00',
			copies: 3,
		})
		expect(texts(doc)).toEqual(['Tahini', 'Opened|27 Nov 09:00'])
		expect(doc.copies).toBe(3)
	})

	it('formats a time in the location zone with Latin digits', () => {
		// 20:30 UTC is 23:30 in Riyadh and 15:30 in New York.
		const at = Date.UTC(2026, 10, 27, 20, 30)
		expect(formatLabelTime(at, 'Asia/Riyadh')).toBe('27 Nov 23:30')
		expect(formatLabelTime(at, 'America/New_York')).toBe('27 Nov 15:30')
		expect(formatLabelTime(Date.UTC(2026, 10, 27, 21, 0), 'Asia/Riyadh')).toBe(
			'28 Nov 00:00',
		)
	})
})
