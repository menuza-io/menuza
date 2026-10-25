import { i18n } from '@lingui/core'
import { describe, expect, it } from 'vitest'
import {
	bookingMeta,
	depositState,
	dietaryNoteOf,
	dietaryOf,
	formatPhone,
	freeDietaryText,
	hasAnyAllergy,
	historyLine,
	isGuestChannel,
	showsAllergyMark,
	sourceLabel,
	tagChips,
} from './guest.ts'
import { at, rsv } from './testing.ts'

const _ = i18n._.bind(i18n)
const day = (ms: number) =>
	new Intl.DateTimeFormat('en', {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	}).format(ms)

const guest = (over: Record<string, unknown> = {}) =>
	rsv({
		start: 1140,
		guest: { id: 'g', name: 'Maya Haddad', firstName: 'Maya', ...over },
	}).guest!

describe('dietary codes', () => {
	it('say the allergens first, in words, apart from the preferences', () => {
		const r = rsv({
			start: 600,
			dietaryCodes: ['shellfish_allergy', 'vegan', 'nut_allergy', 'halal'],
		})
		expect(dietaryOf(_, r)).toEqual({
			allergens: ['shellfish', 'tree nuts'],
			diets: ['Vegan', 'Halal'],
		})
		expect(hasAnyAllergy(r)).toBe(true)
	})
	it('shows a code it does not know as itself, and a diet alone is no allergy', () => {
		const r = rsv({ start: 600, dietaryCodes: ['low_sodium'] })
		expect(dietaryOf(_, r)).toEqual({ allergens: [], diets: ['low sodium'] })
		expect(hasAnyAllergy(r)).toBe(false)
		expect(hasAnyAllergy(rsv({ start: 600, hasAllergy: true }))).toBe(true)
	})
})

describe('free text in a dietary note', () => {
	it('is what is left once the coded values are taken out', () => {
		expect(
			freeDietaryText('shellfish_allergy, nut_allergy, gluten_free'),
		).toBeNull()
		expect(freeDietaryText('Nut Allergy; Gluten-Free')).toBeNull()
		expect(freeDietaryText('nut_allergy, no raw onion')).toBe('no raw onion')
		expect(freeDietaryText('Peanuts, severe')).toBe('Peanuts, severe')
		expect(freeDietaryText('')).toBeNull()
		expect(freeDietaryText(null)).toBeNull()
	})
})

describe('tags', () => {
	it('put the VIP first, keep the rest, and leave out the system first visit', () => {
		const r = rsv({
			start: 600,
			guest: {
				id: 'g',
				name: 'A',
				tags: [
					{ id: '1', name: 'Wine lover' },
					{ id: '2', name: 'First visit', systemKey: 'first_visit' },
					{ id: '3', name: 'VIP' },
					{ id: '4', name: 'Friend of chef' },
				],
			},
		})
		expect(tagChips(r).map((c) => [c.label, c.tone])).toEqual([
			['VIP', 'vip'],
			['Wine lover', 'plain'],
			['Friend of chef', 'plain'],
		])
		expect(tagChips(rsv({ start: 600 }))).toEqual([])
	})
})

describe('the history line', () => {
	it('says visits, the last one, and no-shows', () => {
		const g = guest({ visits: 9, noShows: 0, lastVisitAt: at(0) })
		expect(historyLine(_, g, day)).toEqual({
			text: '9 past visits · last Mar 2 · 0 no-shows',
			warn: false,
		})
		expect(
			historyLine(_, guest({ visits: 1, lastVisitAt: at(0) }), day).text,
		).toBe('1 past visit · last Mar 2 · 0 no-shows')
	})
	it('never contradicts itself for a guest with no visit', () => {
		expect(historyLine(_, guest({ visits: 0 }), day).text).toBe(
			'No past visits',
		)
		expect(historyLine(_, guest({ visits: 0, noShows: 1 }), day).text).toBe(
			'No past visits · 1 no-show',
		)
	})
	it('warns at two no-shows or two late cancels, and says late cancels', () => {
		expect(historyLine(_, guest({ visits: 3, noShows: 1 }), day).warn).toBe(
			false,
		)
		expect(historyLine(_, guest({ visits: 3, noShows: 2 }), day).warn).toBe(
			true,
		)
		const late = historyLine(_, guest({ visits: 3, lateCancels: 2 }), day)
		expect(late.warn).toBe(true)
		expect(late.text).toContain('2 late cancels')
	})
})

describe('how it was booked', () => {
	it('names the source from the channel and the client', () => {
		const label = (channel: string, client?: string) =>
			sourceLabel(_, { channel, client })
		expect(label('online', 'web')).toBe('Online')
		expect(label('online')).toBe('Online')
		expect(label('native', 'ios')).toBe('iOS app')
		expect(label('native', 'android')).toBe('Android app')
		expect(label('phone')).toBe('Phone')
		expect(label('host')).toBe('Host stand')
		expect(label('mystery_box')).toBe('mystery box')
		expect(isGuestChannel('online')).toBe(true)
		expect(isGuestChannel('native')).toBe(true)
		expect(isGuestChannel('phone')).toBe(false)
		expect(isGuestChannel('host')).toBe(false)
	})
	it('has the code and the day it was booked', () => {
		expect(
			bookingMeta(
				_,
				{
					channel: 'online',
					client: 'web',
					confirmationCode: 'WHSNGV',
					createdAt: at(0),
				},
				day,
			),
		).toEqual({ source: 'Online', code: 'WHSNGV', booked: 'booked Mar 2' })
		expect(
			bookingMeta(
				_,
				{ channel: 'phone', confirmationCode: '', createdAt: null },
				day,
			).booked,
		).toBe('')
	})
	it('reads the deposit from the payment', () => {
		const state = (paymentStatus: string, status = 'booked') =>
			depositState({ paymentStatus, status })
		expect(state('paid')).toBe('paid')
		expect(state('guaranteed')).toBe('card')
		expect(state('pending')).toBe('awaiting')
		expect(state('none', 'pending_payment')).toBe('awaiting')
		expect(state('none')).toBeNull()
		expect(state('refunded')).toBeNull()
	})
})

