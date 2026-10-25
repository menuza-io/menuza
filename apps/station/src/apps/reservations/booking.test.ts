import { describe, expect, it } from 'vitest'
import {
	addDays,
	bookingBlocker,
	bookingDirty,
	dayChips,
	hasNote,
	keepOpenTime,
	toggleNote,
	walkInDirty,
	waitlistDirty,
} from './booking.ts'

const slot = (localStartMin: number, available = true) => ({
	localStartMin,
	available,
})

describe('the time kept across a change of size', () => {
	it('survives while it is still open for the new size', () => {
		expect(keepOpenTime(1200, [slot(1170), slot(1200), slot(1230)])).toBe(1200)
	})
	it('is cleared when the new size has no room at that time', () => {
		expect(keepOpenTime(1200, [slot(1170), slot(1200, false)])).toBeNull()
		expect(keepOpenTime(1200, [slot(1170)])).toBeNull()
		expect(keepOpenTime(1200, [])).toBeNull()
	})
	it('has nothing to keep when no time was chosen', () => {
		expect(keepOpenTime(null, [slot(1200)])).toBeNull()
	})
	it('tells slots apart by their minute, so after midnight is not midnight', () => {
		expect(keepOpenTime(30, [slot(1470)])).toBeNull()
		expect(keepOpenTime(1470, [slot(1470)])).toBe(1470)
	})
})

describe('the days one tap away', () => {
	it('count on over a month and a year', () => {
		expect(addDays('2026-01-30', 3)).toBe('2026-02-02')
		expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
		expect(addDays('2026-03-02', -2)).toBe('2026-02-28')
	})
	it('start with today and tomorrow, then the days after', () => {
		const chips = dayChips('2026-03-02')
		expect(chips).toHaveLength(7)
		expect(chips[0]).toEqual({ date: '2026-03-02', kind: 'today' })
		expect(chips[1]).toEqual({ date: '2026-03-03', kind: 'tomorrow' })
		expect(chips[6]).toEqual({ date: '2026-03-08', kind: 'day' })
	})
})

describe('quick notes', () => {
	it('are added after what is there, and taken back on a second tap', () => {
		let notes = ''
		notes = toggleNote(notes, 'High chair')
		expect(notes).toBe('High chair')
		notes = toggleNote(notes, 'Window')
		expect(notes).toBe('High chair, Window')
		expect(hasNote(notes, 'window')).toBe(true)
		notes = toggleNote(notes, 'High chair')
		expect(notes).toBe('Window')
		expect(hasNote(notes, 'High chair')).toBe(false)
	})
	it('keep what the host typed', () => {
		expect(toggleNote('Allergic to figs; wants the corner', 'Quiet')).toBe(
			'Allergic to figs, wants the corner, Quiet',
		)
		// A phrase inside a longer sentence is not "already there".
		expect(hasNote('Birthday cake please', 'Birthday')).toBe(false)
	})
	it('never grow past the field’s limit', () => {
		const full = 'x'.repeat(498)
		expect(toggleNote(full, 'Quiet', 500)).toBe(full)
	})
})

describe('why the Book button is off', () => {
	it('names the first thing in the way', () => {
		expect(bookingBlocker({ time: null, first: '', phoneProblem: false })).toBe(
			'time',
		)
		expect(
			bookingBlocker({ time: 1200, first: '  ', phoneProblem: false }),
		).toBe('first')
		expect(
			bookingBlocker({ time: 1200, first: 'Omar', phoneProblem: true }),
		).toBe('phone')
		expect(
			bookingBlocker({ time: 1200, first: 'Omar', phoneProblem: false }),
		).toBeNull()
	})
})

describe('a form worth asking about before it closes', () => {
	it('is any typed text in a booking', () => {
		const empty = { first: '', last: '', phone: '', notes: '' }
		expect(bookingDirty(empty)).toBe(false)
		expect(bookingDirty({ ...empty, first: ' ' })).toBe(false)
		expect(bookingDirty({ ...empty, notes: 'Quiet' })).toBe(true)
		expect(bookingDirty({ ...empty, phone: '+1' })).toBe(true)
	})
	it('is not what the form was started with, only a change from it', () => {
		const started = {
			first: 'Rana',
			last: 'Khalid',
			phone: '+1 415',
			notes: '',
		}
		expect(bookingDirty(started, started)).toBe(false)
		expect(bookingDirty({ ...started, notes: 'Quiet' }, started)).toBe(true)
		expect(bookingDirty({ ...started, first: '' }, started)).toBe(true)
	})
	it('is a name or another party size in a walk-in or a waitlist entry', () => {
		expect(walkInDirty({ name: '', size: 2 })).toBe(false)
		expect(walkInDirty({ name: '', size: 4 })).toBe(true)
		expect(walkInDirty({ name: 'Sam', size: 2 })).toBe(true)
		expect(waitlistDirty({ name: '', phone: '', size: 2 })).toBe(false)
		expect(waitlistDirty({ name: '', phone: '555', size: 2 })).toBe(true)
		expect(waitlistDirty({ name: '', phone: '', size: 6 })).toBe(true)
		// A name searched for and carried over is not typed work.
		const started = { name: 'Zzz', phone: '' }
		expect(waitlistDirty({ name: 'Zzz', phone: '', size: 2 }, started)).toBe(
			false,
		)
		expect(waitlistDirty({ name: 'Zzz', phone: '555', size: 2 }, started)).toBe(
			true,
		)
	})
})
