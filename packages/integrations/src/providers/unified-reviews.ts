import { z } from 'zod'
import {
	listGoogleBusinessReviews,
	replyToGoogleBusinessReview,
} from './google-business-profile/service'
import { listYelpReviews, replyToYelpReview } from './yelp/service'
import {
	listTripAdvisorReviews,
	replyToTripAdvisorReview,
} from './tripadvisor/service'
import {
	listDeliverooReviews,
	replyToDeliverooReview,
} from './deliveroo/service'
import { listJustEatReviews, replyToJustEatReview } from './just-eat/service'
import {
	listOpenTableReviews,
	replyToOpenTableReview,
} from './opentable/service'
import { listResyReviews, replyToResyReview } from './resy/service'
import { type ReviewProviderName } from '../integration-scope'

export const starRatingEnum = z.enum(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'])
export type StarRating = z.infer<typeof starRatingEnum>

export function numberToStarRating(
	rating?: number | null,
): StarRating | undefined {
	if (typeof rating !== 'number' || isNaN(rating)) return undefined
	const rounded = Math.max(1, Math.min(5, Math.round(rating)))
	const map: Record<number, StarRating> = {
		1: 'ONE',
		2: 'TWO',
		3: 'THREE',
		4: 'FOUR',
		5: 'FIVE',
	}
	return map[rounded]
}

export function safeIsoDate(val?: string | null): string | undefined {
	if (!val) return undefined
	try {
		const d = new Date(val)
		if (isNaN(d.getTime())) return undefined
		return d.toISOString()
	} catch {
		return undefined
	}
}

export const unifiedReviewSchema = z.object({
	name: z.string(),
	provider: z.enum([
		'google-business-profile',
		'yelp',
		'tripadvisor',
		'deliveroo',
		'just-eat',
		'opentable',
		'resy',
	]),
	providerDisplayName: z.string(),
	reviewer: z
		.object({
			displayName: z.string().optional(),
			profilePhotoUrl: z.string().optional(),
			isAnonymous: z.boolean().optional(),
		})
		.optional(),
	starRating: starRatingEnum.optional(),
	comment: z.string().optional(),
	createTime: z.string().optional(),
	updateTime: z.string().optional(),
	reviewReply: z
		.object({ comment: z.string(), updateTime: z.string().optional() })
		.optional(),
	locationId: z.string(),
	locationName: z.string(),
	externalUrl: z.string().optional(),
})

export type UnifiedReview = z.infer<typeof unifiedReviewSchema>
export type UnifiedReviewPageTokens = Record<string, string | null>

export interface ReviewProviderDisplayInfo {
	name: ReviewProviderName
	displayName: string
	description: string
	logoPath: string
	icon: string
	managementUrlLabel?: string
}

export function getAvailableReviewProviders(): ReviewProviderDisplayInfo[] {
	return [
		{
			name: 'google-business-profile',
			displayName: 'Google Business Profile',
			description:
				'Import restaurant details and manage Google customer reviews',
			logoPath: '/icons/google.svg',
			icon: 'google',
			managementUrlLabel: 'Google Business Profile',
		},
		{
			name: 'yelp',
			displayName: 'Yelp',
			description:
				'Connect your Yelp listing to monitor ratings and customer reviews',
			logoPath: '/icons/yelp.svg',
			icon: 'yelp',
			managementUrlLabel: 'Yelp for Business',
		},
		{
			name: 'tripadvisor',
			displayName: 'TripAdvisor',
			description:
				'Track traveler ratings, reviews, and replies on TripAdvisor',
			logoPath: '/icons/tripadvisor.svg',
			icon: 'tripadvisor',
			managementUrlLabel: 'TripAdvisor Management Center',
		},
		{
			name: 'deliveroo',
			displayName: 'Deliveroo',
			description: 'Monitor customer feedback, ratings, and order reviews',
			logoPath: '/icons/deliveroo.svg',
			icon: 'deliveroo',
			managementUrlLabel: 'Deliveroo Hub',
		},
		{
			name: 'just-eat',
			displayName: 'Just Eat',
			description: 'Track diner ratings, food feedback, and takeaway reviews',
			logoPath: '/icons/just-eat.svg',
			icon: 'just-eat',
			managementUrlLabel: 'Just Eat Partner Hub',
		},
		{
			name: 'opentable',
			displayName: 'OpenTable',
			description:
				'Manage verified diner reviews and dining experience feedback',
			logoPath: '/icons/opentable.svg',
			icon: 'opentable',
			managementUrlLabel: 'OpenTable for Restaurants',
		},
		{
			name: 'resy',
			displayName: 'Resy',
			description: 'Manage Resy guest reviews and post-visit dining feedback',
			logoPath: '/icons/resy.svg',
			icon: 'resy',
			managementUrlLabel: 'Resy OS',
		},
	]
}

export async function listUnifiedReviews(
	organizationId: string,
	pageTokens: UnifiedReviewPageTokens = {},
	providerFilter?: string,
) {
	const extractTokensForProvider = (providerPrefix: string) => {
		const result: Record<string, string | null> = {}
		for (const [key, val] of Object.entries(pageTokens)) {
			if (key.startsWith(`${providerPrefix}:`)) {
				result[key.slice(providerPrefix.length + 1)] = val
			} else if (!key.includes(':')) {
				result[key] = val
			}
		}
		return result
	}

	const prefixTokens = (
		providerPrefix: string,
		tokens: Record<string, string | null>,
	) => {
		const result: Record<string, string | null> = {}
		for (const [locId, token] of Object.entries(tokens)) {
			result[`${providerPrefix}:${locId}`] = token
		}
		return result
	}

	const shouldFetch = (providerName: string) =>
		!providerFilter ||
		providerFilter === 'all' ||
		providerFilter === providerName

	const [
		googleResult,
		yelpResult,
		taResult,
		delResult,
		jetResult,
		otResult,
		resyResult,
	] = await Promise.all([
		shouldFetch('google-business-profile')
			? listGoogleBusinessReviews(
					organizationId,
					extractTokensForProvider('google-business-profile'),
				).catch(() => ({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}))
			: Promise.resolve({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}),
		shouldFetch('yelp')
			? listYelpReviews(organizationId, extractTokensForProvider('yelp')).catch(
					() => ({
						reviews: [],
						totalReviewCount: 0,
						nextPageTokens: {},
					}),
				)
			: Promise.resolve({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}),
		shouldFetch('tripadvisor')
			? listTripAdvisorReviews(
					organizationId,
					extractTokensForProvider('tripadvisor'),
				).catch(() => ({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}))
			: Promise.resolve({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}),
		shouldFetch('deliveroo')
			? listDeliverooReviews(
					organizationId,
					extractTokensForProvider('deliveroo'),
				).catch(() => ({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}))
			: Promise.resolve({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}),
		shouldFetch('just-eat')
			? listJustEatReviews(
					organizationId,
					extractTokensForProvider('just-eat'),
				).catch(() => ({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}))
			: Promise.resolve({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}),
		shouldFetch('opentable')
			? listOpenTableReviews(
					organizationId,
					extractTokensForProvider('opentable'),
				).catch(() => ({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}))
			: Promise.resolve({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}),
		shouldFetch('resy')
			? listResyReviews(organizationId, extractTokensForProvider('resy')).catch(
					() => ({
						reviews: [],
						totalReviewCount: 0,
						nextPageTokens: {},
					}),
				)
			: Promise.resolve({
					reviews: [],
					totalReviewCount: 0,
					nextPageTokens: {},
				}),
	])

	const normalizedReviews: UnifiedReview[] = [
		...googleResult.reviews.map((r) => ({
			name: r.name,
			provider: 'google-business-profile' as const,
			providerDisplayName: 'Google',
			reviewer: r.reviewer,
			starRating: r.starRating,
			comment: r.comment,
			createTime: r.createTime,
			updateTime: r.updateTime,
			reviewReply: r.reviewReply,
			locationId: r.locationId,
			locationName: r.locationName,
		})),
		...yelpResult.reviews.map((r) => ({
			name: r.id,
			provider: 'yelp' as const,
			providerDisplayName: 'Yelp',
			reviewer: {
				displayName: r.user?.name,
				profilePhotoUrl: r.user?.image_url,
			},
			starRating: numberToStarRating(r.rating),
			comment: r.text,
			createTime: safeIsoDate(r.time_created),
			updateTime: safeIsoDate(r.time_created),
			reviewReply: r.reviewReply,
			locationId: r.locationId,
			locationName: r.locationName,
			externalUrl: r.url,
		})),
		...taResult.reviews.map((r) => ({
			name: r.id,
			provider: 'tripadvisor' as const,
			providerDisplayName: 'TripAdvisor',
			reviewer: {
				displayName: r.user?.username,
				profilePhotoUrl: r.user?.avatar?.small,
			},
			starRating: numberToStarRating(r.rating),
			comment: [r.title, r.text].filter(Boolean).join('\n\n'),
			createTime: safeIsoDate(r.published_date),
			updateTime: safeIsoDate(r.published_date),
			reviewReply: r.reviewReply,
			locationId: r.locationId,
			locationName: r.locationName,
			externalUrl: r.url,
		})),
		...delResult.reviews.map((r) => ({
			name: r.id,
			provider: 'deliveroo' as const,
			providerDisplayName: 'Deliveroo',
			reviewer: {
				displayName: r.customer_name || 'Deliveroo customer',
			},
			starRating: numberToStarRating(r.rating),
			comment: r.comment,
			createTime: safeIsoDate(r.submitted_at),
			updateTime: safeIsoDate(r.submitted_at),
			reviewReply: r.reviewReply,
			locationId: r.locationId,
			locationName: r.locationName,
		})),
		...jetResult.reviews.map((r) => ({
			name: r.id,
			provider: 'just-eat' as const,
			providerDisplayName: 'Just Eat',
			reviewer: {
				displayName: r.author || 'Just Eat diner',
			},
			starRating: numberToStarRating(r.overallRating),
			comment: r.comments,
			createTime: safeIsoDate(r.createdAt),
			updateTime: safeIsoDate(r.createdAt),
			reviewReply: r.reviewReply,
			locationId: r.locationId,
			locationName: r.locationName,
		})),
		...otResult.reviews.map((r) => ({
			name: r.id,
			provider: 'opentable' as const,
			providerDisplayName: 'OpenTable',
			reviewer: {
				displayName: r.diner_display_name || 'OpenTable diner',
			},
			starRating: numberToStarRating(r.overall_rating),
			comment: r.comments,
			createTime: safeIsoDate(r.submitted_date) || safeIsoDate(r.visited_date),
			updateTime: safeIsoDate(r.submitted_date),
			reviewReply: r.reviewReply,
			locationId: r.locationId,
			locationName: r.locationName,
		})),
		...resyResult.reviews.map((r) => ({
			name: r.id,
			provider: 'resy' as const,
			providerDisplayName: 'Resy',
			reviewer: {
				displayName: r.guest_name || 'Resy guest',
			},
			starRating: numberToStarRating(r.rating),
			comment: r.comment,
			createTime: safeIsoDate(r.created_at) || safeIsoDate(r.visit_date),
			updateTime: safeIsoDate(r.created_at),
			reviewReply: r.reviewReply,
			locationId: r.locationId,
			locationName: r.locationName,
		})),
	]

	normalizedReviews.sort((a, b) => {
		const timeA = new Date(b.updateTime ?? b.createTime ?? 0).getTime()
		const timeB = new Date(a.updateTime ?? a.createTime ?? 0).getTime()
		return timeA - timeB
	})

	const totalReviewCount =
		googleResult.totalReviewCount +
		yelpResult.totalReviewCount +
		taResult.totalReviewCount +
		delResult.totalReviewCount +
		jetResult.totalReviewCount +
		otResult.totalReviewCount +
		resyResult.totalReviewCount

	const nextPageTokens: UnifiedReviewPageTokens = {
		...prefixTokens('google-business-profile', googleResult.nextPageTokens),
		...prefixTokens('yelp', yelpResult.nextPageTokens),
		...prefixTokens('tripadvisor', taResult.nextPageTokens),
		...prefixTokens('deliveroo', delResult.nextPageTokens),
		...prefixTokens('just-eat', jetResult.nextPageTokens),
		...prefixTokens('opentable', otResult.nextPageTokens),
		...prefixTokens('resy', resyResult.nextPageTokens),
	}

	return {
		reviews: normalizedReviews,
		totalReviewCount,
		nextPageTokens,
	}
}

export async function replyToUnifiedReview(
	organizationId: string,
	locationId: string,
	provider: string,
	reviewName: string,
	comment: string,
) {
	switch (provider) {
		case 'google-business-profile':
			return replyToGoogleBusinessReview(
				organizationId,
				locationId,
				reviewName,
				comment,
			)
		case 'yelp':
			return replyToYelpReview(organizationId, locationId, reviewName, comment)
		case 'tripadvisor':
			return replyToTripAdvisorReview(
				organizationId,
				locationId,
				reviewName,
				comment,
			)
		case 'deliveroo':
			return replyToDeliverooReview(
				organizationId,
				locationId,
				reviewName,
				comment,
			)
		case 'just-eat':
			return replyToJustEatReview(
				organizationId,
				locationId,
				reviewName,
				comment,
			)
		case 'opentable':
			return replyToOpenTableReview(
				organizationId,
				locationId,
				reviewName,
				comment,
			)
		case 'resy':
			return replyToResyReview(organizationId, locationId, reviewName, comment)
		default:
			throw new Error(`Unsupported review provider: ${provider}`)
	}
}
