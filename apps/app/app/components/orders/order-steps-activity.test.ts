import { describe, expect, it } from 'vitest'
import { stepActivityEvents } from './order-steps-activity.ts'
import { type OrderTimelineEntry } from '#app/utils/orders/order-model.ts'

// A translator that returns the message text with its values filled in, as the
// `msg` macro describes them.
const translate = (message: {
	message?: string
	id?: string
	values?: Record<string, unknown>
}) => {
	const raw = message.message ?? message.id ?? ''
	return Object.entries(message.values ?? {}).reduce(
		(text, [key, value]) => text.replace(`{${key}}`, String(value)),
		raw,
	)
}

function entry(over: Partial<OrderTimelineEntry>): OrderTimelineEntry {
	return {
		step: 'ready',
		at: Date.UTC(2026, 10, 25, 12, 0, 0),
		actorKind: 'operator',
		actorId: 'usr_1',
		source: 'app',
		offline: false,
		minutesSincePlaced: 20,
		...over,
	}
}

describe('order steps in the Activity list (#243)', () => {
	it('shows when each step happened and who or which screen did it', () => {
		const events = stepActivityEvents(
			[
				entry({ step: 'placed', source: 'guest', actorKind: 'guest', actorId: null }),
				entry({ step: 'accepted' }),
				entry({ step: 'started', source: 'station_kitchen', actorKind: 'station', actorId: 'staff:s1' }),
				entry({ step: 'ready', source: 'system', actorKind: 'system', actorId: null }),
			],
			{ usr_1: 'Rana K.' },
			translate as never,
		)
		expect(events.map((e) => [e.key, e.label, e.at])).toEqual([
			['step:placed', 'Placed', '2026-11-25T12:00:00.000Z'],
			['step:accepted', 'Accepted', '2026-11-25T12:00:00.000Z'],
			['step:started', 'Started', '2026-11-25T12:00:00.000Z'],
			['step:ready', 'Ready', '2026-11-25T12:00:00.000Z'],
		])
		expect(events[0]!.detail).toBe('By the guest')
		// A member is named from the page's own list, never from the region.
		expect(events[1]!.detail).toBe('By Rana K. on the Orders page')
		expect(events[2]!.detail).toBe('On the Station kitchen screen')
		expect(events[3]!.detail).toBe('By Menuza, automatically')
	})

	it('names an unknown member by the screen only and marks a step taken offline', () => {
		const [unknown, offline] = stepActivityEvents(
			[
				entry({ actorId: 'usr_gone' }),
				entry({
					step: 'handed_over',
					source: 'station_orders',
					actorKind: 'station',
					actorId: 'staff:s2',
					offline: true,
				}),
			],
			{},
			translate as never,
		)
		expect(unknown!.detail).toBe('On the Orders page')
		expect(offline!.detail).toContain('On Station online orders')
		expect(offline!.detail).toContain("taken offline, at the till's time")
		expect(offline!.label).toBe('Handed over')
	})
})
