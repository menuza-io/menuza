import {
	type ReceivePrefill,
	recordDeliveryResultSchema,
	recordDeliverySchema,
	type SupplierProduct,
} from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	buildInlineItemPayload,
	buildRecordDelivery,
	computeLine,
	type DeliveryDraft,
	type DeliveryLineDraft,
	deliveryTotals,
	defaultPackChoice,
	isUnreceivedOrderLine,
	linesFromPrefill,
	newLineDraft,
	type PackChoice,
	packChoicesFor,
	reconcilePack,
	shortOrderLines,
	visiblePriceChangeBp,
	withPack,
} from './delivery-form.ts'

const BOX: PackChoice = {
	id: 'product:sp_1',
	name: 'Box',
	baseQuantity: 10_000_000, // 10 kg
	productId: 'sp_1',
	pricedByWeight: false,
	priceMinor: 28_000,
}

function line(overrides: Partial<DeliveryLineDraft> = {}): DeliveryLineDraft {
	return {
		key: 'l1',
		itemId: 'itm_1',
		itemName: 'Chicken thighs',
		baseUnit: 'g',
		pack: BOX,
		packsText: '2',
		priceText: '280',
		weightText: '',
		weightUnit: 'kg',
		totalText: '',
		previousCostMicro: null,
		...overrides,
	}
}

function draft(overrides: Partial<DeliveryDraft> = {}): DeliveryDraft {
	return {
		supplierId: 'sup_1',
		invoiceNumber: 'INV-4471',
		invoiceDate: '2026-11-03',
		vatText: '',
		invoiceTotalText: '',
		zatcaReference: '',
		paid: false,
		lines: [line()],
		...overrides,
	}
}

const CONTEXT = {
	clientId: 'del-12345678',
	locationId: 'main',
	currency: 'SAR',
}

describe('computeLine', () => {
	it('multiplies packs by pack size and price', () => {
		const result = computeLine(line(), 'SAR')
		expect(result.problems).toEqual([])
		expect(result.quantity).toBe(20_000_000) // 20 kg
		expect(result.packPriceMinor).toBe(28_000)
		expect(result.lineTotalMinor).toBe(56_000) // SAR 560
		// SAR 560 for 20 kg: 2.8 halalas a gram = 2,800,000 micro-halalas.
		expect(result.costMicro).toBe(2_800_000)
	})

	it('takes part packs', () => {
		const result = computeLine(line({ packsText: '1½' }), 'SAR')
		expect(result.quantity).toBe(15_000_000)
		expect(result.lineTotalMinor).toBe(42_000)
	})

	it('goods priced by weight are billed on the real weight, not the nominal pack', () => {
		const result = computeLine(
			line({
				pack: { ...BOX, pricedByWeight: true },
				packsText: '1',
				weightText: '10.4',
				weightUnit: 'kg',
			}),
			'SAR',
		)
		expect(result.problems).toEqual([])
		expect(result.realWeightQuantity).toBe(10_400_000)
		expect(result.quantity).toBe(10_400_000)
		// SAR 28.00 a kg times 10.4 kg.
		expect(result.lineTotalMinor).toBe(29_120)
	})

	it('asks for the real weight when the line is priced by weight', () => {
		const result = computeLine(
			line({ pack: { ...BOX, pricedByWeight: true }, weightText: '' }),
			'SAR',
		)
		expect(result.problems).toContain('weight')
		expect(result.quantity).toBeNull()
	})

	it('lets the invoice line total win over packs times price', () => {
		const result = computeLine(line({ totalText: '559.90' }), 'SAR')
		expect(result.lineTotalMinor).toBe(55_990)
		expect(result.quantity).toBe(20_000_000)
	})

	it('flags what is missing or unreadable', () => {
		expect(computeLine(line({ packsText: '' }), 'SAR').problems).toEqual([
			'packs',
		])
		expect(computeLine(line({ packsText: '0' }), 'SAR').problems).toContain(
			'packs',
		)
		expect(computeLine(line({ priceText: '' }), 'SAR').problems).toContain(
			'price',
		)
		expect(computeLine(line({ priceText: '4,50' }), 'SAR').problems).toContain(
			'price',
		)
		expect(computeLine(line({ totalText: 'abc' }), 'SAR').problems).toContain(
			'total',
		)
		expect(computeLine(line({ totalText: '0' }), 'SAR').problems).toContain(
			'total',
		)
	})

	it('refuses a quantity the region would refuse', () => {
		expect(
			computeLine(line({ packsText: '999999' }), 'SAR').problems,
		).toContain('packs')
	})

	it('shows how much the price moved against the last cost', () => {
		// Last cost SAR 25 a kg (2.5 halalas a gram); now SAR 28 a kg.
		const result = computeLine(line({ previousCostMicro: 2_500_000 }), 'SAR')
		expect(result.changeBp).toBe(1200) // +12%
		expect(visiblePriceChangeBp(result.changeBp)).toBe(1200)
		expect(
			computeLine(line({ previousCostMicro: 2_800_000 }), 'SAR').changeBp,
		).toBe(0)
		expect(visiblePriceChangeBp(0)).toBeNull()
		expect(
			computeLine(line({ previousCostMicro: null }), 'SAR').changeBp,
		).toBeNull()
	})

	it('shows a fall as a negative change', () => {
		expect(
			computeLine(line({ previousCostMicro: 3_500_000 }), 'SAR').changeBp,
		).toBe(-2000)
	})

	it('reads Arabic digits', () => {
		const result = computeLine(
			line({ packsText: '٢', priceText: '٢٨٠' }),
			'SAR',
		)
		expect(result.problems).toEqual([])
		expect(result.lineTotalMinor).toBe(56_000)
	})
})