describe('phone numbers', () => {
	it('are grouped by country, as they are read out', () => {
		expect(formatPhone('+14155550142')).toBe('+1 415 555 0142')
		expect(formatPhone('+966512345678')).toBe('+966 512 345 678')
		expect(formatPhone('+971501234567')).toBe('+971 501 234 567')
		expect(formatPhone('+447911123456')).toBe('+44 791 112 3456')
		expect(formatPhone('4155550142')).toBe('415 555 0142')
	})
	it('can be applied to what is being typed, keeping what was typed', () => {
		expect(formatPhone('')).toBe('')
		expect(formatPhone('+')).toBe('+')
		expect(formatPhone('+1')).toBe('+1')
		expect(formatPhone('+1 41555')).toBe('+1 415 55')
		expect(formatPhone('+1 (415) 555-0142')).toBe('+1 415 555 0142')
		expect(formatPhone('  12 ')).toBe('12')
	})
})

describe('the allergy banner', () => {
	// The server raises `hasAllergy` for ANY dietary note: "vegan" and "halal" included.
	const booking = (over: Record<string, unknown> = {}) =>
		rsv({ start: 600, ...over })

	describe('with the guest-details grant', () => {
		it('warns for a coded allergen', () => {
			const r = booking({
				hasAllergy: true,
				dietaryCodes: ['shellfish_allergy', 'vegan'],
			})
			expect(dietaryNoteOf(_, r, true)).toEqual({
				kind: 'allergy',
				allergens: ['shellfish'],
				text: null,
			})
			expect(showsAllergyMark(r, true)).toBe(true)
		})
		it('warns for allergy text, the guest’s or the booking’s', () => {
			const own = booking({
				hasAllergy: true,
				guest: {
					id: 'g',
					name: 'A B',
					firstName: 'A',
					allergyNotes: 'Peanuts, severe',
				},
			})
			expect(dietaryNoteOf(_, own, true)).toEqual({
				kind: 'allergy',
				allergens: [],
				text: 'Peanuts, severe',
			})
			const typed = booking({ hasAllergy: true, dietaryNotes: 'no raw onion' })
			expect(dietaryNoteOf(_, typed, true)).toMatchObject({
				kind: 'allergy',
				text: 'no raw onion',
			})
		})
		it('says a diet as a quiet line, never as an allergy', () => {
			const vegan = booking({
				hasAllergy: true,
				dietaryCodes: ['vegan'],
				dietaryNotes: 'vegan',
			})
			expect(dietaryNoteOf(_, vegan, true)).toEqual({
				kind: 'diet',
				diets: ['Vegan'],
			})
			expect(showsAllergyMark(vegan, true)).toBe(false)
			const both = booking({
				hasAllergy: true,
				dietaryCodes: ['vegan', 'halal'],
			})
			expect(dietaryNoteOf(_, both, true)).toEqual({
				kind: 'diet',
				diets: ['Vegan', 'Halal'],
			})
		})
		it('says nothing when there is nothing to say', () => {
			expect(dietaryNoteOf(_, booking(), true)).toBeNull()
			// Flagged but with nothing readable and no diet: nothing to show.
			expect(dietaryNoteOf(_, booking({ hasAllergy: true }), true)).toBeNull()
			expect(showsAllergyMark(booking(), true)).toBe(false)
		})
	})

	describe('without the grant', () => {
		it('still warns for a coded allergen, which every host is sent', () => {
			const r = booking({ hasAllergy: true, dietaryCodes: ['nut_allergy'] })
			expect(dietaryNoteOf(_, r, false)).toEqual({
				kind: 'allergy',
				allergens: ['tree nuts'],
				text: null,
			})
			expect(showsAllergyMark(r, false)).toBe(true)
		})
		it('says a note is on file when it cannot say what it is, not that it is an allergy', () => {
			const r = booking({ hasAllergy: true, dietaryNotes: 'Peanuts, severe' })
			expect(dietaryNoteOf(_, r, false)).toEqual({ kind: 'unreadable' })
			// A flag nobody can explain is treated as an allergy: the safe way round.
			expect(showsAllergyMark(r, false)).toBe(true)
		})
		it('never leaks the text the grant guards', () => {
			const r = booking({
				hasAllergy: true,
				dietaryNotes: 'Peanuts, severe',
				guest: {
					id: 'g',
					name: 'A B',
					firstName: 'A',
					allergyNotes: 'Peanuts',
				},
			})
			expect(JSON.stringify(dietaryNoteOf(_, r, false))).not.toContain(
				'Peanuts',
			)
		})
		it('says nothing for a booking with no flag', () => {
			expect(dietaryNoteOf(_, booking(), false)).toBeNull()
			expect(showsAllergyMark(booking(), false)).toBe(false)
		})
	})
})
