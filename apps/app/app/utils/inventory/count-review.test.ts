import {
	approveCountResultSchema,
	approveCountSchema,
	type CountReview,
	countReviewSchema,
} from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	approveBlockedReason,
	buildApprovePayload,
	canApproveCount,
	countActions,
	differenceDirection,
	finishLabelKind,
	groupReviewLines,
	summarizeFoodCost,
	uncountedChoice,
} from './count-review.ts'

const COUNT = {
	id: 'cnt_1',
	locationId: 'main',
	listId: null,
	listName: null,
	status: 'in_review' as const,
	businessDate: '2026-11-08',
	startedBy: { kind: 'operator' as const, id: 'u1' },
	itemTotal: 5,
	itemsCounted: 4,
	counters: [],
	sentForReviewAt: 10,
	approvedAt: null,
	approvedBy: null,
	cancelledAt: null,
	createdAt: 1,
	version: 4,
}

function line(
	itemId: string,
	flag: 'not_counted' | 'big_difference',
	overrides: Partial<CountReview['lines'][number]> = {},
): CountReview['lines'][number] {
	return {
		itemId,
		name: `Item ${itemId}`,
		baseUnit: 'g',
		countUnit: 'kg',
		units: [],
		counted: flag === 'not_counted' ? null : 46_000,
		expected: 49_000,
		difference: flag === 'not_counted' ? null : -3_000,
		flag,
		...overrides,
	}
}

const REVIEW: CountReview = {
	count: COUNT,
	lines: [
		line('i1', 'big_difference', { differenceValueMinor: -8_400 }),
		line('i2', 'not_counted'),
		line('i3', 'big_difference', { difference: 4_000, counted: 53_000 }),
		line('i4', 'not_counted'),
	],
	matching: 41,
	notCounted: 2,
	differenceValueMinor: -8_400,
	currency: 'SAR',
}

describe('groupReviewLines', () => {
	it('splits not counted from big differences, keeping the region order', () => {
		const grouped = groupReviewLines(REVIEW)
		expect(grouped.notCounted.map((item) => item.itemId)).toEqual(['i2', 'i4'])
		expect(grouped.bigDifferences.map((item) => item.itemId)).toEqual([
			'i1',
			'i3',
		])
		expect(grouped.matching).toBe(41)
	})

	it('is empty when everything matches', () => {
		const grouped = groupReviewLines({ ...REVIEW, lines: [], matching: 48 })
		expect(grouped.notCounted).toEqual([])
		expect(grouped.bigDifferences).toEqual([])
		expect(grouped.matching).toBe(48)
	})

	it('reads the answer the region sends (money left out without the cost grant)', () => {
		const parsed = countReviewSchema.parse({
			count: COUNT,
			lines: [line('i1', 'big_difference')],
			matching: 3,
			notCounted: 0,
		})
		expect(parsed.differenceValueMinor).toBeUndefined()
		expect(groupReviewLines(parsed).bigDifferences).toHaveLength(1)
	})
})

describe('differenceDirection', () => {
	it('says missing, extra or none', () => {
		expect(differenceDirection({ difference: -3_000 })).toBe('missing')
		expect(differenceDirection({ difference: 1 })).toBe('extra')
		expect(differenceDirection({ difference: 0 })).toBe('none')
		expect(differenceDirection({ difference: null })).toBe('none')
	})
})

describe('buildApprovePayload', () => {
	it('keeps what was expected for items nobody counted unless told otherwise', () => {
		const payload = buildApprovePayload(REVIEW, {
			uncounted: { i4: 'zero' },
			notes: {},
		})
		expect(payload.uncounted).toEqual({ i2: 'keep', i4: 'zero' })
		expect(uncountedChoice({ uncounted: {} }, 'i2')).toBe('keep')
	})

	it('sends the version it reviewed, so a changed count is refused (409)', () => {
		expect(
			buildApprovePayload(REVIEW, { uncounted: {}, notes: {} }).expectedVersion,
		).toBe(4)
	})

	it('sends notes only for reviewed differences, trimmed and not empty', () => {
		const payload = buildApprovePayload(REVIEW, {
			uncounted: {},
			notes: {
				i1: '  Spilled a box  ',
				i3: '   ',
				// A note for an item that is not under review is dropped.
				i2: 'ignored',
				unknown: 'ignored',
			},
		})
		expect(payload.notes).toEqual({ i1: 'Spilled a box' })
	})

	it('builds a body the region accepts', () => {
		const payload = buildApprovePayload(REVIEW, {
			uncounted: { i2: 'zero' },
			notes: { i1: 'Spilled' },
		})
		expect(approveCountSchema.safeParse(payload).success).toBe(true)
	})
})

