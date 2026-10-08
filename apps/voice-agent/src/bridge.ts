import { MAX_BRIDGED_CALL_MINUTES } from './transfer.ts'

export type BridgeEndReason = 'party_left' | 'time_limit'

/**
 * Watches a warm-transferred call after the agent stopped talking: caller and
 * staff share the room until one of them hangs up, which ends the call for
 * the other, or until the hard time limit tears the room down. Returns a
 * function that stops watching without ending the call (for job shutdown).
 */
export function watchBridgedCall({
	parties,
	onPartyLeft,
	endCall,
	maxMs = MAX_BRIDGED_CALL_MINUTES * 60_000,
}: {
	/** How many phone participants (caller and staff) are still in the room. */
	parties: () => number
	/** Subscribes to participants leaving; returns the unsubscribe. */
	onPartyLeft: (listener: () => void) => () => void
	endCall: (reason: BridgeEndReason) => Promise<void>
	maxMs?: number
}) {
	let done = false
	const stop = () => {
		if (done) return false
		done = true
		clearTimeout(timer)
		unsubscribe()
		return true
	}
	const end = (reason: BridgeEndReason) => {
		if (!stop()) return
		void endCall(reason).catch((error: unknown) =>
			console.error('Failed to end the transferred call', error),
		)
	}
	const timer = setTimeout(() => {
		console.warn('Transferred call reached its time limit; ending it', {
			minutes: Math.round(maxMs / 60_000),
		})
		end('time_limit')
	}, maxMs)
	const unsubscribe = onPartyLeft(() => {
		if (parties() < 2) end('party_left')
	})
	// One side may have hung up while the other was being connected.
	if (parties() < 2) end('party_left')
	return () => {
		stop()
	}
}
