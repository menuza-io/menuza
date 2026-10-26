import { i18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import { coversText, formatCount, noTablesText } from './labels.ts'

const _ = i18n._.bind(i18n)

describe('how many of a party are here', () => {
	it('says "3 of 5 here" at the door and "seated 3 of 5" at the table', () => {
		expect(coversText(_, { here: 3, of: 5, stage: 'door' })).toBe('3 of 5 here')
		expect(coversText(_, { here: 3, of: 5, stage: 'table' })).toBe(
			'seated 3 of 5',
		)
	})
})

describe('a count in the language’s digits', () => {
	it('groups thousands as the language does, and falls back for a locale it does not know', () => {
		expect(formatCount(1234, 'en')).toBe('1,234')
		expect(formatCount(25, 'not a locale')).toBe('25')
	})
	it('follows the runtime’s default digits for Arabic, like dates and times do', () => {
		const digits = new Intl.NumberFormat('ar').format(25)
		expect(formatCount(25, 'ar')).toBe(digits)
	})
})

describe('what is said when there are no tables to draw', () => {
	it('names the location and says it has no tables yet', () => {
		expect(noTablesText(_, 'Downtown Flagship', 0)).toBe(
			'Downtown Flagship has no tables yet. A manager adds the floor plan in the app, under Reservations, Setup.',
		)
	})
	it('says "this location" when the name is not known', () => {
		expect(noTablesText(_, null, 0)).toContain(
			'this location has no tables yet',
		)
		expect(noTablesText(_, '  ', 0)).toContain(
			'this location has no tables yet',
		)
	})
	it('says how many tables came in when some did but none is shown', () => {
		expect(noTablesText(_, 'Downtown', 1)).toBe(
			'Downtown sent 1 table, but none is in a room that shows. A manager checks the rooms in the app, under Reservations, Setup.',
		)
		expect(noTablesText(_, 'Downtown', 12)).toContain('sent 12 tables')
	})
})
