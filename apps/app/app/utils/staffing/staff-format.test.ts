import { describe, expect, it } from 'vitest'
import {
	defaultDialCode,
	formatMoneyMinor,
	minorToInput,
	normalizePhone,
	parseMoneyToMinor,
	staffDisplayName,
	staffInitials,
	todayLocalDate,
} from './staff-format.ts'

describe('staffDisplayName and staffInitials', () => {
	const person = {
		firstName: 'Mona',
		lastName: 'Alharbi',
		firstNameAr: 'منى',
		lastNameAr: 'الحربي',
	}
	it('uses the Arabic spelling for Arabic readers when present', () => {
		expect(staffDisplayName(person, 'ar')).toBe('منى الحربي')
		expect(staffDisplayName(person, 'en')).toBe('Mona Alharbi')
		expect(
			staffDisplayName(
				{ ...person, firstNameAr: null, lastNameAr: null },
				'ar',
			),
		).toBe('Mona Alharbi')
	})
	it('builds up to two initials and survives empty names', () => {
		expect(staffInitials('Mona Alharbi')).toBe('MA')
		expect(staffInitials('  prince ')).toBe('P')
		expect(staffInitials('Mary Jane Watson')).toBe('MJ')
		expect(staffInitials('')).toBe('')
	})
})

describe('money', () => {
	it('formats minor units for each supported currency', () => {
		expect(formatMoneyMinor(1650, 'USD', 'en')).toBe('$16.50')
		expect(formatMoneyMinor(1650, 'CAD', 'en')).toContain('16.50')
		expect(formatMoneyMinor(1650, 'SAR', 'en')).toContain('16.50')
	})
	it('does not throw on an unknown currency code', () => {
		expect(formatMoneyMinor(1000, 'ZZZ!', 'en')).toBe('10.00 ZZZ!')
	})
	it('parses what people type, to the cent and no further', () => {
		expect(parseMoneyToMinor('15')).toBe(1500)
		expect(parseMoneyToMinor('15.5')).toBe(1550)
		expect(parseMoneyToMinor('1,250.75')).toBe(125075)
		expect(parseMoneyToMinor('0.29')).toBe(29)
		expect(parseMoneyToMinor('15.555')).toBeNull()
		expect(parseMoneyToMinor('-3')).toBeNull()
		expect(parseMoneyToMinor('abc')).toBeNull()
		expect(parseMoneyToMinor('')).toBeNull()
	})
	it('round-trips minor units through a text field', () => {
		expect(minorToInput(1650)).toBe('16.50')
		expect(minorToInput(null)).toBe('')
		expect(parseMoneyToMinor(minorToInput(1999))).toBe(1999)
	})
})

describe('phones', () => {
	it('accepts international numbers however they are punctuated', () => {
		expect(normalizePhone('+1 (415) 555-0123')).toBe('+14155550123')
		expect(normalizePhone('00966 55 123 4567')).toBe('+966551234567')
	})
	it('applies the default dialing code only to national numbers', () => {
		expect(normalizePhone('415-555-0123', '1')).toBe('+14155550123')
		expect(normalizePhone('0551234567', '966')).toBe('+966551234567')
		expect(normalizePhone('0551234567', null)).toBeNull()
		expect(normalizePhone('0551234567', '1')).toBeNull()
	})
	it('reads Arabic-Indic digits', () => {
		expect(normalizePhone('+٩٦٦٥٥١٢٣٤٥٦٧')).toBe('+966551234567')
	})
	it('rejects junk and too-short numbers', () => {
		expect(normalizePhone('')).toBeNull()
		expect(normalizePhone('abc')).toBeNull()
		expect(normalizePhone('+12')).toBeNull()
		expect(normalizePhone('+0123456789')).toBeNull()
	})
	it('picks a dialing code only when every workplace agrees', () => {
		expect(defaultDialCode(['SAR', 'SAR'])).toBe('966')
		expect(defaultDialCode(['USD'])).toBe('1')
		expect(defaultDialCode(['USD', 'SAR'])).toBeNull()
		expect(defaultDialCode([])).toBeNull()
	})
})

describe('todayLocalDate', () => {
	it('formats the local calendar date', () => {
		expect(todayLocalDate(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
	})
})
