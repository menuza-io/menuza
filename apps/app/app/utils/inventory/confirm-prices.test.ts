import { type DeliveryDetail } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	buildConfirmPrices,
	confirmLineDrafts,
	confirmLineHint,
	matchInvoiceReadToConfirm,
	unpricedLines,
} from './confirm-prices.ts'

function delivery(): Pick<DeliveryDetail, 'lines'> {
	return {
		lines: [
			{
				id: 'dl1',
				itemId: 'i1',
				itemName: 'Chicken thighs',
				quantity: 20_000_000,
				packs: 2,
				packName: 'Box',
				realWeightQuantity: null,
				priced: false,
			},
			{
				id: 'dl2',
				itemId: 'i2',
				itemName: 'Beef',
				quantity: 9_800_000,
				packs: 1,
				packName: 'Carton',
				realWeightQuantity: 9_800_000,
				priced: false,
			},
			{
				id: 'dl3',
				itemId: 'i3',
				itemName: 'Salt',
				quantity: 1_000_000,
				packs: 1,
				packName: 'Bag',
				realWeightQuantity: null,
				priced: true,
			},
		],
	}
}

const HEADER = {
	invoiceNumber: '',
	invoiceDate: '',
	vatText: '',
	totalText: '',
	paid: false,
}

describe('confirm prices', () => {
	it('lists only the lines still waiting for a price', () => {
		expect(unpricedLines(delivery()).map((line) => line.id)).toEqual([
			'dl1',
			'dl2',
		])
		expect(confirmLineDrafts(delivery()).map((line) => line.weighed)).toEqual([
			false,
			true,
		])
	})

	it('works a line total out from packs times the typed price', () => {
		const [first] = confirmLineDrafts(delivery())
		first!.priceText = '280'
		expect(confirmLineHint(first!, 'SAR')).toBe('560.00')
	})

	it('builds the body with one entry per waiting line', () => {
		const [first, second] = confirmLineDrafts(delivery())
		first!.priceText = '280'
		second!.totalText = '412.50'
		const built = buildConfirmPrices(
			[first!, second!],
			{ ...HEADER, paid: true, vatText: '84' },
			{
				expectedVersion: 4,
				currency: 'SAR',
			},
		)
		expect(built).toEqual({
			ok: true,
			payload: {
				expectedVersion: 4,
				currency: 'SAR',
				vatMinor: 8400,
				paid: true,
				lines: [
					{ lineId: 'dl1', lineTotalMinor: 56_000, packPriceMinor: 28_000 },
					{ lineId: 'dl2', lineTotalMinor: 41_250 },
				],
			},
		})
	})

	it('needs a total for every line, and a total for a line priced by weight', () => {
		const [first, second] = confirmLineDrafts(delivery())
		second!.priceText = '40'
		const built = buildConfirmPrices([first!, second!], HEADER, {
			expectedVersion: 1,
			currency: 'SAR',
		})
		expect(built).toEqual({
			ok: false,
			lines: { dl1: ['total'], dl2: ['total'] },
			header: [],
		})
	})

	it('refuses a VAT or total that is not an amount', () => {
		const [first] = confirmLineDrafts(delivery())
		first!.totalText = '10'
		const built = buildConfirmPrices(
			[first!],
			{ ...HEADER, vatText: 'x', totalText: 'y' },
			{ expectedVersion: 1, currency: 'SAR' },
		)
		expect(built).toMatchObject({ ok: false, header: ['vat', 'total'] })
	})

	it('matches invoice-read lines, keeps raw text and warnings, and emits extraLines (#504)', () => {
		const read = {
			deliveryId: 'd1',
			supplierName: 'Fresh Farms',
			invoiceNumber: 'INV-99',
			totalMinor: 70_000,
			linesSumMinor: 71_000,
			invoiceTotalMismatch: true,
			lines: [
				{
					text: 'Chicken thighs 3 box @ 200',
					quantity: 3,
					unit: 'box',
					lineTotalMinor: 60_000,
					unitPriceMinor: 20_000,
					packSizeText: '10kg',
					packBaseQuantity: 10_000_000,
					itemId: 'i1',
					itemName: 'Chicken thighs',
					matchedSupplierProductId: 'sp1',
					warnings: ['price_change_gt_5pct' as const],
				},
				{
					text: 'Mint 1 bunch @ 10',
					quantity: 1,
					unit: 'piece',
					lineTotalMinor: 1_000,
					unitPriceMinor: 1_000,
					itemId: null,
					itemName: null,
					warnings: ['unmatched' as const],
				},
			],
		}
		const base = confirmLineDrafts(delivery())
		const matched = matchInvoiceReadToConfirm(read, base, 'SAR')
		expect(matched.lines[0]?.rawInvoiceText).toBe('Chicken thighs 3 box @ 200')
		expect(matched.lines[0]?.warnings).toEqual(['price_change_gt_5pct'])
		expect(matched.lines[0]?.quantityChanged).toBe(true)
		expect(matched.extraLines).toHaveLength(1)
		expect(matched.extraLines[0]?.createItemName).toBe('Mint 1 bunch @ 10')

		matched.lines[1]!.totalText = '400.00'
		const built = buildConfirmPrices(
			matched.lines,
			{ ...HEADER, invoiceNumber: 'INV-99' },
			{ expectedVersion: 4, currency: 'SAR' },
			matched.extraLines,
		)
		expect(built.ok).toBe(true)
		if (built.ok) {
			expect(built.payload.extraLines).toHaveLength(1)
			expect(built.payload.extraLines?.[0]).toMatchObject({
				createItem: { name: 'Mint 1 bunch @ 10', baseUnit: 'piece' },
				lineTotalMinor: 1000,
			})
		}
	})
})