describe('deliveryTotals', () => {
	const two = [
		computeLine(line({ key: 'a', packsText: '2' }), 'SAR'),
		computeLine(line({ key: 'b', packsText: '1', priceText: '152' }), 'SAR'),
	]

	it('adds the lines', () => {
		const totals = deliveryTotals(two, {
			vatText: '',
			invoiceTotalText: '',
			currency: 'SAR',
		})
		expect(totals.linesMinor).toBe(56_000 + 15_200)
		expect(totals.state).toBe('none')
		expect(totals.differenceMinor).toBeNull()
	})

	it('says how far the lines are from the invoice', () => {
		const totals = deliveryTotals(two, {
			vatText: '',
			invoiceTotalText: '720',
			currency: 'SAR',
		})
		expect(totals.state).toBe('apart')
		expect(totals.differenceMinor).toBe(800) // SAR 8 apart
	})

	it('compares the invoice total with lines plus VAT, never lines alone', () => {
		const totals = deliveryTotals(two, {
			vatText: '106.80',
			invoiceTotalText: '818.80',
			currency: 'SAR',
		})
		expect(totals.vatMinor).toBe(10_680)
		expect(totals.state).toBe('match')
		expect(totals.differenceMinor).toBe(0)
	})

	it('does not break on an unreadable total', () => {
		const totals = deliveryTotals(two, {
			vatText: 'x',
			invoiceTotalText: 'y',
			currency: 'SAR',
		})
		expect(totals.state).toBe('none')
		expect(totals.vatMinor).toBeNull()
	})
})

