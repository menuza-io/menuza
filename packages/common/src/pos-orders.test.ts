import { describe, expect, it } from 'vitest'
import {
	posSignInRequestSchema,
	posStaffDisplayName,
	formatPosDeviceSecret,
	formatPosPairingCode,
	parsePosDeviceSecret,
	parsePosPairingCode,
	posOrderRequestSchema,
	randomPosToken,
} from './pos-orders.ts'
import {
	issuePosFiscalDocument,
	newPosFiscalChain,
	posRefundTaxCents,
} from './pos-fiscal.ts'

const line = {
	itemId: 'item-1',
	name: 'Burger',
	variantId: null,
	variantLabel: null,
	quantity: 2,
	baseCents: 1000,
	instructions: '',
	options: [
		{
			groupId: 'g',
			groupName: 'Extras',
			optionId: 'o',
			optionName: 'Cheese',
			quantity: 1,
			unitCents: 150,
			taxable: true,
		},
	],
}
// 2 x (1000 + 150) = 2300; tax 10% on 2300 = 230
const base = () => ({
	id: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01',
	revision: 1,
	status: 'open' as const,
	number: 'T1-0001',
	businessDate: '2026-10-21',
	createdAt: '2026-10-21T12:00:00.000Z',
	locationId: 'loc-1',
	currency: 'USD',
	orderType: 'dine_in' as const,
	customerName: null,
	tableLabel: '12',
	staff: null as { id: string; name: string } | null,
	signIn: null as 'online' | 'offline' | null,
	voidedBy: null as { id: string; name: string } | null,
	lines: [line],
	adjustments: [],
	totals: {
		subtotalCents: 2300,
		adjustmentCents: 0,
		taxCents: 230,
		tipCents: 0,
		totalCents: 2530,
	},
	payments: [] as unknown[],
})
const pay = (over: Record<string, unknown> = {}) => ({
	id: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c02',
	method: 'cash',
	amountCents: 2530,
	tenderedCents: 3000,
	at: '2026-10-21T12:30:00.000Z',
	staff: null,
	...over,
})
const parse = (o: unknown) => posOrderRequestSchema.safeParse(o)
const message = (o: unknown) => {
	const r = parse(o)
	return r.success ? null : r.error.issues[0]!.message
}

describe('credentials', () => {
	it('round-trips a pairing code and device secret', () => {
		const code = formatPosPairingCode('org_1', randomPosToken())
		expect(parsePosPairingCode(code)?.orgId).toBe('org_1')
		const secret = formatPosDeviceSecret(
			'org_1',
			'device-123',
			randomPosToken(),
		)
		expect(parsePosDeviceSecret(secret)).toMatchObject({
			orgId: 'org_1',
			deviceId: 'device-123',
		})
	})

	it('never confuses the two credential kinds or kiosk credentials', () => {
		const code = formatPosPairingCode('org_1', randomPosToken())
		const secret = formatPosDeviceSecret(
			'org_1',
			'device-123',
			randomPosToken(),
		)
		expect(parsePosDeviceSecret(code)).toBeNull()
		expect(parsePosPairingCode(secret)).toBeNull()
		expect(parsePosDeviceSecret(secret.replace('pdv1', 'kdv1'))).toBeNull()
	})

	it('rejects malformed, oversized and non-string values', () => {
		for (const bad of [
			undefined,
			null,
			5,
			'',
			'ppc1.org.short',
			'ppc1..' + 'a'.repeat(43),
			'x'.repeat(500),
		]) {
			expect(parsePosPairingCode(bad)).toBeNull()
			expect(parsePosDeviceSecret(bad)).toBeNull()
		}
	})

	it('generates distinct 256-bit tokens', () => {
		expect(randomPosToken()).toHaveLength(43)
		expect(randomPosToken()).not.toBe(randomPosToken())
	})
})

