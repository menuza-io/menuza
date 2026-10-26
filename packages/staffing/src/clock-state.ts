/**
 * Clock state machine. State is derived from the staff member's open time
 * entry: none means `out`; an open entry with no open break means `in`; an open
 * break means `on_break`. The server is authoritative and rejects impossible
 * transitions, so a client can never produce a state this machine does not allow.
 */
export const CLOCK_STATES = ['out', 'in', 'on_break'] as const
export type ClockState = (typeof CLOCK_STATES)[number]

export const CLOCK_EVENTS = [
	'clock_in',
	'break_start',
	'break_end',
	'clock_out',
] as const
export type ClockEvent = (typeof CLOCK_EVENTS)[number]

const TRANSITIONS: Record<
	ClockState,
	Partial<Record<ClockEvent, ClockState>>
> = {
	out: { clock_in: 'in' },
	in: { break_start: 'on_break', clock_out: 'out' },
	// Ending the day from a break closes the break and the entry together.
	on_break: { break_end: 'in', clock_out: 'out' },
}

/** The next state, or `null` when the event is not allowed from this state. */
export function nextClockState(
	state: ClockState,
	event: ClockEvent,
): ClockState | null {
	return TRANSITIONS[state][event] ?? null
}

export function allowedClockEvents(state: ClockState): ClockEvent[] {
	return Object.keys(TRANSITIONS[state]) as ClockEvent[]
}

export function deriveClockState(
	openEntry: { clockOutAt: number | null; openBreak: boolean } | null,
): ClockState {
	if (!openEntry || openEntry.clockOutAt !== null) return 'out'
	return openEntry.openBreak ? 'on_break' : 'in'
}

export const PUNCH_SOURCES = [
	'kiosk',
	'web',
	'mobile',
	'manager',
	// A paired Station tablet's time clock.
	'pos',
] as const
export type PunchSource = (typeof PUNCH_SOURCES)[number]

export const PUNCH_OUTCOMES = [
	'accepted',
	'duplicate',
	'rejected_state',
	'rejected_policy',
	'rejected_auth',
] as const
export type PunchOutcome = (typeof PUNCH_OUTCOMES)[number]

/**
 * Bounds for punches queued offline on a kiosk or a till (a design choice).
 * A till shut overnight during an outage syncs the next morning: punches up
 * to 48 hours old are still recorded, and those over 12 hours old are flagged
 * `late_sync` so the card waits for a manager.
 */
export const OFFLINE_PUNCH_MAX_AGE_MS = 48 * 60 * 60 * 1000
export const OFFLINE_PUNCH_LATE_SYNC_MS = 12 * 60 * 60 * 1000
export const OFFLINE_PUNCH_FUTURE_TOLERANCE_MS = 60 * 1000
export const CLOCK_SKEW_FLAG_MS = 5 * 60 * 1000

export type OfflinePunchVerdict =
	| { ok: true; effectiveAtMs: number; flaggedSkew: boolean; lateSync: boolean }
	| { ok: false; reason: 'in_future' | 'too_old' }

/**
 * Validate the client-reported time of a queued punch against server time.
 * Accepted only if it is not in the future (a minute of drift is clamped to
 * server time) and no more than 48 hours old; over 12 hours old it is flagged
 * as a late sync. `deviceNowMs` is the device clock at the moment it synced;
 * when it differs from server time by more than 5 minutes the punch is
 * flagged for clock skew. Server time stays authoritative for every other
 * field.
 */
export function checkOfflinePunchTime(
	clientAtMs: number,
	serverAtMs: number,
	deviceNowMs?: number,
): OfflinePunchVerdict {
	if (!Number.isFinite(clientAtMs) || !Number.isFinite(serverAtMs)) {
		return { ok: false, reason: 'in_future' }
	}
	if (clientAtMs - serverAtMs > OFFLINE_PUNCH_FUTURE_TOLERANCE_MS) {
		return { ok: false, reason: 'in_future' }
	}
	if (serverAtMs - clientAtMs > OFFLINE_PUNCH_MAX_AGE_MS) {
		return { ok: false, reason: 'too_old' }
	}
	const flaggedSkew =
		deviceNowMs !== undefined &&
		Math.abs(deviceNowMs - serverAtMs) > CLOCK_SKEW_FLAG_MS
	return {
		ok: true,
		effectiveAtMs: Math.min(clientAtMs, serverAtMs),
		flaggedSkew,
		lateSync: serverAtMs - clientAtMs > OFFLINE_PUNCH_LATE_SYNC_MS,
	}
}
