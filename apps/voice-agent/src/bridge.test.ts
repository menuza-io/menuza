import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchBridgedCall } from './bridge.ts'
import { MAX_BRIDGED_CALL_MINUTES } from './transfer.ts'

function setup(parties = 2) {
	const room = { parties, listeners: new Set<() => void>() }
	const endCall = vi.fn(async () => undefined)
	const stop = watchBridgedCall({
		parties: () => room.parties,
		onPartyLeft: (listener) => {
			room.listeners.add(listener)
			return () => room.listeners.delete(listener)
		},
		endCall,
	})
	const leave = () => {
		room.parties--
		for (const listener of room.listeners) listener()
	}
	return { room, endCall, stop, leave }
}

describe('watchBridgedCall', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('tears the call down at the hard time limit', async () => {
		const { endCall } = setup()
		await vi.advanceTimersByTimeAsync(MAX_BRIDGED_CALL_MINUTES * 60_000 - 1)
		expect(endCall).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(endCall).toHaveBeenCalledWith('time_limit')
	})

	it('ends the call for both sides when one hangs up, and clears the timer', async () => {
		const { endCall, leave, room } = setup()
		leave()
		expect(endCall).toHaveBeenCalledExactlyOnceWith('party_left')
		expect(vi.getTimerCount()).toBe(0)
		expect(room.listeners.size).toBe(0)
		await vi.advanceTimersByTimeAsync(MAX_BRIDGED_CALL_MINUTES * 60_000)
		expect(endCall).toHaveBeenCalledTimes(1)
	})

	it('ends at once when a side left while staff was being connected', () => {
		const { endCall } = setup(1)
		expect(endCall).toHaveBeenCalledWith('party_left')
		expect(vi.getTimerCount()).toBe(0)
	})

	it('stops watching on shutdown without ending the call', async () => {
		const { endCall, stop, room } = setup()
		stop()
		expect(vi.getTimerCount()).toBe(0)
		expect(room.listeners.size).toBe(0)
		await vi.advanceTimersByTimeAsync(MAX_BRIDGED_CALL_MINUTES * 60_000)
		expect(endCall).not.toHaveBeenCalled()
	})
})