describe('posOrderRequestSchema', () => {
	it('defaults old tills to counter and round-trips phone pickup metadata', () => {
		expect(posOrderRequestSchema.parse(base())).toMatchObject({
			orderSource: 'counter',
			customerPhone: null,
			pickupAt: null,
			pickupTimeZone: null,
		})
		const phone = {
			...base(),
			orderType: 'takeaway',
			orderSource: 'phone',
			tableLabel: null,
			customerName: 'Sam',
			customerPhone: '+٩٦٦ (٥٠) ١٢٣-٤٥٦٧',
			pickupAt: '2026-10-24T15:30:00Z',
			pickupTimeZone: 'Asia/Riyadh',
		}
		expect(posOrderRequestSchema.parse(phone)).toMatchObject({
			orderSource: 'phone',
			customerPhone: '+966501234567',
			pickupAt: phone.pickupAt,
		})
		expect(parse({ ...phone, orderType: 'dine_in' }).success).toBe(false)
		expect(parse({ ...phone, orderType: 'delivery' }).success).toBe(false)
		expect(parse({ ...phone, orderSource: 'counter' }).success).toBe(false)
		expect(parse({ ...phone, customerPhone: '123' }).success).toBe(false)
		expect(parse({ ...phone, pickupTimeZone: 'invalid-zone' }).success).toBe(
			false,
		)
		expect(
			parse({ ...phone, customerName: null, customerPhone: null }).success,
		).toBe(true)
	})
	it('accepts an open tab, a part-paid tab, a paid order and a cancelled tab', () => {
		expect(parse(base()).success).toBe(true)
		expect(
			parse({
				...base(),
				payments: [
					pay({ amountCents: 1000, tenderedCents: 1000, method: 'card' }),
				],
			}).success,
		).toBe(true)
		expect(
			parse({ ...base(), status: 'paid', payments: [pay()] }).success,
		).toBe(true)
		expect(parse({ ...base(), status: 'void' }).success).toBe(true)
	})

	it('rejects unknown fields so nothing rides along', () => {
		expect(parse({ ...base(), customerPhone: '+15551234567' }).success).toBe(
			false,
		)
		expect(
			parse({ ...base(), lines: [{ ...line, discount: 5 }] }).success,
		).toBe(false)
	})

	it('rejects arithmetic that does not add up', () => {
		expect(
			message({ ...base(), totals: { ...base().totals, subtotalCents: 2299 } }),
		).toMatch(/subtotal/)
		expect(
			message({ ...base(), totals: { ...base().totals, totalCents: 2531 } }),
		).toMatch(/total/)
	})

	it('rejects status that contradicts the payments', () => {
		expect(message({ ...base(), status: 'paid', payments: [] })).toMatch(
			/fully paid/,
		)
		expect(
			message({
				...base(),
				status: 'paid',
				payments: [pay({ amountCents: 1000, tenderedCents: 1000 })],
			}),
		).toMatch(/fully paid/)
		expect(message({ ...base(), status: 'open', payments: [pay()] })).toMatch(
			/cannot stay open/,
		)
		expect(
			message({
				...base(),
				status: 'void',
				payments: [pay({ amountCents: 1000, tenderedCents: 1000 })],
			}),
		).toMatch(/cancelled/)
	})

	it('rejects overpayment, duplicate payment ids and bad tender', () => {
		expect(
			message({
				...base(),
				status: 'paid',
				payments: [
					pay(),
					pay({
						id: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c03',
						amountCents: 1,
						tenderedCents: 1,
					}),
				],
			}),
		).toMatch(/exceed/)
		const two = [
			pay({ amountCents: 1000, tenderedCents: 1000 }),
			pay({ amountCents: 1000, tenderedCents: 1000 }),
		]
		expect(message({ ...base(), payments: two })).toMatch(/duplicate/)
		expect(
			message({
				...base(),
				status: 'paid',
				payments: [pay({ tenderedCents: 2000 })],
			}),
		).toMatch(/tendered/)
		expect(
			message({
				...base(),
				payments: [
					pay({ method: 'card', amountCents: 1000, tenderedCents: 1200 }),
				],
			}),
		).toMatch(/tendered/)
	})

	it('requires a well-formed business date', () => {
		for (const bad of [
			'',
			'21-10-2026',
			'2026-1-21',
			'today',
			'2026-10-21T00:00:00Z',
		]) {
			expect(parse({ ...base(), businessDate: bad }).success).toBe(false)
		}
		expect(parse({ ...base(), businessDate: undefined }).success).toBe(false)
	})

	it('requires a three-letter uppercase currency', () => {
		for (const bad of ['', 'us', 'usd', 'USDD', '$', undefined])
			expect(parse({ ...base(), currency: bad }).success).toBe(false)
		expect(parse({ ...base(), currency: 'SAR' }).success).toBe(true)
	})

	it('validates ids, revision and sizes', () => {
		expect(parse({ ...base(), id: 'not-a-uuid' }).success).toBe(false)
		expect(parse({ ...base(), revision: 0 }).success).toBe(false)
		expect(parse({ ...base(), lines: [] }).success).toBe(false)
		expect(
			parse({ ...base(), lines: Array.from({ length: 51 }, () => line) })
				.success,
		).toBe(false)
		expect(parse({ ...base(), createdAt: 'yesterday' }).success).toBe(false)
		expect(
			parse({ ...base(), lines: [{ ...line, quantity: 51 }] }).success,
		).toBe(false)
	})

	it('accounts for adjustments before tax', () => {
		const order = {
			...base(),
			adjustments: [
				{ id: 'd1', kind: 'discount', label: '10% off', amountCents: 230 },
			],
			totals: {
				subtotalCents: 2300,
				adjustmentCents: 230,
				taxCents: 207,
				tipCents: 0,
				totalCents: 2277,
			},
		}
		expect(parse(order).success).toBe(true)
		expect(
			message({ ...order, totals: { ...order.totals, adjustmentCents: 0 } }),
		).toBeTruthy()
	})
})

