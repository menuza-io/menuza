import { i18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { entry, MIN, at } from './testing.ts'
import {
	holdEndOf,
	isNoResponse,
	joinedOnline,
	minutesWaited,
	NO_RESPONSE_KEEP_MS,
	notifiedToast,
	removedToast,
	staysOnStand,
	textability,
	textedState,
	textQueuedOf,
	toldHow,
	URGENT_MS,
	waitlistSummary,
} from './waitlist.ts'

const _ = i18n._.bind(i18n)

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

describe('whether a party can be texted: number x consent x node', () => {
	const phones = [null, '+14155550132']
	const consents = [false, true]
	const nodes = [undefined, true, false] as const
	for (const phone of phones)
		for (const smsOptIn of consents)
			for (const smsAvailable of nodes) {
				const expected = !phone
					? 'no_phone'
					: !smsOptIn
						? 'no_consent'
						: smsAvailable === false
							? 'no_sms'
							: 'ok'
				it(`phone ${phone ?? 'none'}, consent ${smsOptIn}, node sends texts ${smsAvailable ?? 'unknown'}: ${expected}`, () => {
					expect(textability({ phone, smsOptIn }, { smsAvailable })).toBe(
						expected,
					)
				})
			}
	it('counts a node whose texting is not known as one that texts', () => {
		expect(textability({ phone: '+1415', smsOptIn: true }, {})).toBe('ok')
	})
})

describe('what "tell them it\'s ready" did about a text', () => {
	it('reads the answer: true only when a text was queued', () => {
		expect(textQueuedOf({ ok: true, textQueued: true })).toBe(true)
		expect(textQueuedOf({ ok: true, textQueued: false })).toBe(false)
		// An older server, or a repeat tap that queued nothing, says nothing.
		expect(textQueuedOf({ ok: true })).toBeUndefined()
		expect(textQueuedOf(null)).toBeUndefined()
		expect(textQueuedOf({ textQueued: 'yes' })).toBeUndefined()
		expect(textQueuedOf(undefined)).toBeUndefined()
	})
	it('says a text is "on its way" only when the answer says one was queued, never "sent"', () => {
		expect(notifiedToast(_, 'Sofia', true)).toBe(
			'Text on its way to Sofia: your table is ready.',
		)
		expect(notifiedToast(_, 'Sofia', true)).not.toMatch(/texted|sent/i)
		expect(notifiedToast(_, 'Sofia', false)).toBe(
			'Marked ready. No text was sent, call Sofia.',
		)
		expect(notifiedToast(_, 'Sofia', undefined)).toBe('Marked ready: Sofia.')
	})
	it('knows how a party was told: the answer first, then what is certain', () => {
		const texted = { phone: '+14155550132', smsOptIn: true }
		expect(toldHow(texted, true)).toBe('text_queued')
		// The answer beats what the entry suggests, either way.
		expect(toldHow(texted, false)).toBe('no_text')
		expect(toldHow({ phone: null, smsOptIn: false }, true)).toBe('text_queued')
		// No answer: a party that cannot be texted certainly was not; any other is only told.
		expect(toldHow(texted, undefined)).toBe('told')
		expect(toldHow({ phone: '+14155550132', smsOptIn: false }, undefined)).toBe(
			'no_text',
		)
		expect(toldHow({ phone: null, smsOptIn: true }, undefined)).toBe('no_text')
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

describe('saying plainly when a hold ends', () => {
	it('adds the end of the hold to what the stand says after telling them', () => {
		expect(notifiedToast(_, 'Sofia', true, '1:36 PM')).toBe(
			'Text on its way to Sofia: your table is ready. Holds until 1:36 PM.',
		)
		expect(notifiedToast(_, 'Sofia', false, '1:36 PM')).toBe(
			'Marked ready. No text was sent, call Sofia. Holds until 1:36 PM.',
		)
		expect(notifiedToast(_, 'Sofia', undefined, '1:36 PM')).toBe(
			'Marked ready: Sofia. Holds until 1:36 PM.',
		)
	})
	it('reads the end of the hold from the answer, when it carries one', () => {
		expect(holdEndOf({ entry: { responseDeadlineAt: now + 6 * MIN } })).toBe(
			now + 6 * MIN,
		)
		expect(holdEndOf({ entry: {} })).toBeNull()
		expect(holdEndOf(null)).toBeNull()
	})
})

describe('what the stand says when a party leaves the line', () => {
	it('says a hold that ran out was not a party that left', () => {
		expect(removedToast(_, 'Amira', 'no_response')).toBe(
			'Amira did not respond and was removed.',
		)
		expect(removedToast(_, 'Amira', 'left')).toBe('Amira left the waitlist.')
		expect(removedToast(_, 'Amira', 'waiting')).toBe('Amira is back in line.')
	})
})

describe('a party whose hold ended with no answer', () => {
	const ended = (agoMin: number) =>
		entry({
			status: 'no_response',
			notifiedAt: now - (agoMin + 10) * MIN,
			responseDeadlineAt: now - agoMin * MIN,
		})
	it('stays on the stand for half an hour, to be put back in line', () => {
		expect(NO_RESPONSE_KEEP_MS).toBe(30 * 60_000)
		expect(isNoResponse(ended(1))).toBe(true)
		expect(staysOnStand(ended(1), now)).toBe(true)
		expect(staysOnStand(ended(29), now)).toBe(true)
		expect(staysOnStand(ended(31), now)).toBe(false)
	})
	it('is kept when the server did not say when the hold ended', () => {
		expect(
			staysOnStand(
				{ status: 'no_response', notifiedAt: null, responseDeadlineAt: null },
				now,
			),
		).toBe(true)
	})
	it('still shows a party in line, and never one who left or was seated', () => {
		for (const status of ['waiting', 'notified', 'on_the_way'] as const)
			expect(staysOnStand(entry({ status }), now)).toBe(true)
		for (const status of ['left', 'seated', 'cancelled'] as const)
			expect(staysOnStand(entry({ status }), now)).toBe(false)
	})
})

describe('a long waitlist in one row', () => {
	const line = [
		entry({
			displayName: 'Jamal',
			partySize: 2,
			joinedAt: now - 8 * MIN,
			quotedMin: 10,
		}),
		entry({
			displayName: 'Sofia',
			partySize: 4,
			joinedAt: now - 21 * MIN,
			quotedMin: 20,
		}),
		entry({
			displayName: 'Wei',
			partySize: 3,
			joinedAt: now - 3 * MIN,
			quotedMin: 25,
		}),
	]
	it('counts the parties and covers, finds the longest wait and who is next', () => {
		const summary = waitlistSummary(line, now)
		expect(summary).toMatchObject({
			count: 3,
			covers: 9,
			longestMin: 21,
			longestOver: true,
		})
		// The first in line, not the one who has waited longest.
		expect(summary.next?.displayName).toBe('Jamal')
	})
	it('says the longest wait is fine while it is inside the quote', () => {
		const summary = waitlistSummary(
			[entry({ joinedAt: now - 9 * MIN, quotedMin: 10 })],
			now,
		)
		expect(summary.longestOver).toBe(false)
		expect(
			waitlistSummary(
				[entry({ joinedAt: now - 9 * MIN, quotedMin: null })],
				now,
			).longestOver,
		).toBe(false)
	})
	it('leaves out a party whose hold ran out, and is empty for no line', () => {
		const out = entry({ status: 'no_response', joinedAt: now - 60 * MIN })
		expect(waitlistSummary([out, ...line], now).longestMin).toBe(21)
		expect(waitlistSummary([out], now)).toEqual({
			count: 0,
			covers: 0,
			longestMin: 0,
			longestOver: false,
			next: null,
		})
	})
	it('offers a party that was told their table is ready as next, like any in line', () => {
		const first = told({ displayName: 'Amira' })
		expect(waitlistSummary([first, ...line], now).next?.displayName).toBe(
			'Amira',
		)
	})
})