describe('buildRecordDelivery', () => {
	it('builds a body the region accepts, with VAT apart from prices', () => {
		const result = buildRecordDelivery(
			draft({
				vatText: '84',
				invoiceTotalText: '644',
				zatcaReference: 'ZATCA-1',
				paid: true,
			}),
			CONTEXT,
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.payload).toMatchObject({
			clientId: 'del-12345678',
			locationId: 'main',
			supplierId: 'sup_1',
			invoiceNumber: 'INV-4471',
			invoiceDate: '2026-11-03',
			currency: 'SAR',
			vatMinor: 8_400,
			totalMinor: 64_400,
			zatcaReference: 'ZATCA-1',
			paid: true,
		})
		expect(result.payload.lines[0]).toEqual({
			itemId: 'itm_1',
			supplierProductId: 'sp_1',
			quantity: 20_000_000,
			packs: 2,
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			packPriceMinor: 28_000,
			lineTotalMinor: 56_000,
		})
		expect(recordDeliverySchema.safeParse(result.payload).success).toBe(true)
	})

	it('leaves out what was not typed', () => {
		const result = buildRecordDelivery(
			draft({ invoiceNumber: '', invoiceDate: '', supplierId: '' }),
			CONTEXT,
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.payload.supplierId).toBeNull()
		expect(result.payload).not.toHaveProperty('invoiceNumber')
		expect(result.payload).not.toHaveProperty('invoiceDate')
		expect(result.payload).not.toHaveProperty('vatMinor')
		expect(result.payload).not.toHaveProperty('totalMinor')
		expect(result.payload).not.toHaveProperty('zatcaReference')
		expect(result.payload.lines[0]).not.toHaveProperty('supplierProductId')
		expect(recordDeliverySchema.safeParse(result.payload).success).toBe(true)
	})

	it('sends the real weight for a line priced by weight', () => {
		const result = buildRecordDelivery(
			draft({
				lines: [
					line({
						pack: { ...BOX, pricedByWeight: true },
						packsText: '1',
						weightText: '10.4',
					}),
				],
			}),
			CONTEXT,
		)
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.payload.lines[0]).toMatchObject({
			quantity: 10_400_000,
			realWeightQuantity: 10_400_000,
			lineTotalMinor: 29_120,
		})
		expect(recordDeliverySchema.safeParse(result.payload).success).toBe(true)
	})

	it('refuses a draft with no lines, and names the line that is wrong', () => {
		const empty = buildRecordDelivery(draft({ lines: [] }), CONTEXT)
		expect(empty).toEqual({
			ok: false,
			problems: { header: ['lines'], lines: {} },
		})
		const bad = buildRecordDelivery(
			draft({ lines: [line({ key: 'x', priceText: '' })] }),
			CONTEXT,
		)
		expect(bad.ok).toBe(false)
		if (bad.ok) return
		expect(bad.problems.lines).toEqual({ x: ['price'] })
	})

	it('refuses unreadable header fields', () => {
		const result = buildRecordDelivery(
			draft({
				vatText: 'a',
				invoiceTotalText: 'b',
				invoiceDate: '3 Nov',
				invoiceNumber: 'x'.repeat(61),
			}),
			CONTEXT,
		)
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.problems.header.sort()).toEqual(
			['invoiceDate', 'invoiceNumber', 'invoiceTotal', 'vat'].sort(),
		)
	})
})

