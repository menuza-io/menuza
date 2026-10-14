import { type MessageDescriptor } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { card, HOUR, NINE_AM } from './timesheet-fixtures.ts'
import {
	buildCreateBody,
	buildUpdateBody,
	cardToForm,
	emptyBreak,
	emptyForm,
	isMeaningfulReason,
	resolveCardTimes,
	validateCardForm,
	type CardForm,
} from './timesheet-form.ts'

const tr = (descriptor: MessageDescriptor) =>
	descriptor.message ?? descriptor.id ?? ''
const ZONE = 'America/Chicago'
// Mar 2 2026, 10 hours after the card opened.
const NOW = NINE_AM + 10 * HOUR

function form(overrides: Partial<CardForm> = {}): CardForm {
	return {
		...emptyForm({ scopeId: 'loc-1', staffId: 's1', date: '2026-03-02' }),
		start: '09:00',
		end: '17:00',
		reason: 'Forgot to clock out',
		...overrides,
	}
}

const create = {
	mode: 'create',
	timeZone: ZONE,
	now: NOW,
	moneyVisible: false,
} as const

describe('starting values', () => {
	it('shows a card in its own zone, tips only with money', () => {
		const start = cardToForm(
			card({
				clockOutAt: NINE_AM + 8 * HOUR + 30 * 60_000,
				breaks: [
					{
						id: 'b1',
						kind: 'meal',
						paid: false,
						startAt: NINE_AM + 4 * HOUR,
						endAt: NINE_AM + 4.5 * HOUR,
					},
				],
				managerNote: 'Covered a call-out',
				money: {
					estimate: true,
					currency: 'USD',
					rateMinor: 2000,
					payMinor: 16000,
					cashTipsMinor: 1250,
					creditTipsMinor: 0,
				},
			}),
		)
		expect(start).toMatchObject({
			date: '2026-03-02',
			start: '09:00',
			end: '17:30',
			cashTips: '12.50',
			creditTips: '0.00',
			note: 'Covered a call-out',
			reason: '',
		})
		expect(start.breaks[0]).toMatchObject({
			start: '13:00',
			end: '13:30',
			kind: 'meal',
		})
		expect(cardToForm(card()).cashTips).toBe('')
	})

	it('leaves the end blank for a card that is still open', () => {
		expect(cardToForm(card({ clockOutAt: null, status: 'open' })).end).toBe('')
	})
})

describe('resolving times', () => {
	it('rolls an end that is not after the start to the next day', () => {
		const times = resolveCardTimes(
			form({ start: '22:00', end: '02:00' }),
			ZONE,
		)!
		expect((times.clockOutAt! - times.clockInAt) / HOUR).toBe(4)
	})

	it('is one hour short across spring-forward', () => {
		// US clocks jump forward on 2026-03-08 at 02:00.
		const times = resolveCardTimes(
			form({ date: '2026-03-07', start: '22:00', end: '06:00' }),
			ZONE,
		)!
		expect((times.clockOutAt! - times.clockInAt) / HOUR).toBe(7)
	})

	it('is null until the form has usable times, open when the end is blank', () => {
		expect(resolveCardTimes(form({ start: '' }), ZONE)).toBeNull()
		expect(resolveCardTimes(form({ date: 'nope' }), ZONE)).toBeNull()
		expect(resolveCardTimes(form({ end: '' }), ZONE)!.clockOutAt).toBeNull()
	})
})

