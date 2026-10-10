import { describe, expect, it } from 'vitest'
import {
	defaultListColumns,
	getField,
	getSubject,
	organizationCatalog,
	platformCatalog,
	valueFields,
	valueMeasureLabel,
} from './catalog.ts'
import { RESTRICTED_REPORT_SUBJECTS } from './operator-token.ts'

const orders = getSubject(organizationCatalog, 'orders')!

describe('valueMeasureLabel', () => {
	it('names sums and averages after the field', () => {
		const total = getField(orders, 'total')!
		const subtotal = getField(orders, 'subtotal')!
		const tax = getField(orders, 'tax')!
		expect(valueMeasureLabel('sum', total)).toBe('Sales')
		expect(valueMeasureLabel('average', total)).toBe('Average order value')
		expect(valueMeasureLabel('sum', subtotal)).toBe('Subtotal')
		expect(valueMeasureLabel('average', tax)).toBe('Average tax')
	})

	it('has no label where the measure means nothing', () => {
		expect(valueMeasureLabel('sum', getField(orders, 'tipPercent')!)).toBeNull()
		expect(valueMeasureLabel('sum', getField(orders, 'status')!)).toBeNull()
		expect(
			valueMeasureLabel('average', getField(orders, 'location')!),
		).toBeNull()
	})
})

describe('valueFields', () => {
	it('offers only the numbers a measure can read', () => {
		const sums = valueFields(orders, 'sum').map((field) => field.id)
		const averages = valueFields(orders, 'average').map((field) => field.id)
		expect(sums).toContain('total')
		expect(sums).not.toContain('tipPercent')
		expect(averages).toContain('tipPercent')
		expect(valueFields(getSubject(organizationCatalog, 'notes')!)).toEqual([])
	})
})

describe('defaultListColumns', () => {
	it('uses the subject’s chosen columns', () => {
		expect(defaultListColumns(orders)).toEqual(orders.defaultColumns)
	})

	it('puts identifying fields before dates and flags', () => {
		expect(
			defaultListColumns(getSubject(organizationCatalog, 'notes')!),
		).toEqual(['title', 'status', 'priority', 'createdAt'])
	})
})

describe('catalog', () => {
	const subjects = [
		...organizationCatalog.subjects,
		...platformCatalog.subjects,
	]

	it('only derives fields from restricted subjects', () => {
		for (const subject of subjects) {
			for (const field of subject.fields) {
				if (!field.requiresSubject) continue
				expect(RESTRICTED_REPORT_SUBJECTS).toContain(field.requiresSubject)
			}
		}
	})

	it('names a currency field wherever there is money', () => {
		for (const subject of subjects) {
			const hasMoney = subject.fields.some((field) => field.type === 'currency')
			if (hasMoney) expect(subject.currencyField, subject.id).toBeTruthy()
		}
	})

	it('only lists default columns the subject has', () => {
		for (const subject of subjects) {
			for (const id of subject.defaultColumns ?? []) {
				expect(getField(subject, id), `${subject.id}.${id}`).not.toBeNull()
			}
		}
	})
})
