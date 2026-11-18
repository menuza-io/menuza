import { describe, expect, it } from 'vitest'
import {
	buildMenuSpreadsheet,
	planMenuSpreadsheet,
	type SpreadsheetDish,
} from './menu-spreadsheet.ts'

const dishes: SpreadsheetDish[] = [
	{
		id: 'd1',
		name: 'Shawarma',
		category: 'Mains',
		price: 10,
		orderTypePrices: '{"delivery":12}',
		availabilityStatus: 'available',
		hasVariations: false,
	},
	{
		id: 'd2',
		name: '=HYPERLINK("x")',
		category: 'Mains',
		price: 7.5,
		orderTypePrices: null,
		availabilityStatus: 'unavailable',
		hasVariations: false,
	},
	{
		id: 'd3',
		name: 'Pizza',
		category: 'Pizza',
		price: 14,
		orderTypePrices: null,
		availabilityStatus: 'available',
		hasVariations: true,
	},
]
const byId = new Map(dishes.map((dish) => [dish.id, dish]))
const template = buildMenuSpreadsheet(dishes)

function edit(change: (rows: string[][]) => void): string {
	const rows = template
		.replace(/^﻿/, '')
		.trim()
		.split('\r\n')
		.map((line) => line.split(','))
	change(rows)
	return rows.map((row) => row.join(',')).join('\n')
}

describe('menu spreadsheet (#411)', () => {
	it('writes a template Excel opens, with formulas neutralized', () => {
		expect(
			template.startsWith(
				'﻿id,dish,category,price,dine_in_price,pickup_price,delivery_price,availability\r\n',
			),
		).toBe(true)
		expect(template).toContain('d1,Shawarma,Mains,10.00,,,12.00,available')
		expect(template).toContain(`d2,"'=HYPERLINK(""x"")",Mains,7.50,,,,sold_out`)
		// Reading the untouched template back changes nothing.
		const plan = planMenuSpreadsheet(template, byId)
		expect(plan).toEqual({ ok: true, changes: [], problems: [], rows: 3 })
	})

	it('shows one change when one price changes', () => {
		const plan = planMenuSpreadsheet(
			edit((rows) => {
				rows[1]![3] = '11.50'
			}),
			byId,
		)
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.problems).toEqual([])
		expect(plan.changes).toHaveLength(1)
		expect(plan.changes[0]).toMatchObject({
			itemId: 'd1',
			fields: ['price'],
			write: { price: 11.5 },
		})
	})

	it('leaves values untouched for blank cells', () => {
		const plan = planMenuSpreadsheet(
			'id,price,delivery_price,availability\nd1,,,\nd2,,,available',
			byId,
		)
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.changes).toEqual([
			expect.objectContaining({
				itemId: 'd2',
				fields: ['availability'],
				write: { availabilityStatus: 'available' },
			}),
		])
	})

	it('lists bad rows with the reason', () => {
		const plan = planMenuSpreadsheet(
			[
				'id,price,dine_in_price,availability',
				'd1,abc,,',
				'nope,5,,',
				'd2,,,maybe',
				'd3,15,,',
				'd1,9,,',
			].join('\n'),
			byId,
		)
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.problems).toEqual([
			{ row: 2, id: 'd1', problem: 'bad_price', column: 'price' },
			{ row: 3, id: 'nope', problem: 'unknown_dish', column: 'id' },
			{ row: 4, id: 'd2', problem: 'bad_availability', column: 'availability' },
			{ row: 5, id: 'd3', problem: 'variation_price', column: 'price' },
			{ row: 6, id: 'd1', problem: 'duplicate_row', column: 'id' },
		])
	})

	it('reads prices typed in Arabic digits and clears an order-type price with a dash', () => {
		const plan = planMenuSpreadsheet(
			'id,price,delivery_price,pickup_price\nd1,١٢٫٥٠,-,9',
			byId,
		)
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.changes[0]).toMatchObject({
			fields: ['price', 'pickup_price', 'delivery_price'],
			after: { price: 12.5, orderTypePrices: { pickup: 9 } },
			write: { price: 12.5, orderTypePrices: '{"pickup":9}' },
		})
	})

	it('refuses a file that is not the template', () => {
		expect(planMenuSpreadsheet('name,cost\nShawarma,10', byId)).toEqual({
			ok: false,
			error: 'not_template',
		})
		expect(planMenuSpreadsheet('id,price,colour\nd1,10,red', byId)).toEqual({
			ok: false,
			error: 'not_template',
		})
		expect(planMenuSpreadsheet('', byId)).toEqual({ ok: false, error: 'empty' })
	})

	it('reads semicolon files and translated availability words', () => {
		const plan = planMenuSpreadsheet('id;availability\nd1;مخفي', byId)
		if (!plan.ok) throw new Error(plan.error)
		expect(plan.changes[0]).toMatchObject({
			write: { availabilityStatus: 'hidden' },
		})
	})
})
