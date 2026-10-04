import { type LocationAddress } from '@repo/common/location-types'
import {
	and,
	db,
	eq,
	OrganizationLocation,
	Integration as IntegrationTable,
} from '@repo/database'
import { z } from 'zod'
import {
	findScopedIntegration,
	resolveOrganizationLocationIdForConnect,
} from '../../location-integrations.ts'
import { tokenManager } from '../../token-manager'
import { JustEatProvider, isJustEatMockMode } from './provider'

const justEatLocationSchema = z
	.object({
		id: z.string(),
		name: z.string().min(1),
		url: z.string().optional(),
		phone: z.string().optional(),
		address: z
			.object({
				line1: z.string().optional(),
				line2: z.string().optional(),
				postalCode: z.string().optional(),
				city: z.string().optional(),
			})
			.optional(),
		ratingStars: z.number().optional(),
		numberOfRatings: z.number().optional(),
	})
	.passthrough()

export type JustEatLocation = z.infer<typeof justEatLocationSchema>

export const justEatReviewSchema = z
	.object({
		id: z.string(),
		overallRating: z.number().min(1).max(5),
		foodRating: z.number().optional(),
		deliveryRating: z.number().optional(),
		comments: z.string().optional(),
		createdAt: z.string().optional(),
		author: z.string().optional(),
		reviewReply: z
			.object({ comment: z.string(), updateTime: z.string().optional() })
			.optional(),
	})
	.passthrough()

export type JustEatReview = z.infer<typeof justEatReviewSchema> & {
	locationId: string
	locationName: string
}

export type JustEatReviewPageTokens = Record<string, string | null>

const MOCK_JUST_EAT_LOCATIONS: JustEatLocation[] = [
	{
		id: 'mock-menuza-just-eat-takeaway-1',
		name: 'Menuza Demo Bistro - Takeaway',
		url: 'https://www.just-eat.co.uk/restaurants-menuza-demo-bistro-london',
		phone: '+44 20 7946 0122',
		address: {
			line1: '123 Demo Street',
			city: 'London',
			postalCode: 'EC1A 1BB',
		},
		ratingStars: 4.8,
		numberOfRatings: 220,
	},
]

const MOCK_JUST_EAT_REVIEWS: z.infer<typeof justEatReviewSchema>[] = [
	{
		id: 'jet-review-1',
		overallRating: 5,
		foodRating: 5,
		deliveryRating: 5,
		comments:
			'Best takeaway in the area! The pasta arrived fresh, hot, and full of flavor.',
		createdAt: '2026-02-15T19:40:00Z',
		author: 'Emily Watson',
	},
	{
		id: 'jet-review-2',
		overallRating: 4,
		foodRating: 5,
		deliveryRating: 4,
		comments:
			'Super tasty garlic bread and pizza. Delivery took about 5 minutes longer than estimated, but worth it.',
		createdAt: '2026-02-03T18:25:00Z',
		author: 'Nathan Green',
	},
	{
		id: 'jet-review-3',
		overallRating: 3,
		foodRating: 4,
		deliveryRating: 3,
		comments:
			'Food was delicious, but the drink was missing from our order. Customer support resolved promptly.',
		createdAt: '2026-01-19T20:15:00Z',
		author: 'Chloe Bennett',
	},
]

function parseIntegrationConfig(rawConfig: string | null | undefined) {
	try {
		return z
			.record(z.unknown())
			.catch({})
			.parse(JSON.parse(rawConfig ?? '{}'))
	} catch {
		return {}
	}
}

async function getConnection(
	organizationId: string,
	organizationLocationId: string,
) {
	const integration = await findScopedIntegration(
		organizationId,
		'just-eat',
		organizationLocationId,
	)
	if (!integration?.isActive) {
		throw new Error('Just Eat is not connected for this restaurant location.')
	}
	const token = isJustEatMockMode()
		? 'mock-just-eat-access-token'
		: await tokenManager.getValidAccessToken(integration, new JustEatProvider())
	if (!token) {
		throw new Error('Reconnect Just Eat to continue')
	}
	return { integration, token }
}

export async function listJustEatLocations(
	organizationId: string,
	locationId: string,
): Promise<JustEatLocation[]> {
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (isJustEatMockMode()) return MOCK_JUST_EAT_LOCATIONS
	const config = parseIntegrationConfig(integration.config)
	if (config.location) {
		const parsed = justEatLocationSchema.safeParse(config.location)
		if (parsed.success) return [parsed.data]
	}
	return []
}

