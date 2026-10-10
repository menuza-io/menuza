import { type UnifiedReview } from '@repo/integrations'
import { describe, expect, it, vi } from 'vitest'
import {
	type ListReviews,
	loadReviewRecords,
	mapReview,
} from './review-records.server.ts'

function review(overrides: Partial<UnifiedReview> = {}): UnifiedReview {
	return {
		name: 'review_1',
		provider: 'google-business-profile',
		providerDisplayName: 'Google',
		locationId: 'loc_1',
		locationName: 'Downtown',
		starRating: 'FIVE',
		createTime: '2026-03-01T10:00:00.000Z',
		...overrides,
	}
}

function day(date: number) {
	return `2026-03-${String(date).padStart(2, '0')}T12:00:00.000Z`
}

describe('mapReview', () => {
	it('maps a review to report fields', () => {
		expect(
			mapReview(
				review({
					starRating: 'FOUR',
					reviewer: { displayName: 'Ada' },
					reviewReply: { comment: 'Thanks for visiting!' },
				}),
			),
		).toEqual({
			createdAt: '2026-03-01T10:00:00.000Z',
			rating: '4',
			stars: 4,
			provider: 'google-business-profile',
			location: 'Downtown',
			replied: true,
			reviewer: 'Ada',
		})
	})

	it('handles unrated, anonymous, and undated reviews', () => {
		expect(
			mapReview(
				review({
					starRating: undefined,
					reviewer: { displayName: 'Hidden', isAnonymous: true },
					reviewReply: { comment: '' },
					createTime: undefined,
					updateTime: '2026-03-02T00:00:00.000Z',
				}),
			),
		).toMatchObject({
			createdAt: '2026-03-02T00:00:00.000Z',
			rating: 'none',
			stars: null,
			replied: false,
			reviewer: '',
		})
		expect(mapReview(review({ createTime: undefined })).createdAt).toBeNull()
	})
})

describe('loadReviewRecords', () => {
	it('pages through every review site, newest first, without repeats', async () => {
		const listReviews = vi.fn<ListReviews>(
			async (_organizationId, _tokens, provider): ReturnType<ListReviews> => {
				if (!provider) {
					return {
						reviews: [
							review({ name: 'g1', createTime: day(1) }),
							review({ name: 'y1', provider: 'yelp', createTime: day(3) }),
						],
						nextPageTokens: {
							'google-business-profile:loc_1': 'g-page-2',
							'yelp:loc_1': 'y-page-2',
							'tripadvisor:loc_1': null,
						},
					}
				}
				if (provider === 'yelp') {
					return {
						// Offset paging repeats a review when a new one arrives.
						reviews: [
							review({ name: 'y1', provider: 'yelp', createTime: day(3) }),
							review({ name: 'y2', provider: 'yelp', createTime: day(2) }),
						],
						nextPageTokens: { 'yelp:loc_1': null },
					}
				}
				return {
					reviews: [review({ name: 'g2', createTime: day(4) })],
					nextPageTokens: {},
				}
			},
		)

		const { records, truncated } = await loadReviewRecords('org_1', {
			listReviews,
		})

		expect(listReviews).toHaveBeenCalledTimes(3)
		expect(listReviews).toHaveBeenNthCalledWith(1, 'org_1', {})
		expect(listReviews).toHaveBeenCalledWith(
			'org_1',
			{ 'google-business-profile:loc_1': 'g-page-2' },
			'google-business-profile',
		)
		expect(listReviews).toHaveBeenCalledWith(
			'org_1',
			{ 'yelp:loc_1': 'y-page-2' },
			'yelp',
		)
		expect(truncated).toBe(false)
		expect(
			records.map((record) => [record.provider, record.createdAt]),
		).toEqual([
			['google-business-profile', day(4)],
			['yelp', day(3)],
			['yelp', day(2)],
			['google-business-profile', day(1)],
		])
	})

	it('returns nothing when no review site is connected', async () => {
		const listReviews = vi.fn<ListReviews>(async () => ({
			reviews: [],
			nextPageTokens: {},
		}))
		await expect(loadReviewRecords('org_1', { listReviews })).resolves.toEqual({
			records: [],
			truncated: false,
		})
		expect(listReviews).toHaveBeenCalledTimes(1)
	})

	it('stops after the page limit and reports the cut', async () => {
		let page = 0
		const listReviews = vi.fn<ListReviews>(async () => {
			page += 1
			return {
				reviews: [review({ name: `g${page}`, createTime: day(page) })],
				nextPageTokens: {
					'google-business-profile:loc_1': `g-page-${page + 1}`,
				},
			}
		})

		const { records, truncated } = await loadReviewRecords('org_1', {
			listReviews,
			maxPages: 3,
		})

		expect(listReviews).toHaveBeenCalledTimes(3)
		expect(records).toHaveLength(3)
		expect(truncated).toBe(true)
	})

	it('keeps the newest reviews at the row limit', async () => {
		const listReviews = vi.fn<ListReviews>(async () => ({
			reviews: [1, 2, 3].map((date) =>
				review({ name: `g${date}`, createTime: day(date) }),
			),
			nextPageTokens: { 'google-business-profile:loc_1': 'g-page-2' },
		}))

		const { records, truncated } = await loadReviewRecords('org_1', {
			listReviews,
			maxRows: 2,
		})

		expect(listReviews).toHaveBeenCalledTimes(1)
		expect(records.map((record) => record.createdAt)).toEqual([day(3), day(2)])
		expect(truncated).toBe(true)
	})
})
