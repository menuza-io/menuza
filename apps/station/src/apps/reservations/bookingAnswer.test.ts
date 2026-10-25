import { describe, expect, it } from 'vitest'
import { bookingAnswerOf } from './bookingAnswer.ts'

const tables = [
	{ id: 't1', label: '1' },
	{ id: 't4', label: '4' },
]

describe('what a booking’s answer says', () => {
	it('names the code and the table the booking was given', () => {
		expect(
			bookingAnswerOf({
				reservation: {
					confirmationCode: 'WHSNGV',
					tableIds: ['t1'],
					tableLabels: ['1'],
				},
			}),
		).toEqual({ code: 'WHSNGV', table: '1', textSent: false })
	})
	it('names a table given only by id, from the floor', () => {
		expect(
			bookingAnswerOf({ reservation: { tableIds: ['t1', 't4'] } }, tables)
				.table,
		).toBe('1 + 4')
		// An id the floor does not know is not guessed at.
		expect(
			bookingAnswerOf({ reservation: { tableIds: ['gone'] } }, tables).table,
		).toBeNull()
	})
	it('says no table when the answer gives none', () => {
		expect(bookingAnswerOf({ reservation: { tableIds: [] } }).table).toBeNull()
		expect(bookingAnswerOf({ reservation: {} }).table).toBeNull()
		expect(bookingAnswerOf(null)).toEqual({
			code: null,
			table: null,
			textSent: false,
		})
		expect(bookingAnswerOf('nonsense').code).toBeNull()
	})
	it('says a text was sent only when the answer says so', () => {
		expect(
			bookingAnswerOf({ confirmationSent: true, reservation: {} }).textSent,
		).toBe(true)
		expect(bookingAnswerOf({ reservation: { smsSent: true } }).textSent).toBe(
			true,
		)
		// Anything but a plain true is no claim.
		expect(bookingAnswerOf({ confirmationSent: 'yes' }).textSent).toBe(false)
		expect(bookingAnswerOf({ confirmationSent: false }).textSent).toBe(false)
		expect(bookingAnswerOf({}).textSent).toBe(false)
	})
})