describe('text that is signed into ZATCA documents', () => {
	it('stores item names and variant labels without characters XML does not allow', () => {
		const r = parse({
			...base(),
			lines: [
				{
					...line,
					name: 'Bur\u0001ger\uD800 \uD83C\uDF54',
					variantLabel: 'Large\u001F\uFFFF',
				},
			],
		})
		expect(r.success).toBe(true)
		if (!r.success) return
		expect(r.data.lines[0]!.name).toBe('Burger \uD83C\uDF54')
		expect(r.data.lines[0]!.variantLabel).toBe('Large')
	})

	it('refuses a name that is nothing but such characters', () => {
		expect(
			parse({ ...base(), lines: [{ ...line, name: '\u0000\u0001' }] }).success,
		).toBe(false)
	})
})

describe('who did it', () => {
	const ana = { id: 'staff-1', name: 'Ana K.' }

	it('accepts staff on the order, each payment and a cancellation, or none at all', () => {
		expect(parse({ ...base(), staff: ana, signIn: 'online' }).success).toBe(
			true,
		)
		expect(
			parse({
				...base(),
				staff: ana,
				signIn: 'offline',
				payments: [
					pay({
						amountCents: 1000,
						tenderedCents: 1000,
						staff: { id: 'staff-2', name: 'Omar R.' },
					}),
				],
			}).success,
		).toBe(true)
		expect(
			parse({
				...base(),
				status: 'void',
				staff: ana,
				signIn: 'online',
				voidedBy: { id: 'staff-3', name: 'Lina M.' },
			}).success,
		).toBe(true)
		expect(parse(base()).success).toBe(true)
	})

	it('requires the fields to be present (null is how a terminal without sign-in says so)', () => {
		const { staff: _s, ...noStaff } = base()
		expect(parse(noStaff).success).toBe(false)
		const { signIn: _i, ...noSignIn } = base()
		expect(parse(noSignIn).success).toBe(false)
	})

	it('rejects malformed staff and unknown sign-in modes', () => {
		for (const bad of [
			{ id: '', name: 'Ana' },
			{ id: 'x', name: '' },
			{ id: 'x', name: 'A'.repeat(121) },
			{ id: 'x', name: 'Ana', role: 'manager' },
			'Ana',
		]) {
			expect(parse({ ...base(), staff: bad }).success).toBe(false)
		}
		expect(parse({ ...base(), signIn: 'magic' }).success).toBe(false)
	})
})

describe('posSignInRequestSchema', () => {
	it('takes only a 4 to 6 digit PIN', () => {
		for (const pin of ['1234', '123456'])
			expect(posSignInRequestSchema.safeParse({ pin }).success).toBe(true)
		for (const pin of ['123', '1234567', '12a4', '', ' 1234', '12 34'])
			expect(posSignInRequestSchema.safeParse({ pin }).success).toBe(false)
		expect(
			posSignInRequestSchema.safeParse({ pin: '1234', extra: 1 }).success,
		).toBe(false)
	})
})

describe('posStaffDisplayName', () => {
	it('is the first name and last initial', () => {
		expect(posStaffDisplayName('Ana', 'Karim')).toBe('Ana K.')
		expect(posStaffDisplayName(' omar ', ' rahman ')).toBe('omar R.')
		expect(posStaffDisplayName('Cher', '')).toBe('Cher')
		expect(posStaffDisplayName('', '')).toBe('Staff')
	})
})

