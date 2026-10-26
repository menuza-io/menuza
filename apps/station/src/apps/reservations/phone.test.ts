import { describe, expect, it } from 'vitest'
import { matchesReservation } from './book.ts'
import { formatPhone } from './guest.ts'
import {
	foldDigits,
	locationCountryCode,
	nationalDigits,
	phoneDigits,
	samePhone,
} from './phone.ts'
import { looksLikePhone } from './sheets.tsx'
import { rsv } from './testing.ts'

/** What the server stores: E.164. A host types what the guest says. */
describe('the same number typed the way a guest says it', () => {
	it('matches a Saudi number with its trunk zero', () => {
		expect(samePhone('0551234567', '+966551234567')).toBe(true)
		expect(samePhone('055 123 4567', '+966 55 123 4567')).toBe(true)
		expect(samePhone('0551234568', '+966551234567')).toBe(false)
	})
	it('matches an Emirati number with its trunk zero', () => {
		expect(samePhone('0501234567', '+971501234567')).toBe(true)
		expect(samePhone('050-123-4567', '+971501234567')).toBe(true)
	})
	it('matches a British number written with 07', () => {
		expect(samePhone('07911 123456', '+447911123456')).toBe(true)
		expect(samePhone('+44 7911 123456', '+447911123456')).toBe(true)
		expect(samePhone('07911 123457', '+447911123456')).toBe(false)
	})
	it('matches a number typed with a plus, and with 00 for the plus', () => {
		expect(samePhone('+966 55 123 4567', '+966551234567')).toBe(true)
		expect(samePhone('00966551234567', '+966551234567')).toBe(true)
		expect(samePhone('00 44 7911 123456', '+447911123456')).toBe(true)
	})
	it('matches an American number with or without the country code', () => {
		expect(samePhone('(415) 555-0142', '+14155550142')).toBe(true)
		expect(samePhone('4155550142', '+14155550142')).toBe(true)
		expect(samePhone('1 415 555 0142', '+14155550142')).toBe(true)
		expect(samePhone('4155550143', '+14155550142')).toBe(false)
	})
	it('matches numbers typed on an Arabic keyboard', () => {
		expect(samePhone('٠٥٥١٢٣٤٥٦٧', '+966551234567')).toBe(true)
		expect(samePhone('۰۵۵۱۲۳۴۵۶۷', '+966551234567')).toBe(true)
		expect(samePhone('+٩٦٦٥٥١٢٣٤٥٦٧', '+966551234567')).toBe(true)
	})
	it('needs at least seven digits on each side', () => {
		expect(samePhone('551234', '+966551234')).toBe(false)
		expect(samePhone('0142', '+14155550142')).toBe(false)
		// What the server shows without the guest grant is only an ending.
		expect(samePhone('••••0142', '+14155550142')).toBe(false)
		expect(samePhone(null, '+14155550142')).toBe(false)
		expect(samePhone('', '')).toBe(false)
	})
	it('does not take a different number for the same one', () => {
		expect(samePhone('+966551234567', '+971551234567')).toBe(false)
	})
})

describe('a number typed without a country code', () => {
	// Saudi 05x and Emirati 05x numbers share their nine national digits.
	const ksaTyped = '0551234567'
	const uaeStored = '+971551234567'
	const ksaStored = '+966551234567'
	it('is a Saudi guest at a Saudi location, never an Emirati one', () => {
		expect(samePhone(ksaTyped, ksaStored, { countryCode: '966' })).toBe(true)
		expect(samePhone(ksaTyped, uaeStored, { countryCode: '966' })).toBe(false)
	})
	it('is an Emirati guest at an Emirati location, never a Saudi one', () => {
		expect(samePhone(ksaTyped, uaeStored, { countryCode: '971' })).toBe(true)
		expect(samePhone(ksaTyped, ksaStored, { countryCode: '971' })).toBe(false)
	})
	it('works whichever side holds the code', () => {
		expect(samePhone(uaeStored, ksaTyped, { countryCode: '966' })).toBe(false)
		expect(samePhone(ksaStored, ksaTyped, { countryCode: '966' })).toBe(true)
	})
	it('keeps an American number typed with its own 1 (no plus) the same', () => {
		expect(
			samePhone('1 415 555 0142', '+14155550142', { countryCode: '1' }),
		).toBe(true)
		expect(samePhone('4155550142', '+14155550142', { countryCode: '1' })).toBe(
			true,
		)
		expect(
			samePhone('4155550142', '+4414155550142', { countryCode: '1' }),
		).toBe(false)
	})
	it('does not second-guess a number that says its country', () => {
		expect(
			samePhone('+966551234567', '+966551234567', { countryCode: '971' }),
		).toBe(true)
		expect(
			samePhone('00966551234567', '+966551234567', { countryCode: '971' }),
		).toBe(true)
		expect(
			samePhone('+966551234567', '+971551234567', { countryCode: '966' }),
		).toBe(false)
	})
	it('is compared as it always was when the location’s country is not known', () => {
		expect(samePhone(ksaTyped, uaeStored)).toBe(true)
		expect(samePhone(ksaTyped, uaeStored, { countryCode: null })).toBe(true)
	})
})

