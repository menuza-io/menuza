import { describe, expect, it } from 'vitest'
import {
	checkUseDraft,
	nextBudgetReset,
	parseRestyleCategoryIds,
	restyleBudgetLeft,
	restyleDraftIsExpired,
	restyleRunStatusFrom,
	RESTYLE_DAILY_BUDGET,
	RESTYLE_DRAFT_TTL_DAYS,
} from './media-restyle.ts'

describe('checkUseDraft', () => {
	const base = {
		currentMainKey: 'orgs/o/media/images/a.jpg',
		sourceKey: 'orgs/o/media/images/a.jpg',
		draftKey: 'orgs/o/media/images/draft.jpg',
		draftKeyAtReview: 'orgs/o/media/images/draft.jpg',
		decision: null,
		draftStatus: 'draft',
	}
	it('allows a draft while the main photo is still its source', () => {
		expect(checkUseDraft(base)).toEqual({ ok: true })
	})
	it('refuses with photo_changed when the dish photo changed meanwhile', () => {
		expect(
			checkUseDraft({ ...base, currentMainKey: 'orgs/o/media/images/new.jpg' }),
		).toEqual({ ok: false, error: 'photo_changed' })
		expect(checkUseDraft({ ...base, currentMainKey: null })).toEqual({
			ok: false,
			error: 'photo_changed',
		})
	})
	it('refuses a draft that changed or is gone', () => {
		expect(checkUseDraft({ ...base, draftKeyAtReview: 'other.jpg' })).toEqual({
			ok: false,
			error: 'draft_changed',
		})
		expect(checkUseDraft({ ...base, draftStatus: 'ready' })).toEqual({
			ok: false,
			error: 'draft_changed',
		})
		expect(checkUseDraft({ ...base, draftKey: null })).toEqual({
			ok: false,
			error: 'draft_missing',
		})
	})
	it('refuses an item that was already decided', () => {
		expect(checkUseDraft({ ...base, decision: 'used' })).toEqual({
			ok: false,
			error: 'already_decided',
		})
	})
})

describe('budget and expiry', () => {
	it('counts the budget down and never below zero', () => {
		expect(restyleBudgetLeft(0)).toBe(RESTYLE_DAILY_BUDGET)
		expect(restyleBudgetLeft(RESTYLE_DAILY_BUDGET + 10)).toBe(0)
	})
	it('pauses at the budget and finishes when nothing is pending', () => {
		expect(restyleRunStatusFrom({ pending: 3, budgetLeft: 0 })).toBe('paused')
		expect(restyleRunStatusFrom({ pending: 3, budgetLeft: 5 })).toBe('running')
		expect(restyleRunStatusFrom({ pending: 0, budgetLeft: 0 })).toBe('ready')
		expect(
			restyleRunStatusFrom({ pending: 3, budgetLeft: 5, cancelled: true }),
		).toBe('cancelled')
	})
	it('resumes at the next UTC midnight', () => {
		expect(
			nextBudgetReset(new Date('2026-03-04T23:30:00Z')).toISOString(),
		).toBe('2026-03-05T00:00:00.000Z')
	})
	it('deletes drafts after 30 days', () => {
		const created = new Date('2026-01-01T00:00:00Z')
		const day = 86_400_000
		expect(
			restyleDraftIsExpired(
				created,
				new Date(created.getTime() + (RESTYLE_DRAFT_TTL_DAYS - 1) * day),
			),
		).toBe(false)
		expect(
			restyleDraftIsExpired(
				created,
				new Date(created.getTime() + RESTYLE_DRAFT_TTL_DAYS * day),
			),
		).toBe(true)
	})
	it('reads category ids safely', () => {
		expect(parseRestyleCategoryIds('["a","b",3]')).toEqual(['a', 'b'])
		expect(parseRestyleCategoryIds('{')).toEqual([])
		expect(parseRestyleCategoryIds(null)).toEqual([])
	})
})
