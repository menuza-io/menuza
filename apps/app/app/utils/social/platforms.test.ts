import { describe, expect, it } from 'vitest'
import {
	countHashtags,
	settledPostStatus,
	socialPostProblems,
} from './platforms.ts'
import { SocialPostFormSchema } from './post-schema.ts'
import {
	dayKey,
	fromLocalInputValue,
	monthGrid,
	shiftMonth,
	toLocalInputValue,
} from './time.ts'

describe('socialPostProblems', () => {
	it('lets Facebook post text alone but asks Instagram for an image', () => {
		expect(
			socialPostProblems({
				body: 'Open late tonight',
				mediaCount: 0,
				platforms: ['facebook', 'instagram'],
			}),
		).toEqual([{ platform: 'instagram', problem: 'needs_media' }])
	})

	it('applies the Instagram caption and hashtag limits', () => {
		const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ')
		expect(countHashtags(tags)).toBe(31)
		expect(
			socialPostProblems({
				body: `${'a'.repeat(2_200)} ${tags}`,
				mediaCount: 1,
				platforms: ['instagram'],
			}).map((p) => p.problem),
		).toEqual(['too_long', 'too_many_hashtags'])
	})

	it('refuses an empty post', () => {
		expect(
			socialPostProblems({
				body: '  ',
				mediaCount: 0,
				platforms: ['facebook'],
			}),
		).toEqual([{ platform: 'facebook', problem: 'empty' }])
	})
})

describe('settledPostStatus', () => {
	it('summarizes the targets', () => {
		expect(settledPostStatus([{ status: 'published' }])).toBe('published')
		expect(
			settledPostStatus([{ status: 'published' }, { status: 'failed' }]),
		).toBe('partial')
		expect(settledPostStatus([{ status: 'failed' }])).toBe('failed')
	})
})

describe('time helpers', () => {
	it('round-trips a wall-clock time across a daylight-saving change', () => {
		// New York springs forward on 2026-03-08.
		const at = fromLocalInputValue('2026-03-09T09:00', 'America/New_York')
		expect(at.toISOString()).toBe('2026-03-09T13:00:00.000Z')
		expect(toLocalInputValue(at, 'America/New_York')).toBe('2026-03-09T09:00')
		const before = fromLocalInputValue('2026-03-07T09:00', 'America/New_York')
		expect(before.toISOString()).toBe('2026-03-07T14:00:00.000Z')
	})

	it('rejects impossible calendar dates', () => {
		expect(
			Number.isNaN(fromLocalInputValue('2026-02-30T09:00', 'UTC').getTime()),
		).toBe(true)
	})

	it('groups by the day in the member’s time zone', () => {
		const at = new Date('2026-10-01T02:00:00Z')
		expect(dayKey(at, 'UTC')).toBe('2026-10-01')
		expect(dayKey(at, 'America/Los_Angeles')).toBe('2026-09-30')
		expect(dayKey(at, 'Asia/Riyadh')).toBe('2026-10-01')
	})

	it('builds a six-week grid starting on Sunday', () => {
		const grid = monthGrid('2026-10')
		expect(grid).toHaveLength(42)
		expect(grid[0]).toBe('2026-09-27')
		expect(grid).toContain('2026-10-31')
		expect(shiftMonth('2026-12', 1)).toBe('2027-01')
		expect(shiftMonth('2026-01', -1)).toBe('2025-12')
	})
})

describe('SocialPostFormSchema', () => {
	const base = { body: 'Hi', accountIds: ['a'], timeZone: 'UTC' }

	it('needs an account to schedule or publish, not to save a draft', () => {
		expect(
			SocialPostFormSchema.safeParse({ intent: 'draft', body: 'Hi' }).success,
		).toBe(true)
		const result = SocialPostFormSchema.safeParse({
			intent: 'publish',
			body: 'Hi',
		})
		expect(result.success).toBe(false)
		expect(result.error?.issues[0]?.message).toBe('accounts_required')
	})

	it('needs a time at least a minute ahead to schedule', () => {
		const soon = toLocalInputValue(new Date(Date.now() + 10_000), 'UTC')
		const later = toLocalInputValue(new Date(Date.now() + 3_600_000), 'UTC')
		const missing = SocialPostFormSchema.safeParse({
			...base,
			intent: 'schedule',
		})
		expect(missing.error?.issues[0]?.message).toBe('schedule_required')
		const tooSoon = SocialPostFormSchema.safeParse({
			...base,
			intent: 'schedule',
			scheduledAt: soon,
		})
		expect(tooSoon.error?.issues[0]?.message).toBe('schedule_future')
		expect(
			SocialPostFormSchema.safeParse({
				...base,
				intent: 'schedule',
				scheduledAt: later,
			}).success,
		).toBe(true)
	})

	it('refuses an unknown time zone', () => {
		expect(
			SocialPostFormSchema.safeParse({
				...base,
				intent: 'draft',
				timeZone: 'Mars/Olympus',
			}).success,
		).toBe(false)
	})
})