describe('packs', () => {
	const product = (
		overrides: Partial<SupplierProduct> = {},
	): SupplierProduct => ({
		id: 'sp_1',
		supplierId: 'sup_1',
		itemId: 'itm_1',
		itemName: 'Chicken',
		packName: 'Box',
		packBaseQuantity: 10_000_000,
		pricedByWeight: false,
		sku: null,
		preferred: false,
		version: 1,
		priceMinor: 28_000,
		currency: 'SAR',
		...overrides,
	})
	const unitLabel = (unit: string) => unit

	it('offers the supplier packs first (preferred leading), then the item units, then plain units', () => {
		const choices = packChoicesFor({
			baseUnit: 'g',
			units: [
				{ id: 'u1', name: 'Bag', baseQuantity: 25_000_000, archived: false },
				{ id: 'u2', name: 'Old', baseQuantity: 1, archived: true },
				// Same pack as the supplier's: not offered twice.
				{ id: 'u3', name: 'box', baseQuantity: 10_000_000, archived: false },
			],
			products: [
				product({ id: 'sp_2', packName: 'Case', preferred: false }),
				product({ id: 'sp_1', preferred: true }),
			],
			system: 'metric',
			unitLabel,
		})
		expect(choices.map((choice) => choice.id)).toEqual([
			'product:sp_1',
			'product:sp_2',
			'unit:u1',
			'g',
			'kg',
		])
		expect(choices[0]).toMatchObject({
			productId: 'sp_1',
			priceMinor: 28_000,
			baseQuantity: 10_000_000,
		})
		expect(choices.at(-1)).toMatchObject({ id: 'kg', baseQuantity: 1_000_000 })
	})

	it('has no remembered price without the cost grant', () => {
		const choices = packChoicesFor({
			baseUnit: 'g',
			units: [],
			products: [product({ priceMinor: undefined })],
			system: 'metric',
			unitLabel,
		})
		expect(choices[0]!.priceMinor).toBeNull()
	})

	it('starts with the supplier pack, else how the item is counted', () => {
		const choices = packChoicesFor({
			baseUnit: 'g',
			units: [],
			products: [],
			system: 'metric',
			unitLabel,
		})
		expect(defaultPackChoice(choices, 'kg')?.id).toBe('kg')
		expect(defaultPackChoice(choices, null)?.id).toBe('g')
		const withProduct = packChoicesFor({
			baseUnit: 'g',
			units: [],
			products: [product()],
			system: 'metric',
			unitLabel,
		})
		expect(defaultPackChoice(withProduct, 'kg')?.productId).toBe('sp_1')
		expect(defaultPackChoice([], 'kg')).toBeNull()
	})

	it('prefills the remembered price and follows a change of pack', () => {
		const start = newLineDraft({
			key: 'k',
			itemId: 'itm_1',
			itemName: 'Chicken',
			baseUnit: 'g',
			pack: BOX,
			currency: 'SAR',
			system: 'metric',
			previousCostMicro: 2_800_000,
		})
		expect(start.priceText).toBe('280.00')
		expect(start.packsText).toBe('')
		expect(start.weightUnit).toBe('kg')
		const kg: PackChoice = {
			id: 'kg',
			name: 'kg',
			baseQuantity: 1_000_000,
			productId: null,
			pricedByWeight: false,
			priceMinor: null,
		}
		expect(withPack(start, kg, 'SAR').priceText).toBe('')
		// Choosing the same pack again keeps what was typed.
		const typed = { ...start, priceText: '281', totalText: '5' }
		expect(withPack(typed, BOX, 'SAR').priceText).toBe('280.00')
	})
})

describe('reconcilePack', () => {
	const KG: PackChoice = {
		id: 'kg',
		name: 'kg',
		baseQuantity: 1_000_000,
		productId: null,
		pricedByWeight: false,
		priceMinor: null,
	}

	it('falls back to a pack that is still offered when the supplier changes', () => {
		const next = reconcilePack(line(), [KG], 'kg', 'SAR')
		expect(next.pack.id).toBe('kg')
		expect(next.priceText).toBe('')
	})

	it('moves an unpriced line to the supplier pack, but never one the person priced', () => {
		const unpriced = line({ pack: KG, priceText: '' })
		expect(reconcilePack(unpriced, [KG, BOX], 'kg', 'SAR').pack.id).toBe(BOX.id)
		const priced = line({ pack: KG, priceText: '30' })
		expect(reconcilePack(priced, [KG, BOX], 'kg', 'SAR')).toBe(priced)
	})

	it('leaves a valid line alone', () => {
		const same = line()
		expect(reconcilePack(same, [BOX, KG], 'kg', 'SAR')).toBe(same)
	})
})

