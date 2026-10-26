import { describe, expect, it } from 'vitest'
import {
	fitRoom,
	MIN_TABLE_PX,
	turnedExtent,
	typicalTableSize,
} from './floorfit.ts'

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

	it('is not forced to pan by one tiny table among normal ones', () => {
		const row = Array.from({ length: 12 }, (_, i) => ({
			id: `t${i}`,
			x: (i % 4) * 140,
			y: Math.floor(i / 4) * 140,
			w: 100,
			h: 100,
		}))
		const frame = { w: 560, h: 420 }
		const before = fitRoom({ tables: row, extras: [], frame })
		expect(before.scrolls).toBe(false)
		const withTiny = fitRoom({
			tables: [...row, { id: 'tiny', x: 600, y: 420, w: 24, h: 24 }],
			extras: [],
			frame: { w: 760, h: 520 },
		})
		expect(withTiny.scrolls).toBe(false)
		const withZero = fitRoom({
			tables: [...row, { id: 'zero', x: 300, y: 300, w: 0, h: 0 }],
			extras: [],
			frame: { w: 760, h: 520 },
		})
		expect(withZero.scrolls).toBe(false)
		expect(
			typicalTableSize([...row, { id: 'z', x: 0, y: 0, w: 24, h: 24 }]),
		).toBe(100)
	})
	it('sizes a room of mixed tables by its smaller ordinary tables', () => {
		const sizes = [60, 80, 80, 100, 120, 20].map((side, i) => ({
			id: `m${i}`,
			x: 0,
			y: 0,
			w: side,
			h: side,
		}))
		expect(typicalTableSize(sizes)).toBe(60)
	})
	describe('turned items', () => {
		it('measures a turned box by its bounding box about the same centre', () => {
			const box = turnedExtent({ left: 0, top: 0, width: 900, height: 12 }, 90)
			expect(box.x1 - box.x0).toBeCloseTo(12, 5)
			expect(box.y1 - box.y0).toBeCloseTo(900, 5)
			expect((box.x0 + box.x1) / 2).toBeCloseTo(450, 5)
			expect((box.y0 + box.y1) / 2).toBeCloseTo(6, 5)
		})
		it('fits a 900 by 12 wall turned 90 degrees by its height, not its width', () => {
			const tablesOnly = [{ id: 'a', x: 0, y: 0, w: 100, h: 100 }]
			const fit = fitRoom({
				tables: tablesOnly,
				extras: [{ x: 100, y: -400, w: 900, h: 12, rotation: 90 }],
				frame: { w: 600, h: 600 },
			})
			// Turned, the wall is a tall thin one: the plan is not 900 wide.
			expect(fit.width).toBeLessThan(fit.height)
			expect(fit.scrolls).toBe(false)
			expect(fit.height).toBeLessThanOrEqual(600.5)
			// It is still drawn at its own width and height (CSS does the turning).
			const wall = fit.extras[0]!
			expect(wall.width).toBeCloseTo(fit.scale * 900, 3)
			expect(wall.height).toBeCloseTo(fit.scale * 12, 3)
		})
		it('keeps a 270 by 110 table turned near an edge inside the plan', () => {
			const fit = fitRoom({
				tables: [
					{ id: 'a', x: 0, y: 0, w: 100, h: 100 },
					{ id: 'edge', x: 300, y: 0, w: 270, h: 110, rotation: 80 },
				],
				extras: [],
				frame: { w: 700, h: 500 },
			})
			const placed = fit.tables.get('edge')!
			const turned = turnedExtent(placed, 80)
			expect(turned.x0).toBeGreaterThanOrEqual(-0.5)
			expect(turned.y0).toBeGreaterThanOrEqual(-0.5)
			expect(turned.x1).toBeLessThanOrEqual(fit.width + 0.5)
			expect(turned.y1).toBeLessThanOrEqual(fit.height + 0.5)
			expect(fit.width).toBeLessThanOrEqual(700.5)
			expect(fit.height).toBeLessThanOrEqual(500.5)
		})
	})
})
