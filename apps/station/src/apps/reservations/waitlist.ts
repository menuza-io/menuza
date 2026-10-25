import { type WaitlistEntry } from '@repo/reservations'

/**
 * The waitlist's texting: a party told their table is ready holds it until a
 * deadline; the stand counts down to it and, when it passes with no answer,
 * offers to take them off. Pure, so it is tested apart from the sheet.
 */

/** The last stretch of the hold: the countdown turns to a warning. */
export const URGENT_MS = 2 * 60_000

export type Texted = {
	notifiedAt: number
	/** When the hold ends (null when the server did not say). */
	deadlineAt: number | null
	/** Whole minutes left, rounded up (0 once it has passed or is a minute from it). */
	minutesLeft: number | null
	/** The hold has ended with no answer. */
	expired: boolean
	/** Inside the last stretch (or past it). */
	urgent: boolean
}

/** Where a party told their table is ready stands: null for one not told. */
export function textedState(
	entry: Pick<WaitlistEntry, 'status' | 'notifiedAt' | 'responseDeadlineAt'>,
	now: number,
): Texted | null {
	if (entry.status !== 'notified' || typeof entry.notifiedAt !== 'number')
		return null
	const deadline =
		typeof entry.responseDeadlineAt === 'number'
			? entry.responseDeadlineAt
			: null
	const left = deadline === null ? null : deadline - now
	return {
		notifiedAt: entry.notifiedAt,
		deadlineAt: deadline,
		minutesLeft: left === null ? null : Math.max(0, Math.ceil(left / 60_000)),
		expired: left !== null && left <= 0,
		urgent: left !== null && left <= URGENT_MS,
	}
}

/** Whether the stand can text this party, and why not: no number, or no consent to be texted. */
export function textability(
	entry: Pick<WaitlistEntry, 'phone' | 'smsOptIn'>,
): 'ok' | 'no_phone' | 'no_consent' {
	if (!entry.phone) return 'no_phone'
	return entry.smsOptIn ? 'ok' : 'no_consent'
}

/** A party that came to the waitlist through the restaurant's own page or app, not at the stand. */
export const joinedOnline = (entry: Pick<WaitlistEntry, 'channel'>) =>
	entry.channel === 'remote'

/** Minutes a party has waited, never negative. */
export const minutesWaited = (
	entry: Pick<WaitlistEntry, 'joinedAt'>,
	now: number,
) => Math.max(0, Math.floor((now - entry.joinedAt) / 60_000))