describe('validation', () => {
	it('accepts a clean new card', () => {
		expect(validateCardForm(form(), create, tr)).toEqual({})
	})

	it('asks for the person, the workplace and a real reason', () => {
		const errors = validateCardForm(
			form({ staffId: '', scopeId: '', reason: ' ​ ' }),
			create,
			tr,
		)
		expect(Object.keys(errors).sort()).toEqual(['reason', 'scopeId', 'staffId'])
		expect(isMeaningfulReason('...')).toBe(false)
		expect(isMeaningfulReason('Late')).toBe(true)
	})

	it('refuses times that have not happened on the server clock', () => {
		const errors = validateCardForm(
			form({ date: '2026-03-03', start: '09:00', end: '17:00' }),
			create,
			tr,
		)
		expect(errors.start).toMatch(/not happened/)
		const endsLater = validateCardForm(form({ end: '23:00' }), create, tr)
		expect(endsLater.end).toMatch(/not happened/)
	})

	it('treats an equal start and end as a full 24 hours, not zero', () => {
		const times = resolveCardTimes(
			form({ date: '2026-03-01', start: '09:00', end: '09:00' }),
			ZONE,
		)!
		expect((times.clockOutAt! - times.clockInAt) / HOUR).toBe(24)
		expect(
			validateCardForm(
				form({ date: '2026-03-01', start: '09:00', end: '09:00' }),
				create,
				tr,
			),
		).toEqual({})
	})

	it('checks breaks fall inside the shift, do not overlap, and need both times', () => {
		const inside = { ...emptyBreak(), start: '12:00', end: '12:30' }
		const outside = { ...emptyBreak(), start: '18:00', end: '18:30' }
		const overlapping = { ...emptyBreak(), start: '12:15', end: '12:45' }
		const half = { ...emptyBreak(), start: '14:00', end: '' }
		const errors = validateCardForm(
			form({ breaks: [inside, outside, overlapping, half] }),
			create,
			tr,
		)
		expect(errors[`break:${inside.key}`]).toBeUndefined()
		expect(errors[`break:${outside.key}`]).toMatch(/inside the shift/)
		expect(errors[`break:${overlapping.key}`]).toMatch(/overlap/)
		expect(errors[`break:${half.key}`]).toMatch(/started and ended/)
	})

	it('needs an end time for a new card but not for an open one being edited', () => {
		expect(validateCardForm(form({ end: '' }), create, tr).end).toBeTruthy()
		const open = validateCardForm(
			form({ end: '' }),
			{
				mode: 'edit',
				timeZone: ZONE,
				now: NOW,
				moneyVisible: false,
				original: { clockOutAt: null },
			},
			tr,
		)
		expect(open).toEqual({})
		const closed = validateCardForm(
			form({ end: '' }),
			{
				mode: 'edit',
				timeZone: ZONE,
				now: NOW,
				moneyVisible: false,
				original: { clockOutAt: NINE_AM },
			},
			tr,
		)
		expect(closed.end).toBeTruthy()
	})

	it('wants a position only when the person holds several', () => {
		expect(
			validateCardForm(form(), { ...create, positionRequired: true }, tr)
				.positionId,
		).toBeTruthy()
		expect(
			validateCardForm(
				form({ positionId: 'p1' }),
				{ ...create, positionRequired: true },
				tr,
			).positionId,
		).toBeUndefined()
	})

	it('checks tips only when money is visible', () => {
		const bad = form({ cashTips: 'abc' })
		expect(validateCardForm(bad, create, tr).cashTips).toBeUndefined()
		expect(
			validateCardForm(bad, { ...create, moneyVisible: true }, tr).cashTips,
		).toBeTruthy()
	})
})

