import { type HostStandState } from './useHostStand.ts'

/**
 * Whether the book on screen can be trusted, and what that means for the
 * host's taps. Offline (the tablet says so) or after a failed look (the
 * server could not be reached), what is drawn is the book as of the last good
 * read, and seating, booking and texts wait for the connection: the stand
 * says so for them, instead of letting each fail after a tap. A waitlist that
 * alone failed to load is "not up to date", but the day loaded, so writes still go.
 */
export type Connection =
	| { kind: 'ok' }
	| {
			kind: 'offline' | 'stale'
			/** When the book was last read well (epoch ms; null when it never was). */
			readAt: number | null
			/** Changes cannot be sent: they wait for the connection. */
			blocksWrites: boolean
	  }

export function connectionOf(
	online: boolean,
	state: HostStandState,
	/** The day on screen was asked for and its look failed (null: today). */
	date: string | null = null,
): Connection {
	const readAt = state.status === 'ready' ? state.readAt : null
	if (!online) return { kind: 'offline', readAt, blocksWrites: true }
	if (state.status === 'ready' && state.stale)
		return {
			kind: 'stale',
			readAt,
			blocksWrites: state.dayFailed !== null && state.dayFailed.date === date,
		}
	return { kind: 'ok' }
}