describe('buildInlineItemPayload', () => {
	it('makes a minimal item counted in the unit that reads best', () => {
		const payload = buildInlineItemPayload({
			clientId: 'i-12345678',
			name: '  Saffron ',
			measuredIn: 'weight',
			category: 'dry_goods',
			locationId: 'main',
			system: 'metric',
		})
		expect(payload).toMatchObject({
			name: 'Saffron',
			baseUnit: 'g',
			kind: 'bought',
			place: { locationId: 'main', countUnit: 'kg', areaIds: [] },
		})
		const count = buildInlineItemPayload({
			clientId: 'i-12345678',
			name: 'Cups',
			measuredIn: 'count',
			category: 'packaging',
			locationId: 'main',
			system: 'us',
		})
		expect(count.baseUnit).toBe('piece')
		expect(count.place?.countUnit).toBe('piece')
	})
})

describe('the answer', () => {
	it('reads a result with price rises, and one without the cost grant', () => {
		const delivery = {
			id: 'd1',
			locationId: 'main',
			supplierId: null,
			supplierName: null,
			status: 'received',
			invoiceNumber: null,
			invoiceDate: null,
			businessDate: '2026-11-03',
			source: 'operator',
			receivedAt: 1,
			receivedBy: { kind: 'operator', id: 'u1' },
			lineCount: 1,
			paid: false,
			paidAt: null,
			version: 1,
			zatcaReference: null,
			lines: [],
		}
		const withRises = recordDeliveryResultSchema.parse({
			delivery,
			priceChanges: [
				{
					itemId: 'i1',
					itemName: 'Tomatoes',
					previousCostMicro: 100,
					costMicro: 114,
					changeBp: 1400,
				},
			],
		})
		expect(withRises.priceChanges).toHaveLength(1)
		expect(
			recordDeliveryResultSchema.parse({ delivery }).priceChanges,
		).toBeUndefined()
	})
})

const PREFILL: ReceivePrefill = {
	orderId: 'o1',
	number: 12,
	locationId: 'main',
	supplierId: 'sup_1',
	supplierName: 'Al Watania',
	status: 'sent',
	expectedDate: '2026-11-12',
	currency: 'SAR',
	lines: [
		{
			orderLineId: 'ol1',
			itemId: 'itm_1',
			itemName: 'Chicken thighs',
			baseUnit: 'g',
			countUnit: 'kg',
			supplierProductId: 'sp_1',
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			pricedByWeight: false,
			orderedPacks: 3,
			orderedQuantity: 30_000_000,
			receivedQuantity: 10_000_000,
			outstandingQuantity: 20_000_000,
			outstandingPacks: 2,
			packPriceMinor: 28_000,
			lineTotalMinor: 56_000,
		},
		{
			orderLineId: 'ol2',
			itemId: 'itm_2',
			itemName: 'Garlic',
			baseUnit: 'g',
			countUnit: 'kg',
			supplierProductId: null,
			packName: 'Net',
			packBaseQuantity: 5_000_000,
			pricedByWeight: false,
			orderedPacks: 1,
			orderedQuantity: 5_000_000,
			receivedQuantity: 5_000_000,
			outstandingQuantity: 0,
			outstandingPacks: 0,
			packPriceMinor: 4_000,
			lineTotalMinor: 0,
		},
	],
}

