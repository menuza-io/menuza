import { describe, expect, it } from 'vitest'
import { biggestSeating, slotReason } from './slotReasons.ts'
import { DATE, day } from './testing.ts'

const feed = (extra: Record<string, unknown> = {}) =>
	day([], {
		tables: [
			{ id: 'a', areaId: 'a1', label: '1', minCovers: 1, maxCovers: 4 },
			{ id: 'b', areaId: 'a1', label: '2', minCovers: 1, maxCovers: 8 },
		],
		pacing: [
			{ localMin: 1140, bookedCovers: 8, maxCovers: 10 },
			{ localMin: 1155, bookedCovers: 4, maxCovers: 10 },
			{ localMin: 1170, bookedCovers: 30, maxCovers: null },
		],
		...extra,
	})

describe('why a time is not open', () => {
	it('knows the biggest party the floor can seat, with its combinations', () => {
		expect(biggestSeating(feed())).toBe(8)
		expect(
			biggestSeating(
				feed({
					combos: [{ id: 'c', maxCovers: 12, tableIds: ['a', 'b'] }],
				}),
			),
		).toBe(12)
		// An archived combination does not count.
		expect(
			biggestSeating(
				feed({
					combos: [
						{ id: 'c', maxCovers: 12, tableIds: ['a', 'b'], archivedAt: 1 },
					],
				}),
			),
		).toBe(8)
	})
	it('says a party too big for any table or combination needs a bigger table', () => {
		expect(
			slotReason({
				slot: { localStartMin: 1140 },
				partySize: 10,
				date: DATE,
				feed: feed(),
			}),
		).toBe('big')
		expect(
			slotReason({
				slot: { localStartMin: 1140 },
				partySize: 10,
				date: DATE,
				feed: feed({
					combos: [{ id: 'c', maxCovers: 12, tableIds: ['a', 'b'] }],
				}),
			}),
		).not.toBe('big')
	})
	it('says a slot whose covers are used up is full, for the day on screen', () => {
		expect(
			slotReason({
				slot: { localStartMin: 1140 },
				partySize: 4,
				date: DATE,
				feed: feed(),
			}),
		).toBe('full')
		// Room for two more, not four.
		expect(
			slotReason({
				slot: { localStartMin: 1140 },
				partySize: 2,
				date: DATE,
				feed: feed(),
			}),
		).toBe('closed')
		// No cap on the slot: nothing to be full against.
		expect(
			slotReason({
				slot: { localStartMin: 1170 },
				partySize: 4,
				date: DATE,
				feed: feed(),
			}),
		).toBe('closed')
		// Another day: the stand has not loaded that day's pacing, so it cannot say.
		expect(
			slotReason({
				slot: { localStartMin: 1140 },
				partySize: 4,
				date: '2026-04-01',
				feed: feed(),
			}),
		).toBe('closed')
	})
	it('is not full against the server’s default cap, only one someone configured', () => {
		const at = (row: Record<string, unknown>) =>
			slotReason({
				slot: { localStartMin: 1140 },
				partySize: 4,
				date: DATE,
				feed: feed({ pacing: [{ localMin: 1140, ...row }] }),
			})
		// Marked as the default: no rule, nothing to be full against.
		expect(
			at({ bookedCovers: 8, maxCovers: 10, maxCoversIsDefault: true }),
		).toBe('closed')
		// A cap of every seat on the floor or more is the default too (an older feed does not mark it).
		expect(at({ bookedCovers: 10, maxCovers: 12 })).toBe('closed')
		expect(
			at({ bookedCovers: 8, maxCovers: 10, maxCoversIsDefault: false }),
		).toBe('full')
	})
	it('reads two rows for one minute as one slot, not the first row alone', () => {
		const reason = slotReason({
			slot: { localStartMin: 1140 },
			partySize: 4,
			date: DATE,
			feed: feed({
				pacing: [
					// The first row (the service starting the slot) has the rule; the other counts the same bookings.
					{ localMin: 1140, bookedCovers: 2, maxCovers: 10, serviceId: 's1' },
					{ localMin: 1140, bookedCovers: 8, maxCovers: 10, serviceId: 's2' },
				],
			}),
		})
		expect(reason).toBe('full')
	})
	it('says a held slot is held', () => {
		expect(
			slotReason({
				slot: { localStartMin: 1155, held: true },
				partySize: 2,
				date: DATE,
				feed: feed(),
			}),
		).toBe('held')
	})
	it('is just "not open" when nothing says why, or the floor is not known', () => {
		expect(
			slotReason({
				slot: { localStartMin: 1155 },
				partySize: 2,
				date: DATE,
				feed: feed(),
			}),
		).toBe('closed')
		expect(
			slotReason({
				slot: { localStartMin: 1155 },
				partySize: 40,
				date: DATE,
				feed: null,
			}),
		).toBe('closed')
	})
})
