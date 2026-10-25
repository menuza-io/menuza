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
 * How a party that was told their table is ready was told: a text was sent,
 * none was (call them), or it is not known (an older server did not say).
 * What the notify answer said is the truth; with no answer to go on (the
 * party was told on another tablet, or before this one opened), a party that
 * cannot be texted was certainly not texted, and any other is only "told".
 */
export type ToldHow = 'text_sent' | 'no_text' | 'told'

export function toldHow(
	entry: Pick<WaitlistEntry, 'phone' | 'smsOptIn'>,
	textQueued: boolean | undefined,
): ToldHow {
	if (textQueued === true) return 'text_sent'
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
 * a text only when one was queued (the stand never claims what it was not told).
 */
export function notifiedToast(
	_: Translate,
	who: string,
	textQueued: boolean | undefined,
): string {
	if (textQueued === true) return _(msg`Texted ${who}: your table is ready.`)
	if (textQueued === false)
		return _(msg`Marked ready. No text was sent, call ${who}.`)
	return _(msg`Marked ready: ${who}.`)
}