export async function importJustEatLocation(
	organizationId: string,
	restaurantId: string,
	scopedLocationId?: string,
) {
	const locationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'just-eat',
		scopedLocationId,
	)
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (!isJustEatMockMode()) {
		throw new Error('Just Eat live listing import is not supported yet.')
	}
	const location = MOCK_JUST_EAT_LOCATIONS.find(
		(candidate) => candidate.id === restaurantId,
	)
	if (!location) throw new Error('Just Eat restaurant listing was not found.')
	const config = parseIntegrationConfig(integration.config)

	const street = [location.address?.line1, location.address?.line2]
		.filter(Boolean)
		.join(', ')
	const formattedAddress = [
		street,
		location.address?.city,
		location.address?.postalCode,
		'UK',
	]
		.filter(Boolean)
		.join(', ')

	const importedAddress: LocationAddress = {
		formattedAddress,
		city: location.address?.city || '',
		state: '',
		postalCode: location.address?.postalCode || '',
		country: 'UK',
		lat: 0,
		lng: 0,
	}

	await db
		.update(OrganizationLocation)
		.set({
			name: location.name,
			address: JSON.stringify(importedAddress),
			phone: location.phone || null,
		})
		.where(
			and(
				eq(OrganizationLocation.id, locationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)

	await db
		.update(IntegrationTable)
		.set({
			config: JSON.stringify({
				...config,
				restaurantId: location.id,
				restaurantName: location.name,
				restaurantUrl: location.url,
				hubUrl: 'https://partner.just-eat.co.uk',
				location,
			}),
		})
		.where(eq(IntegrationTable.id, integration.id))

	return location
}

export async function listJustEatReviews(
	organizationId: string,
	pageTokens: JustEatReviewPageTokens = {},
) {
	if (!isJustEatMockMode()) {
		return { reviews: [], totalReviewCount: 0, nextPageTokens: {} }
	}
	const connectedLocations = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
		})
		.from(OrganizationLocation)
		.innerJoin(
			IntegrationTable,
			and(
				eq(IntegrationTable.organizationLocationId, OrganizationLocation.id),
				eq(IntegrationTable.organizationId, organizationId),
				eq(IntegrationTable.providerName, 'just-eat'),
				eq(IntegrationTable.isActive, true),
			),
		)
		.where(eq(OrganizationLocation.organizationId, organizationId))

	if (connectedLocations.length === 0) {
		return {
			reviews: [],
			totalReviewCount: 0,
			nextPageTokens: {} as JustEatReviewPageTokens,
		}
	}

	const pages = await Promise.all(
		connectedLocations.map(async (location) => {
			if (pageTokens[location.id] === null) {
				return { reviews: [], total: 0, next: null as string | null }
			}
			const { integration } = await getConnection(organizationId, location.id)
			const config = parseIntegrationConfig(integration.config)
			const storedReplies = z
				.record(
					z.object({
						comment: z.string(),
						updateTime: z.string().optional(),
					}),
				)
				.catch({})
				.parse(config.mockReviewReplies)

			const allReviews = MOCK_JUST_EAT_REVIEWS.map((review) => ({
				...review,
				...(storedReplies[review.id]
					? { reviewReply: storedReplies[review.id] }
					: {}),
				locationId: location.id,
				locationName: location.name,
			}))
			const offset = Math.max(0, Number(pageTokens[location.id] ?? 0) || 0)
			const reviews = allReviews.slice(offset, offset + 50)
			const next =
				offset + reviews.length < allReviews.length
					? String(offset + reviews.length)
					: null
			return { reviews, total: allReviews.length, next }
		}),
	)

	const reviews = pages
		.flatMap((page) => page.reviews)
		.sort(
			(a, b) =>
				new Date(b.createdAt ?? 0).getTime() -
				new Date(a.createdAt ?? 0).getTime(),
		)

	const nextPageTokens = Object.fromEntries(
		connectedLocations.map((location, index) => [
			location.id,
			pages[index]?.next ?? null,
		]),
	)

	return {
		reviews,
		totalReviewCount: pages.reduce((sum, page) => sum + page.total, 0),
		nextPageTokens,
	}
}

export async function replyToJustEatReview(
	organizationId: string,
	locationId: string,
	reviewId: string,
	comment: string,
) {
	const parsedComment = z.string().trim().min(1).max(4096).parse(comment)
	const { integration } = await getConnection(organizationId, locationId)
	const rawConfig = parseIntegrationConfig(integration.config)
	const parsedReplies = z
		.record(
			z.object({ comment: z.string(), updateTime: z.string().optional() }),
		)
		.catch({})
		.parse(rawConfig.mockReviewReplies)
	const reply = {
		comment: parsedComment,
		updateTime: new Date().toISOString(),
	}

	await db
		.update(IntegrationTable)
		.set({
			config: JSON.stringify({
				...rawConfig,
				mockReviewReplies: { ...parsedReplies, [reviewId]: reply },
			}),
		})
		.where(eq(IntegrationTable.id, integration.id))

	return reply
}
