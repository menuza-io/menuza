import { i18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { entry, MIN, at } from './testing.ts'
import {
	joinedOnline,
	minutesWaited,
	notifiedToast,
	textability,
	textedState,
	textQueuedOf,
	toldHow,
	URGENT_MS,
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
	it('says "Texted" only when the answer says so', () => {
		expect(notifiedToast(_, 'Sofia', true)).toBe(
			'Texted Sofia: your table is ready.',
		)
		expect(notifiedToast(_, 'Sofia', false)).toBe(
			'Marked ready. No text was sent, call Sofia.',
		)
		expect(notifiedToast(_, 'Sofia', undefined)).toBe('Marked ready: Sofia.')
	})
	it('knows how a party was told: the answer first, then what is certain', () => {
		const texted = { phone: '+14155550132', smsOptIn: true }
		expect(toldHow(texted, true)).toBe('text_sent')
		// The answer beats what the entry suggests, either way.
		expect(toldHow(texted, false)).toBe('no_text')
		expect(toldHow({ phone: null, smsOptIn: false }, true)).toBe('text_sent')
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
