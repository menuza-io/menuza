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
		).toEqual({ code: 'WHSNGV', table: '1' })
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
		expect(bookingAnswerOf(null)).toEqual({ code: null, table: null })
		expect(bookingAnswerOf('nonsense').code).toBeNull()
	})
	it('never claims a confirmation text: the create route does not say one went out', () => {
		const answer = bookingAnswerOf({
			confirmationSent: true,
			smsSent: true,
			reservation: { confirmationCode: 'ABC123', smsSent: true },
		})
		expect(answer).toEqual({ code: 'ABC123', table: null })
		expect(Object.keys(answer)).not.toContain('textSent')
	})
})
