import { describe, expect, it } from 'vitest'
import {
	pickTimelineFocusMin,
	pickTimelineScrollLeft,
} from './timeline-scroll.ts'

const grid = {
	gridStartMin: 600,
	gridEndMin: 1380,
	stepMin: 15,
	slotWidthPx: 52,
	labelWidthPx: 192,
}

describe('pickTimelineFocusMin', () => {
	it('uses now today and the earliest booking otherwise', () => {
		expect(
			pickTimelineFocusMin({
				isToday: true,
				nowLocalMin: 1110,
				bookingStartMins: [1200],
			}),
		).toBe(1110)
		expect(
			pickTimelineFocusMin({
				isToday: false,
				nowLocalMin: 1110,
				bookingStartMins: [1230, 1140],
			}),
		).toBe(1140)
		expect(
			pickTimelineFocusMin({
				isToday: false,
				nowLocalMin: 0,
				bookingStartMins: [],
			}),
		).toBeNull()
	})
})

describe('pickTimelineScrollLeft', () => {
	it('stays at the start with no focus or when focus is already visible', () => {
		expect(
			pickTimelineScrollLeft({
				...grid,
				focusMin: null,
				viewportWidthPx: 1200,
			}),
		).toBe(0)
		expect(
			pickTimelineScrollLeft({
				...grid,
				focusMin: 615,
				viewportWidthPx: 1200,
			}),
		).toBe(0)
	})

	it('scrolls an evening focus into view, a quarter in from the left', () => {
		// 19:00 = 1140 -> 36 slots * 52 = 1872; visible 1008; lead 252
		expect(
			pickTimelineScrollLeft({
				...grid,
				focusMin: 1140,
				viewportWidthPx: 1200,
			}),
		).toBe(1620)
	})

	it('clamps to the end of the grid', () => {
		const max = 192 + (780 / 15) * 52 - 1200
		expect(
			pickTimelineScrollLeft({
				...grid,
				focusMin: 1380,
				viewportWidthPx: 1200,
			}),
		).toBe(max)
	})
})
