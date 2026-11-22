import { describe, expect, it } from 'vitest'
import { terminalStatus } from './terminal-status.ts'

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)
const MIN = 60_000

describe('terminalStatus', () => {
	it('is Never connected for a tablet that has not checked in', () => {
		expect(terminalStatus(null, NOW)).toEqual({ state: 'never' })
	})

	it('is Online within five minutes of a check-in', () => {
		expect(terminalStatus(NOW - MIN, NOW)).toEqual({
			state: 'online',
			lastSeenAt: NOW - MIN,
		})
		expect(terminalStatus(NOW - 4 * MIN - 59_000, NOW).state).toBe('online')
	})

	it('is Offline since the last check-in after five minutes', () => {
		expect(terminalStatus(NOW - 5 * MIN, NOW)).toEqual({
			state: 'offline',
			since: NOW - 5 * MIN,
		})
		expect(terminalStatus(NOW - 3 * 60 * MIN, NOW)).toEqual({
			state: 'offline',
			since: NOW - 3 * 60 * MIN,
		})
	})
})