describe('who may do what', () => {
	const manager = { canEdit: true, canSeeCost: true }
	const kitchen = { canEdit: true, canSeeCost: false }
	const reader = { canEdit: false, canSeeCost: false }
	const accountant = { canEdit: false, canSeeCost: true }

	it('approving needs update and the cost grant, never one alone', () => {
		expect(canApproveCount(manager)).toBe(true)
		expect(canApproveCount(kitchen)).toBe(false)
		expect(canApproveCount(accountant)).toBe(false)
		expect(canApproveCount(reader)).toBe(false)
	})

	it('hides Approve without the cost grant and offers Send for approval instead', () => {
		expect(countActions('in_review', kitchen)).not.toContain('approve')
		expect(finishLabelKind(kitchen)).toBe('send')
		expect(finishLabelKind(manager)).toBe('review')
		expect(countActions('in_review', manager)).toContain('approve')
	})

	it('a reader only reviews', () => {
		expect(countActions('counting', reader)).toEqual(['review'])
		expect(countActions('in_review', reader)).toEqual(['review'])
	})

	it('counting people count, finish and may cancel', () => {
		expect(countActions('counting', kitchen)).toEqual([
			'count',
			'finish',
			'cancel',
			'review',
		])
	})

	it('a closed count offers nothing', () => {
		expect(countActions('approved', manager)).toEqual([])
		expect(countActions('cancelled', manager)).toEqual([])
	})

	it('a sent count can be reopened by whoever may edit', () => {
		expect(countActions('in_review', kitchen)).toEqual([
			'review',
			'reopen',
			'cancel',
		])
	})

	it('explains why Approve is blocked', () => {
		const ok = { access: manager, status: 'in_review' as const, saving: false }
		expect(approveBlockedReason(ok)).toBeNull()
		expect(approveBlockedReason({ ...ok, access: kitchen })).toBe('permission')
		expect(approveBlockedReason({ ...ok, status: 'counting' })).toBe('state')
		expect(approveBlockedReason({ ...ok, saving: true })).toBe('saving')
	})
})

describe('summarizeFoodCost', () => {
	const base = {
		from: '2026-11-01',
		to: '2026-11-08',
		targetBp: 3000,
	}

	it('shows the percentage and whether it is over target', () => {
		expect(summarizeFoodCost({ ...base, state: 'ok', bp: 3120 })).toEqual({
			kind: 'ready',
			bp: 3120,
			targetBp: 3000,
			overTarget: true,
		})
		expect(summarizeFoodCost({ ...base, state: 'ok', bp: 2800 })).toMatchObject(
			{ overTarget: false },
		)
	})

	it('explains the two states with no figure yet', () => {
		expect(summarizeFoodCost({ ...base, state: 'need_two_counts' })).toEqual({
			kind: 'need_two_counts',
		})
		expect(summarizeFoodCost({ ...base, state: 'no_sales' })).toEqual({
			kind: 'no_sales',
		})
		expect(summarizeFoodCost(undefined)).toBeNull()
	})

	it('reads an approve answer with food cost', () => {
		const result = approveCountResultSchema.parse({
			count: { ...COUNT, status: 'approved', approvedAt: 5, version: 5 },
			adjustedItems: 3,
			differenceValueMinor: -8_400,
			currency: 'SAR',
			foodCost: { ...base, state: 'ok', bp: 3120 },
		})
		expect(summarizeFoodCost(result.foodCost)).toMatchObject({ kind: 'ready' })
	})
})
