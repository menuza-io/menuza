import { cachified, lruCache } from '@repo/cache'
import {
	listUnifiedReviews,
	REVIEW_PROVIDER_NAMES,
	type UnifiedReview,
	type UnifiedReviewPageTokens,
} from '@repo/integrations'
import { type ReportRecord } from '@repo/reports'

/** Rounds of pages a report reads from each review site. */
export const REVIEW_REPORT_MAX_PAGES = 10

/** Most reviews a report reads; like the order cap, it only bounds memory. */
export const REVIEW_REPORT_MAX_ROWS = 2_000

// The builder reruns a report on every change, and each run would otherwise
// page through every connected review site again.
const REVIEW_REPORT_CACHE_TTL_MS = 5 * 60_000

const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 } as const

type ReviewPage = {
	reviews: UnifiedReview[]
	nextPageTokens: UnifiedReviewPageTokens
}

export type ListReviews = (
	organizationId: string,
	pageTokens: UnifiedReviewPageTokens,
	provider?: string,
) => Promise<ReviewPage>

export type LoadedReviewRecords = {
	records: ReportRecord[]
	/** Some sites still had pages left when the report stopped reading. */
	truncated: boolean
}

export function mapReview(review: UnifiedReview): ReportRecord {
	const stars = review.starRating ? STARS[review.starRating] : null
	return {
		createdAt: review.createTime ?? review.updateTime ?? null,
		rating: stars ? String(stars) : 'none',
		stars,
		provider: review.provider,
		location: review.locationName,
		replied: Boolean(review.reviewReply?.comment),
		reviewer: review.reviewer?.isAnonymous
			? ''
			: (review.reviewer?.displayName ?? ''),
	}
}

/** Page tokens use `<provider>:<location>` keys; keeps one provider's. */
function providerTokens(
	tokens: UnifiedReviewPageTokens,
	provider: string,
): UnifiedReviewPageTokens {
	const prefix = `${provider}:`
	return Object.fromEntries(
		Object.entries(tokens).filter(([key]) => key.startsWith(prefix)),
	)
}

function hasNextPage(tokens: UnifiedReviewPageTokens) {
	return Object.values(tokens).some(Boolean)
}

function reviewTime(record: ReportRecord) {
	const time =
		typeof record.createdAt === 'string' ? Date.parse(record.createdAt) : NaN
	return Number.isNaN(time) ? 0 : time
}

/**
 * Reads reviews from every connected review site. The first round asks every
 * site at once; later rounds follow only the sites with pages left, until
 * they run out, `maxPages` rounds pass, or `maxRows` reviews have loaded.
 */
export async function loadReviewRecords(
	organizationId: string,
	options: {
		listReviews?: ListReviews
		maxPages?: number
		maxRows?: number
	} = {},
): Promise<LoadedReviewRecords> {
	const listReviews = options.listReviews ?? listUnifiedReviews
	const maxPages = options.maxPages ?? REVIEW_REPORT_MAX_PAGES
	const maxRows = options.maxRows ?? REVIEW_REPORT_MAX_ROWS

	const seen = new Set<string>()
	const reviews: UnifiedReview[] = []
	function collect(page: ReviewPage) {
		for (const review of page.reviews) {
			// Offset-paged sites repeat a review when a new one arrives between
			// two page reads.
			const key = `${review.provider}:${review.locationId}:${review.name}`
			if (seen.has(key)) continue
			seen.add(key)
			reviews.push(review)
		}
	}

	const first = await listReviews(organizationId, {})
	collect(first)
	let pending = REVIEW_PROVIDER_NAMES.map((provider) => ({
		provider,
		tokens: providerTokens(first.nextPageTokens, provider),
	})).filter((entry) => hasNextPage(entry.tokens))

	for (
		let round = 1;
		round < maxPages && pending.length > 0 && reviews.length < maxRows;
		round += 1
	) {
		const pages = await Promise.all(
			pending.map((entry) =>
				listReviews(organizationId, entry.tokens, entry.provider),
			),
		)
		pending = pending.flatMap((entry, index) => {
			const page = pages[index]
			if (!page) return []
			collect(page)
			const tokens = providerTokens(page.nextPageTokens, entry.provider)
			return hasNextPage(tokens) ? [{ provider: entry.provider, tokens }] : []
		})
	}

	const records = reviews
		.map(mapReview)
		.sort((left, right) => reviewTime(right) - reviewTime(left))
	return {
		records: records.slice(0, maxRows),
		truncated: pending.length > 0 || records.length > maxRows,
	}
}

/** {@link loadReviewRecords}, kept in memory for a few minutes per org. */
export function loadCachedReviewRecords(organizationId: string) {
	return cachified({
		key: `report-reviews:${organizationId}`,
		cache: lruCache,
		ttl: REVIEW_REPORT_CACHE_TTL_MS,
		getFreshValue: () => loadReviewRecords(organizationId),
	})
}
