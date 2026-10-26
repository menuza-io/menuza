import { msg } from '@lingui/macro'
import { type useLingui } from '@lingui/react'
import { type WaitlistEntry } from '@repo/reservations'

type Translate = ReturnType<typeof useLingui>['_']

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

/**
 * Whether the stand can text this party, and why not: no number, no consent
 * to be texted, or (when it is known) a node or location that sends no texts.
 * `smsAvailable` is false only when something says so; unknown counts as on.
 */
export function textability(
	entry: Pick<WaitlistEntry, 'phone' | 'smsOptIn'>,
	options: { smsAvailable?: boolean } = {},
): 'ok' | 'no_phone' | 'no_consent' | 'no_sms' {
	if (!entry.phone) return 'no_phone'
	if (!entry.smsOptIn) return 'no_consent'
	return options.smsAvailable === false ? 'no_sms' : 'ok'
}

/**
 * What the server's answer to "tell them it's ready" says about a text:
 * `textQueued` is true only when a text message was actually queued. It is
 * missing from an older server, and from a repeat tap that queued nothing.
 */
export function textQueuedOf(result: unknown): boolean | undefined {
	const queued = (result as { textQueued?: unknown } | null)?.textQueued
	return typeof queued === 'boolean' ? queued : undefined
}

/**
 * How a party that was told their table is ready was told: a text is on its
 * way (queued: the delivery step can still suppress or fail it, so the stand
 * never says "sent"), none was queued (call them), or it is not known (an
 * older server did not say).
 * What the notify answer said is the truth; with no answer to go on (the
 * party was told on another tablet, or before this one opened), a party that
 * cannot be texted was certainly not texted, and any other is only "told".
 */
export type ToldHow = 'text_queued' | 'no_text' | 'told'

export function toldHow(
	entry: Pick<WaitlistEntry, 'phone' | 'smsOptIn'>,
	textQueued: boolean | undefined,
): ToldHow {
	if (textQueued === true) return 'text_queued'
	if (textQueued === false) return 'no_text'
	return textability(entry) === 'ok' ? 'told' : 'no_text'
}

/** A party that came to the waitlist through the restaurant's own page or app, not at the stand. */
export const joinedOnline = (entry: Pick<WaitlistEntry, 'channel'>) =>
	entry.channel === 'remote'

/** Minutes a party has waited, never negative. */
export const minutesWaited = (
	entry: Pick<WaitlistEntry, 'joinedAt'>,
	now: number,
) => Math.max(0, Math.floor((now - entry.joinedAt) / 60_000))

/**
 * What the stand says after "tell them it's ready", from what the server did:
 * a text is claimed only as on its way (the server queued it; the delivery
 * step may still fail), and never when none was queued. `holdsUntil` is the
 * hold's end as a time ("1:36 PM"), when the server's answer said.
 */
export function notifiedToast(
	_: Translate,
	who: string,
	textQueued: boolean | undefined,
	holdsUntil: string | null = null,
): string {
	if (textQueued === true)
		return holdsUntil
			? _(
					msg`Text on its way to ${who}: your table is ready. Holds until ${holdsUntil}.`,
				)
			: _(msg`Text on its way to ${who}: your table is ready.`)
	if (textQueued === false)
		return holdsUntil
			? _(
					msg`Marked ready. No text was sent, call ${who}. Holds until ${holdsUntil}.`,
				)
			: _(msg`Marked ready. No text was sent, call ${who}.`)
	return holdsUntil
		? _(msg`Marked ready: ${who}. Holds until ${holdsUntil}.`)
		: _(msg`Marked ready: ${who}.`)
}

/** The end of the hold a notify answer carried (an epoch), or null when it did not say. */
export function holdEndOf(result: unknown): number | null {
	const deadline = (
		result as { entry?: { responseDeadlineAt?: unknown } } | null
	)?.entry?.responseDeadlineAt
	return typeof deadline === 'number' ? deadline : null
}

/**
 * What the stand says once a party leaves the line: they left, or their hold
 * ran out and they did not answer (said as that, not as "left"), or they went
 * back in line.
 */
export function removedToast(
	_: Translate,
	who: string,
	target: 'left' | 'no_response' | 'waiting',
): string {
	if (target === 'no_response')
		return _(msg`${who} did not respond and was removed.`)
	if (target === 'waiting') return _(msg`${who} is back in line.`)
	return _(msg`${who} left the waitlist.`)
}

/**
 * How long a party whose hold ran out stays on the stand, so the host can put
 * them back in line: a guest who answers late (or whose text never arrived) is
 * brought back, not made to join again at the end.
 */
export const NO_RESPONSE_KEEP_MS = 30 * 60_000

/** When a party's hold ended with no answer (null: not known). */
const holdEndedAt = (
	entry: Pick<WaitlistEntry, 'responseDeadlineAt' | 'notifiedAt'>,
) =>
	typeof entry.responseDeadlineAt === 'number'
		? entry.responseDeadlineAt
		: typeof entry.notifiedAt === 'number'
			? entry.notifiedAt
			: null

/** Statuses of a party still waiting for a table. */
export const ACTIVE_WAITLIST = new Set(['waiting', 'notified', 'on_the_way'])

/**
 * A party the stand shows: still in line, or one whose hold ended with no
 * answer in the last half hour (offered a way back, nothing else).
 */
export function staysOnStand(
	entry: Pick<WaitlistEntry, 'status' | 'responseDeadlineAt' | 'notifiedAt'>,
	now: number,
): boolean {
	if (ACTIVE_WAITLIST.has(entry.status)) return true
	if (entry.status !== 'no_response') return false
	const ended = holdEndedAt(entry)
	return ended === null || now - ended <= NO_RESPONSE_KEEP_MS
}

/** A party whose hold ended with no answer and who is not in line any more. */
export const isNoResponse = (entry: Pick<WaitlistEntry, 'status'>) =>
	entry.status === 'no_response'

export type WaitlistSummary = {
	/** Parties in line (those whose hold ran out are not). */
	count: number
	covers: number
	/** Minutes the party that has waited longest has waited (0 for an empty line). */
	longestMin: number
	/** Whether that longest wait is past what the party was quoted. */
	longestOver: boolean
	/** Who the stand offers to seat next: the first in line (null for an empty line). */
	next: WaitlistEntry | null
}

/**
 * What a long waitlist says in one row: how many are waiting for how many
 * covers, the longest wait, and who is next. `entries` are in line order
 * (the stand sorts them by position); parties out of the line do not count.
 */
export function waitlistSummary(
	entries: readonly WaitlistEntry[],
	now: number,
): WaitlistSummary {
	const inLine = entries.filter((e) => ACTIVE_WAITLIST.has(e.status))
	let longest: WaitlistEntry | null = null
	for (const entry of inLine)
		if (!longest || entry.joinedAt < longest.joinedAt) longest = entry
	return {
		count: inLine.length,
		covers: inLine.reduce((sum, e) => sum + e.partySize, 0),
		longestMin: longest ? minutesWaited(longest, now) : 0,
		longestOver:
			longest !== null &&
			longest.quotedMin !== null &&
			minutesWaited(longest, now) > longest.quotedMin,
		next: inLine[0] ?? null,
	}
}

/** A line this long is shown as one summary row until the host opens it. */
export const COMPACT_WAITLIST_OVER = 3

/** The party sizes on the stand's quote strip; the last one stands for that size and up. */
export const QUOTE_SIZES = [1, 2, 3, 4, 5, 6] as const