describe('the country a location’s numbers are in', () => {
	const phones = ['+971501111111', '+971502222222', '+966551234567', null, '']
	it('comes from the time zone when that says', () => {
		expect(locationCountryCode({ timeZone: 'Asia/Riyadh', phones })).toBe('966')
		expect(locationCountryCode({ timeZone: 'Asia/Dubai', phones: [] })).toBe(
			'971',
		)
		expect(
			locationCountryCode({ timeZone: 'America/Chicago', phones: [] }),
		).toBe('1')
	})
	it('is the most common code in the book when the zone says nothing', () => {
		expect(locationCountryCode({ timeZone: 'UTC', phones })).toBe('971')
		expect(locationCountryCode({ phones })).toBe('971')
	})
	it('ignores numbers with no code, or only an ending', () => {
		expect(
			locationCountryCode({ phones: ['0551234567', '••••4567', '4155550142'] }),
		).toBeNull()
	})
})

describe('digits from any keyboard', () => {
	it('folds Arabic-Indic and Persian digits', () => {
		expect(foldDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789')
		expect(foldDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789')
		expect(phoneDigits('+٩٦٦ 55')).toBe('96655')
		expect(phoneDigits(null)).toBe('')
	})
	it('takes one trunk zero, or 00, off a number that is not international', () => {
		expect(nationalDigits('0551234567')).toBe('551234567')
		expect(nationalDigits('00966551234567')).toBe('966551234567')
		expect(nationalDigits('+966551234567')).toBe('966551234567')
		expect(nationalDigits('4155550142')).toBe('4155550142')
		// Only one zero: the next is the number's own.
		expect(nationalDigits('0055')).toBe('55')
	})
	it('keeps Arabic digits in a phone field instead of swallowing them', () => {
		expect(formatPhone('٠٥٥١٢٣٤٥٦٧')).toBe('055 123 4567')
		expect(formatPhone('+٩٦٦٥٥١٢٣٤٥٦٧')).toBe('+966 551 234 567')
		expect(looksLikePhone('+٩٦٦ ٥٥ ١٢٣ ٤٥٦٧')).toBe(true)
		expect(looksLikePhone('٠٥٥١٢٣٤٥٦٧')).toBe(true)
		expect(looksLikePhone('١٢٣')).toBe(false)
	})
})

describe('a search by phone number', () => {
	const rana = rsv({
		start: 600,
		guest: {
			id: 'g',
			name: 'Rana Khalid',
			firstName: 'Rana',
			lastName: 'Khalid',
			phone: '+966551234567',
		},
	})
	const finds = (query: string) => matchesReservation(rana, query)
	it('finds the end of the number, whatever is typed', () => {
		expect(finds('4567')).toBe(true)
		expect(finds('٤٥٦٧')).toBe(true)
		expect(finds('9999')).toBe(false)
	})
	it('finds a full number typed with its trunk zero', () => {
		expect(finds('0551234567')).toBe(true)
		expect(finds('055 123 4567')).toBe(true)
		expect(finds('055 123 4568')).toBe(false)
	})
	it('finds a number typed with the country code, a plus or 00', () => {
		expect(finds('+966 55 123 4567')).toBe(true)
		expect(finds('00966551234567')).toBe(true)
		expect(finds('966551234567')).toBe(true)
	})
	it('finds a number typed on an Arabic keyboard', () => {
		expect(finds('٠٥٥١٢٣٤٥٦٧')).toBe(true)
	})
	it('finds a UK number typed with 07, and a UAE one with 05', () => {
		const uk = rsv({
			start: 600,
			guest: {
				id: 'g2',
				name: 'Ed Smith',
				firstName: 'Ed',
				lastName: 'Smith',
				phone: '+447911123456',
			},
		})
		expect(matchesReservation(uk, '07911 123456')).toBe(true)
		const uae = rsv({
			start: 600,
			guest: {
				id: 'g3',
				name: 'Hind Said',
				firstName: 'Hind',
				lastName: 'Said',
				phone: '+971501234567',
			},
		})
		expect(matchesReservation(uae, '0501234567')).toBe(true)
	})
})
