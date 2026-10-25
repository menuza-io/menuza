import { describe, expect, it } from 'vitest'
import { fitRoom, MIN_TABLE_PX } from './floorfit.ts'

/** The demo room: tables 80 to 110 wide on a 1200 by 800 canvas, with a bar down the side. */
const tables = [
	{ id: 'a', x: 110, y: 110, w: 80, h: 80 },
	{ id: 'b', x: 240, y: 110, w: 80, h: 80 },
	{ id: 'c', x: 590, y: 310, w: 270, h: 110 },
	{ id: 'd', x: 150, y: 530, w: 110, h: 110 },
]
const extras = [{ x: 920, y: 90, w: 190, h: 560 }]

describe('fitting a room to its pane', () => {
	it('scales the content up to fill the pane, not the canvas around it', () => {
		const fit = fitRoom({ tables, extras, frame: { w: 960, h: 640 } })
		expect(fit.scrolls).toBe(false)
		// The plan fills one dimension of the pane (the other is within it).
		expect(
			Math.abs(fit.width - 960) < 2 || Math.abs(fit.height - 640) < 2,
		).toBe(true)
		expect(fit.width).toBeLessThanOrEqual(962)
		expect(fit.height).toBeLessThanOrEqual(642)
	})
	it('never draws a table under the minimum, growing it around its centre', () => {
		const fit = fitRoom({ tables, extras, frame: { w: 720, h: 600 } })
		expect(fit.scrolls).toBe(false)
		for (const placed of fit.tables.values()) {
			expect(placed.width).toBeGreaterThanOrEqual(MIN_TABLE_PX - 0.001)
			expect(placed.height).toBeGreaterThanOrEqual(MIN_TABLE_PX - 0.001)
		}
		// Everything stays inside the plan.
		for (const placed of fit.tables.values()) {
			expect(placed.left).toBeGreaterThanOrEqual(-0.001)
			expect(placed.left + placed.width).toBeLessThanOrEqual(fit.width + 0.001)
		}
	})
	it('fits a phone by the tables alone when the fixtures would make it pan', () => {
		const phone = fitRoom({ tables, extras, frame: { w: 358, h: 560 } })
		expect(phone.scrolls).toBe(false)
		expect(phone.width).toBeLessThanOrEqual(358.5)
		// A phone's tables are still a fingertip wide (56), and clear of one another.
		const boxes = [...phone.tables.values()]
		for (const placed of boxes)
			expect(placed.width).toBeGreaterThanOrEqual(55.99)
		const a = phone.tables.get('a')!
		const b = phone.tables.get('b')!
		expect(b.left - (a.left + a.width)).toBeGreaterThanOrEqual(0)
		const tablet = fitRoom({ tables, extras, frame: { w: 700, h: 560 } })
		expect(tablet.scrolls).toBe(false)
		// The tablet keeps the bar in the picture.
		expect(
			tablet.extras[0]!.left + tablet.extras[0]!.width,
		).toBeLessThanOrEqual(tablet.width + 0.5)
	})
	it('pans only when even the tables cannot fit at a size a finger can hit', () => {
		const cramped = fitRoom({ tables, extras, frame: { w: 240, h: 320 } })
		expect(cramped.scrolls).toBe(true)
		expect(cramped.width).toBeGreaterThan(240)
	})
	it('does not blow a tiny room up past a sensible table size', () => {
		const fit = fitRoom({
			tables: [{ id: 'a', x: 0, y: 0, w: 60, h: 60 }],
			extras: [],
			frame: { w: 1200, h: 800 },
		})
		expect(fit.tables.get('a')!.width).toBeLessThanOrEqual(120.001)
	})
	it('has nothing to fit before the pane is measured', () => {
		const fit = fitRoom({ tables, extras, frame: { w: 0, h: 0 } })
		expect(fit.tables.size).toBe(0)
	})
})
