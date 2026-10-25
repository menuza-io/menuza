import { describe, expect, it } from 'vitest'
import { entry, MIN, at } from './testing.ts'
import {
	joinedOnline,
	minutesWaited,
	textability,
	textedState,
	URGENT_MS,
} from './waitlist.ts'

const now = at(13 * 60 + 52)
const told = (overrides: Parameters<typeof entry>[0] = {}) =>
	entry({
		status: 'notified',
		notifiedAt: now - 8 * MIN,
		responseDeadlineAt: now + 2 * MIN,
		...overrides,
	})

describe('a party told their table is ready', () => {
	it('counts down to the end of the hold', () => {
		expect(
			textedState(told({ responseDeadlineAt: now + 7 * MIN }), now),
		).toMatchObject({
			minutesLeft: 7,
			expired: false,
			urgent: false,
		})
		// Partial minutes round up: "1 min left" until it is really over.
		expect(
			textedState(told({ responseDeadlineAt: now + 30_000 }), now)?.minutesLeft,
		).toBe(1)
	})
	it('turns urgent in the last stretch, and expired at the deadline', () => {
		expect(
			textedState(told({ responseDeadlineAt: now + URGENT_MS }), now),
		).toMatchObject({ urgent: true, expired: false })
		expect(
			textedState(told({ responseDeadlineAt: now + URGENT_MS + 1 }), now)
				?.urgent,
		).toBe(false)
		expect(textedState(told({ responseDeadlineAt: now }), now)).toMatchObject({
			urgent: true,
			expired: true,
			minutesLeft: 0,
		})
		expect(
			textedState(told({ responseDeadlineAt: now - 5 * MIN }), now)?.expired,
		).toBe(true)
	})
	it('has no countdown when the server sent no deadline', () => {
		const state = textedState(told({ responseDeadlineAt: null }), now)
		expect(state).toMatchObject({
			deadlineAt: null,
			minutesLeft: null,
			expired: false,
			urgent: false,
		})
	})
	it('is nothing for a party not told, or told with no time recorded', () => {
		expect(textedState(entry({ status: 'waiting' }), now)).toBeNull()
		expect(textedState(told({ notifiedAt: null }), now)).toBeNull()
	})
})

describe('whether a party can be texted', () => {
	it('needs a number, and their consent', () => {
		expect(textability({ phone: '+14155550132', smsOptIn: true })).toBe('ok')
		expect(textability({ phone: '+14155550132', smsOptIn: false })).toBe(
			'no_consent',
		)
		expect(textability({ phone: null, smsOptIn: false })).toBe('no_phone')
		expect(textability({ phone: null, smsOptIn: true })).toBe('no_phone')
	})
})

describe('the waitlist row', () => {
	it('knows a party that joined online, and how long they have waited', () => {
		expect(joinedOnline({ channel: 'remote' })).toBe(true)
		expect(joinedOnline({ channel: 'walk_in' })).toBe(false)
		expect(minutesWaited({ joinedAt: now - 14 * MIN - 5000 }, now)).toBe(14)
		expect(minutesWaited({ joinedAt: now + MIN }, now)).toBe(0)
	})
})
