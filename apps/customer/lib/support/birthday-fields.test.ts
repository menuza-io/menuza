import {
	birthMonthDayFromFields,
	INVALID_BIRTHDAY,
	splitBirthMonthDay,
} from './birthday-fields'

describe('birthday fields', () => {
	it('splits a stored month-day into the two fields', () => {
		expect(splitBirthMonthDay('02-29')).toEqual({ month: '2', day: '29' })
		expect(splitBirthMonthDay(null)).toEqual({ month: '', day: '' })
		expect(splitBirthMonthDay('garbage')).toEqual({ month: '', day: '' })
	})

	it('sets, clears or leaves the birthday alone', () => {
		expect(birthMonthDayFromFields('3', '7')).toBe('03-07')
		expect(birthMonthDayFromFields('', '')).toBeNull()
		expect(birthMonthDayFromFields('3', '')).toBeUndefined()
		expect(birthMonthDayFromFields('2', '30')).toBeUndefined()
		expect(birthMonthDayFromFields('x', '1')).toBeUndefined()
		expect(INVALID_BIRTHDAY).toBe('00-00')
	})
})
