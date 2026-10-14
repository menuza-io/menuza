import { describe, expect, it } from 'vitest'
import { type ApplicantSummary } from './applicant-types.ts'
import {
	applicantName,
	bySoonestInterview,
	daysUntil,
	groupByStage,
	interviewFields,
	interviewInstant,
	isOpenStage,
	placeLabel,
	scoreBand,
} from './applicant-view.ts'

function person(overrides: Partial<ApplicantSummary> = {}): ApplicantSummary {
	return {
		id: 'a',
		postingId: 'p',
		postingTitle: 'Line cook',
		scopeId: 'main',
		firstName: 'Sara',
		lastName: 'Ali',
		source: 'careers_page',
		stage: 'new',
		stageChangedAt: 0,
		screenerScore: null,
		flagCount: 0,
		hasEmail: true,
		hasPhone: false,
		interviewAt: null,
		noteCount: 0,
		hiredStaffId: null,
		createdAt: 0,
		...overrides,
	}
}

describe('applicantName', () => {
	it('joins the names and tolerates an empty last name', () => {
		expect(applicantName(person())).toBe('Sara Ali')
		expect(applicantName(person({ lastName: '' }))).toBe('Sara')
	})
})

describe('groupByStage', () => {
	it('puts open applicants in their column and leaves closed ones out', () => {
		const groups = groupByStage([
			person({ id: '1', stage: 'new' }),
			person({ id: '2', stage: 'interview' }),
			person({ id: '3', stage: 'hired' }),
			person({ id: '4', stage: 'declined' }),
			person({ id: '5', stage: 'new' }),
		])
		expect(groups.new.map((a) => a.id)).toEqual(['1', '5'])
		expect(groups.interview.map((a) => a.id)).toEqual(['2'])
		expect(groups.screening).toEqual([])
		expect(groups.offer).toEqual([])
		expect(isOpenStage('hired')).toBe(false)
		expect(isOpenStage('offer')).toBe(true)
	})
})

describe('scoreBand', () => {
	it('names the band without making a decision', () => {
		expect(scoreBand(null)).toBe('none')
		expect(scoreBand(100)).toBe('strong')
		expect(scoreBand(80)).toBe('strong')
		expect(scoreBand(79)).toBe('mixed')
		expect(scoreBand(50)).toBe('mixed')
		expect(scoreBand(49)).toBe('low')
		expect(scoreBand(0)).toBe('low')
	})
})

describe('daysUntil', () => {
	it('rounds up and never goes negative', () => {
		expect(daysUntil(null, 0)).toBeNull()
		expect(daysUntil(86_400_000 + 1, 0)).toBe(2)
		expect(daysUntil(-5, 0)).toBe(0)
	})
})

describe('interview time', () => {
	it('reads the typed time in the workplace zone, not the browser zone', () => {
		// 09:30 in Chicago on 2026-10-16 (CDT, UTC-5) is 14:30 UTC.
		expect(interviewInstant('2026-10-16', '09:30', 'America/Chicago')).toBe(
			Date.UTC(2026, 9, 16, 14, 30),
		)
		expect(interviewInstant('2026-10-16', '09:30', 'Asia/Riyadh')).toBe(
			Date.UTC(2026, 9, 16, 6, 30),
		)
	})

	it('round-trips through the fields, across a daylight saving change', () => {
		for (const [date, time] of [
			['2026-03-08', '03:15'],
			['2026-11-01', '12:00'],
			['2026-10-16', '23:59'],
		] as const) {
			const instant = interviewInstant(date, time, 'America/Chicago')!
			expect(interviewFields(instant, 'America/Chicago')).toEqual({
				date,
				time,
			})
		}
	})

	it('refuses nonsense', () => {
		for (const [date, time] of [
			['', '09:00'],
			['2026-10-16', ''],
			['2026-13-01', '09:00'],
			['2026-10-32', '09:00'],
			['2026-10-16', '25:00'],
			['2026-10-16', '09:60'],
			['16/10/2026', '09:00'],
		]) {
			expect(interviewInstant(date!, time!, 'UTC')).toBeNull()
		}
	})
})

describe('bySoonestInterview', () => {
	it('sorts by time with unscheduled last, without mutating', () => {
		const input = [
			person({ id: 'none' }),
			person({ id: 'later', interviewAt: 200 }),
			person({ id: 'soon', interviewAt: 100 }),
		]
		expect(bySoonestInterview(input).map((a) => a.id)).toEqual([
			'soon',
			'later',
			'none',
		])
		expect(input[0]!.id).toBe('none')
	})
})

describe('placeLabel', () => {
	const names: Record<string, string> = {
		a: 'Main office',
		b: 'Annex',
		c: 'Mall',
	}
	const nameOf = (id: string | null) => (id ? (names[id] ?? null) : null)

	it('names the scope the applicant belongs to', () => {
		expect(placeLabel({ scopeId: 'a' }, nameOf)).toBe('Main office')
		expect(placeLabel({ scopeId: null }, nameOf)).toBeNull()
	})
})
