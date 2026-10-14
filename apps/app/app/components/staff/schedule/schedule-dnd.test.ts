import { describe, expect, it } from 'vitest'
import { makeCoordinateGetter } from './schedule-dnd.tsx'

type Rect = {
	top: number
	left: number
	right: number
	bottom: number
	width: number
	height: number
}

function rect(left: number, top: number, width: number, height: number): Rect {
	return {
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
	}
}

/** A grid of cells: rows are 80px tall, columns 120px wide, from (100, 100). */
function grid(rows: number, columns: number) {
	const rects = new Map<string, Rect>()
	for (let r = 0; r < rows; r += 1) {
		for (let c = 0; c < columns; c += 1) {
			rects.set(`cell:${r}:${c}`, rect(100 + c * 120, 100 + r * 80, 120, 80))
		}
	}
	return rects
}

function press(
	code: string,
	collisionRect: Rect,
	rects: Map<string, Rect>,
	pxPerMinute?: number,
) {
	const getter = makeCoordinateGetter(pxPerMinute)
	let prevented = false
	const result = getter(
		{
			code,
			preventDefault: () => (prevented = true),
		} as unknown as KeyboardEvent,
		{
			context: {
				collisionRect,
				droppableRects: rects,
				droppableContainers: {
					getEnabled: () => [...rects.keys()].map((id) => ({ id })),
				},
			},
			currentCoordinates: { x: collisionRect.left, y: collisionRect.top },
		} as never,
	)
	return { result, prevented }
}

describe('keyboard coordinates for a lifted shift', () => {
	it('ignores keys that are not arrows and does not swallow them', () => {
		const rects = grid(3, 3)
		const out = press('KeyA', rect(110, 110, 100, 40), rects)
		expect(out.result).toBeUndefined()
		expect(out.prevented).toBe(false)
	})

	it('moves down to the cell below, not to the cell it is already in', () => {
		const rects = grid(3, 3)
		// A 40px block near the top of a 80px cell: the cell it sits in has its
		// centre below the block's centre, but it must not be chosen.
		const block = rect(110, 104, 100, 40)
		const down = press('ArrowDown', block, rects)
		expect(down.prevented).toBe(true)
		expect(down.result).toEqual({ x: 100, y: 180 })
	})

	it('moves up, left and right to the neighbouring cell', () => {
		const rects = grid(3, 3)
		const block = rect(230, 190, 100, 40)
		expect(press('ArrowUp', block, rects).result).toEqual({ x: 220, y: 100 })
		expect(press('ArrowLeft', block, rects).result).toEqual({ x: 100, y: 180 })
		expect(press('ArrowRight', block, rects).result).toEqual({ x: 340, y: 180 })
	})

	it('stays put at the edge of the grid', () => {
		const rects = grid(2, 2)
		const block = rect(110, 184, 100, 40)
		expect(press('ArrowDown', block, rects).result).toBeUndefined()
	})

	it('slides by one time step on the day timeline instead of changing cell', () => {
		const rects = grid(2, 1)
		const block = rect(110, 104, 100, 40)
		const right = press('ArrowRight', block, rects, 2)
		expect(right.result?.y).toBe(104)
		expect(right.result?.x).toBeGreaterThan(110)
		const left = press('ArrowLeft', block, rects, 2)
		expect(left.result?.x).toBeLessThan(110)
	})
})
