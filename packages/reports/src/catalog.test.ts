import { describe, expect, it } from 'vitest'
import {
	type ReportField,
	getField,
	getSubject,
	organizationCatalog,
	platformCatalog,
	valueFields,
	valueMeasureLabel,
} from './catalog.ts'

const shopOrders = getSubject(organizationCatalog, 'shop_orders')!

/** A star rating: its average means something, its sum doesn't. */
const stars: ReportField = {
	id: 'stars',
	label: 'Stars',
	type: 'number',
	sumLabel: false,
}

describe('valueMeasureLabel', () => {
	it('names sums and averages after the field', () => {
		const amount = getField(shopOrders, 'amount')!
		const payout = getField(shopOrders, 'orgPayout')!
		expect(valueMeasureLabel('sum', amount)).toBe('Shop sales')
		expect(valueMeasureLabel('average', amount)).toBe('Average shop order')
		expect(valueMeasureLabel('sum', payout)).toBe('Org payout')
		expect(valueMeasureLabel('average', stars)).toBe('Average stars')
	})

	it('has no label where the measure means nothing', () => {
		expect(valueMeasureLabel('sum', stars)).toBeNull()
		expect(valueMeasureLabel('sum', getField(shopOrders, 'status')!)).toBeNull()
		expect(
			valueMeasureLabel('average', getField(shopOrders, 'productName')!),
		).toBeNull()
	})
})

describe('valueFields', () => {
	it('offers only the numbers a measure can read', () => {
		const rated = { ...shopOrders, fields: [...shopOrders.fields, stars] }
		const ids = (fields: ReportField[]) => fields.map((field) => field.id)
		expect(ids(valueFields(rated, 'sum'))).toEqual(['amount', 'orgPayout'])
		expect(ids(valueFields(rated, 'average'))).toEqual([
			'amount',
			'orgPayout',
			'stars',
		])
		expect(ids(valueFields(rated))).toEqual(['amount', 'orgPayout', 'stars'])
		expect(valueFields(getSubject(organizationCatalog, 'notes')!)).toEqual([])
	})
})

describe('catalog', () => {
	const subjects = [
		...organizationCatalog.subjects,
		...platformCatalog.subjects,
	]

	it('names a currency field wherever there is money', () => {
		for (const subject of subjects) {
			const hasMoney = subject.fields.some((field) => field.type === 'currency')
			if (!hasMoney) continue
			expect(subject.currencyField, subject.id).toBeTruthy()
			expect(getField(subject, subject.currencyField!), subject.id).not.toBe(
				null,
			)
		}
	})
})