describe('contract v2: refunds, voids and fiscal documents', () => {
	const chainId = '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c90'
	const paid = () => ({
		...base(),
		status: 'paid' as const,
		payments: [
			pay({ method: 'card', tenderedCents: 2530, reference: 'AUTH 123' }),
		],
	})
	const invoice = () => {
		const { document, head } = issuePosFiscalDocument(
			newPosFiscalChain(chainId),
			{
				kind: 'invoice',
				docId: base().id,
				orderId: base().id,
				at: '2026-10-21T12:30:00.000Z',
				currency: 'USD',
				totalCents: 2530,
				taxCents: 230,
			},
		)
		return { document, head }
	}
	const refund = (over: Record<string, unknown> = {}) => ({
		id: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c10',
		paymentId: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c02',
		method: 'card',
		amountCents: 2530,
		at: '2026-10-21T13:00:00.000Z',
		by: { id: 's1', name: 'Sara K.' },
		approvedBy: null,
		reason: 'wrong_charge',
		reference: null,
		...over,
	})
	const creditFor = (
		head: ReturnType<typeof invoice>['head'],
		amountCents: number,
	) =>
		issuePosFiscalDocument(head, {
			kind: 'credit_note',
			docId: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c10',
			orderId: base().id,
			at: '2026-10-21T13:00:00.000Z',
			currency: 'USD',
			totalCents: amountCents,
			taxCents: posRefundTaxCents(
				{ totalCents: 2530, taxCents: 230 },
				amountCents,
			),
		}).document

	it('accepts a version 1 order unchanged, filling the new fields with defaults', () => {
		const result = parse(base())
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.refunds).toEqual([])
			expect(result.data.lineVoids).toEqual([])
			expect(result.data.taxInclusive).toBe(false)
		}
	})

	it('accepts a full refund with its credit note, and requires the refunded status', () => {
		const inv = invoice()
		const order = {
			...paid(),
			status: 'refunded',
			refunds: [refund()],
			fiscal: [inv.document, creditFor(inv.head, 2530)],
		}
		expect(message(order)).toBeNull()
		expect(message({ ...order, status: 'paid' })).toBe(
			'a fully refunded order must be marked refunded',
		)
	})

	it('refuses refunds that exceed the payment, change tender, or lack a credit note', () => {
		const inv = invoice()
		expect(
			message({
				...paid(),
				refunds: [refund({ amountCents: 2531 })],
				fiscal: [inv.document, creditFor(inv.head, 2531)],
			}),
		).toBe('refunds exceed the payment')
		expect(
			message({
				...paid(),
				refunds: [refund({ method: 'cash', amountCents: 100 })],
				fiscal: [inv.document, creditFor(inv.head, 100)],
			}),
		).toBe('a refund goes back in the tender it was paid with')
		expect(
			message({ ...paid(), refunds: [refund({ amountCents: 100 })] }),
		).toBe('a refund needs its credit note')
		expect(
			message({ ...base(), refunds: [refund({ amountCents: 100 })] }),
		).toBe('only a paid order can be refunded')
	})

	it('checks that the invoice documents the bill', () => {
		const inv = invoice()
		expect(message({ ...paid(), fiscal: [inv.document] })).toBeNull()
		expect(
			message({ ...paid(), fiscal: [{ ...inv.document, totalCents: 1 }] }),
		).toBe('the invoice does not match the bill')
		expect(message({ ...base(), fiscal: [inv.document] })).toBe(
			'only a closed sale has fiscal documents',
		)
	})

	it('adds no tax on top when prices include it', () => {
		const inclusive = {
			...base(),
			taxInclusive: true,
			totals: {
				subtotalCents: 2300,
				adjustmentCents: 0,
				taxCents: 300,
				tipCents: 0,
				totalCents: 2300,
			},
		}
		expect(message(inclusive)).toBeNull()
	})

	it('refuses a card reference that looks like anything but a short code', () => {
		expect(
			message({
				...paid(),
				payments: [
					pay({ method: 'card', tenderedCents: 2530, reference: '<script>' }),
				],
			}),
		).toMatch(/reference/)
	})

	it('needs exactly one invoice on a closed sale with fiscal documents, and a signed ZATCA document for the same amount', () => {
		const inv = invoice()
		const credit = issuePosFiscalDocument(inv.head, {
			kind: 'credit_note',
			docId: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c10',
			orderId: base().id,
			at: '2026-10-21T13:00:00.000Z',
			currency: 'USD',
			totalCents: 2530,
			taxCents: 230,
		}).document
		expect(
			message({
				...paid(),
				status: 'refunded',
				refunds: [refund()],
				fiscal: [credit],
			}),
		).toBe('a closed sale has exactly one invoice')
		const zatca = {
			invoiceNumber: 'T1-0001-20261021',
			uuid: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c11',
			invoiceHash: 'A'.repeat(43) + '=',
			xml: 'eA==',
			qr: 'AQI=',
			totalCents: 2530,
			taxCents: 231,
		}
		expect(
			message({ ...paid(), fiscal: [{ ...inv.document, zatca }] }),
		).toBeNull()
		expect(
			message({
				...paid(),
				fiscal: [{ ...inv.document, zatca: { ...zatca, totalCents: 2529 } }],
			}),
		).toBe('the signed ZATCA document does not match its fiscal document')
	})
})