describe('request bodies', () => {
	it('builds a create body in local time, leaving money out without the grant', () => {
		const body = buildCreateBody(
			form({ cashTips: '5', note: ' hi ', positionId: 'p1' }),
			false,
		)
		expect(body).toEqual({
			staffId: 's1',
			scopeId: 'loc-1',
			positionId: 'p1',
			date: '2026-03-02',
			startTime: '09:00',
			endTime: '17:00',
			breaks: [],
			managerNote: 'hi',
			reason: 'Forgot to clock out',
		})
		expect(buildCreateBody(form({ cashTips: '5' }), true)).toMatchObject({
			cashTipsMinor: 500,
		})
	})

	it('sends only what changed, with the version and the reason', () => {
		const original = card({ version: 4 })
		const untouched = buildUpdateBody(
			original,
			{ ...cardToForm(original), reason: 'x' },
			false,
		)
		expect(untouched.changed).toBe(false)

		const edited = buildUpdateBody(
			original,
			{
				...cardToForm(original),
				end: '17:30',
				reason: ' Left late ',
				note: 'ok',
			},
			false,
		)
		expect(edited.changed).toBe(true)
		expect(edited.body).toEqual({
			expectedVersion: 4,
			reason: 'Left late',
			clockOutAt: NINE_AM + 8.5 * HOUR,
			managerNote: 'ok',
		})
	})

	it('moves the clock-in as an instant in the card zone', () => {
		const original = card()
		const { body } = buildUpdateBody(
			original,
			{ ...cardToForm(original), start: '08:45', reason: 'r' },
			false,
		)
		expect(body.clockInAt).toBe(NINE_AM - 15 * 60_000)
		expect(body).not.toHaveProperty('clockOutAt')
	})

	it('sends the whole break list when any break changes, and clears a note with null', () => {
		const original = card({ managerNote: 'was here' })
		const start = cardToForm(original)
		const { body } = buildUpdateBody(
			original,
			{
				...start,
				note: '',
				breaks: [{ ...emptyBreak('rest'), start: '12:00', end: '12:10' }],
				reason: 'r',
			},
			false,
		)
		expect(body.breaks).toEqual([
			{ kind: 'rest', startTime: '12:00', endTime: '12:10' },
		])
		expect(body.managerNote).toBeNull()
	})

	it('sends tips in minor units only when changed and visible', () => {
		const original = card({
			money: {
				estimate: true,
				currency: 'USD',
				rateMinor: 2000,
				payMinor: 16000,
				cashTipsMinor: 1000,
				creditTipsMinor: 0,
			},
		})
		const start = cardToForm(original)
		const same = buildUpdateBody(original, { ...start, reason: 'r' }, true)
		expect(same.changed).toBe(false)
		const changed = buildUpdateBody(
			original,
			{ ...start, cashTips: '12.5', creditTips: '', reason: 'r' },
			true,
		)
		expect(changed.body).toMatchObject({ cashTipsMinor: 1250 })
		expect(changed.body).not.toHaveProperty('creditTipsMinor')
		const hidden = buildUpdateBody(
			original,
			{ ...start, cashTips: '99', reason: 'r' },
			false,
		)
		expect(hidden.changed).toBe(false)
	})

	it('changes the position only when a different one is chosen', () => {
		const original = card()
		const { body } = buildUpdateBody(
			original,
			{ ...cardToForm(original), positionId: 'p2', reason: 'r' },
			false,
		)
		expect(body.positionId).toBe('p2')
	})
	it('never moves an untouched punch on the night the clocks go back', () => {
		// 01:30 happens twice in Chicago on 2026-11-01; this card opened at the second one.
		const original = card({
			timeZone: ZONE,
			clockInAt: Date.UTC(2026, 10, 1, 7, 30),
			clockOutAt: Date.UTC(2026, 10, 1, 15, 0),
			breaks: [
				{
					id: 'b1',
					kind: 'rest',
					paid: true,
					startAt: Date.UTC(2026, 10, 1, 7, 40),
					endAt: Date.UTC(2026, 10, 1, 7, 50),
				},
			],
		})
		const start = cardToForm(original)
		const noteOnly = buildUpdateBody(
			original,
			{ ...start, note: 'Closed alone', reason: 'Added a note' },
			false,
		)
		expect(noteOnly.body).toEqual({
			expectedVersion: 1,
			reason: 'Added a note',
			managerNote: 'Closed alone',
		})
		// Moving the end still works and leaves the clock-in alone.
		const later = buildUpdateBody(
			original,
			{ ...start, end: '10:00', reason: 'Stayed late' },
			false,
		)
		expect(later.body).not.toHaveProperty('clockInAt')
		expect(later.body).toHaveProperty('clockOutAt')
	})
})