describe('receiving against an order', () => {
	const options = {
		currency: 'SAR',
		system: 'metric',
		withPrices: true,
	} as const

	it('starts every line at what is still to come, at the supplier price', () => {
		const lines = linesFromPrefill(PREFILL, options)
		expect(lines[0]).toMatchObject({
			key: 'ol1',
			packsText: '2',
			priceText: '280.00',
			pack: { id: 'product:sp_1', productId: 'sp_1', priceMinor: 28_000 },
			order: { orderLineId: 'ol1', orderedQuantity: 30_000_000 },
		})
		// A line already complete starts at nothing, with no supplier product to point at.
		expect(lines[1]).toMatchObject({
			packsText: '',
			pack: { id: 'orderline:ol2', productId: null },
		})
		expect(lines[0]!.previousCostMicro).toBe(2_800_000)
	})

	it('starts without prices for someone who cannot see them', () => {
		const lines = linesFromPrefill(PREFILL, { ...options, withPrices: false })
		expect(lines[0]).toMatchObject({ priceText: '', previousCostMicro: null })
	})

	it('builds a body that names the order and each order line, and leaves out lines nothing arrived for', () => {
		const lines = linesFromPrefill(PREFILL, options)
		const built = buildRecordDelivery(
			draft({ orderId: 'o1', closeOrder: true, lines }),
			{ clientId: 'd-12345678', locationId: 'main', currency: 'SAR' },
		)
		expect(built.ok).toBe(true)
		if (!built.ok) return
		expect(recordDeliverySchema.safeParse(built.payload).success).toBe(true)
		expect(built.payload).toMatchObject({
			orderId: 'o1',
			closeOrder: true,
			lines: [
				{
					itemId: 'itm_1',
					orderLineId: 'ol1',
					orderedQuantity: 30_000_000,
					quantity: 20_000_000,
					packs: 2,
					lineTotalMinor: 56_000,
				},
			],
		})
		expect(built.payload.lines).toHaveLength(1)
	})

	it('refuses a delivery where nothing arrived', () => {
		const lines = linesFromPrefill(PREFILL, options).map((entry) => ({
			...entry,
			packsText: '',
		}))
		const built = buildRecordDelivery(draft({ orderId: 'o1', lines }), {
			clientId: 'd-12345678',
			locationId: 'main',
			currency: 'SAR',
		})
		expect(built).toMatchObject({ ok: false, problems: { header: ['lines'] } })
	})

	it('tells what came short or missing once this delivery is counted in', () => {
		const lines = linesFromPrefill(PREFILL, options)
		lines[0] = { ...lines[0]!, packsText: '1' }
		expect(isUnreceivedOrderLine(lines[1]!)).toBe(true)
		const short = shortOrderLines(draft({ lines }), 'SAR')
		// 10 kg earlier + 10 kg now of 30 kg ordered.
		expect(short).toEqual([
			expect.objectContaining({
				orderLineId: 'ol1',
				kind: 'short',
				shortQuantity: 10_000_000,
			}),
		])
		lines[0] = { ...lines[0]!, packsText: '' }
		expect(shortOrderLines(draft({ lines }), 'SAR')[0]).toMatchObject({
			kind: 'short',
			shortQuantity: 20_000_000,
		})
	})
})

describe('quantity-only recording', () => {
	it('needs no price, and sends no money', () => {
		const quantityLine = line({
			priceText: '',
			pack: { ...BOX, priceMinor: null },
		})
		expect(
			computeLine(quantityLine, 'SAR', { quantityOnly: true }),
		).toMatchObject({
			quantity: 20_000_000,
			packPriceMinor: null,
			lineTotalMinor: null,
			problems: [],
		})
		const built = buildRecordDelivery(
			draft({
				quantityOnly: true,
				paid: true,
				vatText: '8',
				invoiceTotalText: '99',
				lines: [quantityLine],
			}),
			{ clientId: 'd-12345678', locationId: 'main', currency: 'SAR' },
		)
		expect(built.ok).toBe(true)
		if (!built.ok) return
		expect(recordDeliverySchema.safeParse(built.payload).success).toBe(true)
		expect(built.payload).toMatchObject({ quantityOnly: true, paid: false })
		expect(built.payload).not.toHaveProperty('currency')
		expect(built.payload).not.toHaveProperty('vatMinor')
		expect(built.payload).not.toHaveProperty('totalMinor')
		expect(built.payload.lines[0]).not.toHaveProperty('lineTotalMinor')
		expect(built.payload.lines[0]).not.toHaveProperty('packPriceMinor')
	})

	it('still asks for the real weight on a line priced by weight', () => {
		const weighed = line({
			priceText: '',
			pack: { ...BOX, pricedByWeight: true },
			packsText: '1',
		})
		expect(
			computeLine(weighed, 'SAR', { quantityOnly: true }).problems,
		).toEqual(['weight'])
	})
})
