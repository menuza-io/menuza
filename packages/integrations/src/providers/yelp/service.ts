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
import { YelpProvider, isYelpMockMode } from './provider'

const yelpLocationSchema = z
	.object({
		id: z.string(),
		name: z.string().min(1),
		phone: z.string().optional(),
		display_phone: z.string().optional(),
		location: z
			.object({
				address1: z.string().optional(),
				address2: z.string().optional(),
				city: z.string().optional(),
				state: z.string().optional(),
				zip_code: z.string().optional(),
				country: z.string().optional(),
				display_address: z.array(z.string()).optional(),
			})
			.optional(),
		url: z.string().optional(),
		rating: z.number().optional(),
		review_count: z.number().optional(),
	})
	.passthrough()

export type YelpBusinessLocation = z.infer<typeof yelpLocationSchema>

export const yelpReviewSchema = z
	.object({
		id: z.string(),
		url: z.string().optional(),
		text: z.string().optional(),
		rating: z.number().min(1).max(5),
		time_created: z.string().optional(),
		user: z
			.object({
				id: z.string().optional(),
				profile_url: z.string().optional(),
				image_url: z.string().optional(),
				name: z.string().optional(),
			})
			.optional(),
		reviewReply: z
			.object({ comment: z.string(), updateTime: z.string().optional() })
			.optional(),
	})
	.passthrough()

export type YelpReview = z.infer<typeof yelpReviewSchema> & {
	locationId: string
	locationName: string
}

export type YelpReviewPageTokens = Record<string, string | null>

const MOCK_YELP_LOCATIONS: YelpBusinessLocation[] = [
	{
		id: 'mock-menuza-downtown-yelp',
		name: 'Menuza Demo Bistro',
		phone: '+15550100',
		display_phone: '(555) 555-0100',
		location: {
			address1: '123 Demo Street',
			city: 'Chicago',
			state: 'IL',
			zip_code: '60601',
			country: 'US',
			display_address: ['123 Demo Street', 'Chicago, IL 60601'],
		},
		url: 'https://www.yelp.com/biz/menuza-demo-bistro-chicago',
		rating: 4.5,
		review_count: 148,
	},
]

const MOCK_YELP_REVIEWS: z.infer<typeof yelpReviewSchema>[] = [
	{
		id: 'yelp-review-1',
		text: 'Outstanding flavors and very attentive staff. The signature burger is a must try!',
		rating: 5,
		time_created: '2026-02-14T19:30:00.000Z',
		url: 'https://www.yelp.com/biz/menuza-demo-bistro-chicago#hrid:yelp-review-1',
		user: {
			name: 'Samantha Ray',
			image_url:
				'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100',
		},
	},
	{
		id: 'yelp-review-2',
		text: 'Great outdoor patio ambiance. Cocktails were top tier, appetizers arrived promptly.',
		rating: 4,
		time_created: '2026-02-01T20:15:00.000Z',
		url: 'https://www.yelp.com/biz/menuza-demo-bistro-chicago#hrid:yelp-review-2',
		user: {
			name: 'Marcus Vance',
			image_url:
				'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100',
		},
	},
	{
		id: 'yelp-review-3',
		text: 'Food was delicious but it was very crowded on a Saturday night. Make reservations in advance.',
		rating: 3,
		time_created: '2026-01-18T18:45:00.000Z',
		url: 'https://www.yelp.com/biz/menuza-demo-bistro-chicago#hrid:yelp-review-3',
		user: {
			name: 'Devon Patel',
		},
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
		'yelp',
		organizationLocationId,
	)
	if (!integration?.isActive) {
		throw new Error('Yelp is not connected for this restaurant location.')
	}
	const token = isYelpMockMode()
		? 'mock-yelp-access-token'
		: await tokenManager.getValidAccessToken(integration, new YelpProvider())
	if (!token) {
		throw new Error('Reconnect Yelp to continue')
	}
	return { integration, token }
}

async function yelpGet<T>(
	url: URL,
	token: string,
	schema: z.ZodType<T>,
): Promise<T> {
	const response = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
		},
		signal: AbortSignal.timeout(15000),
	})
	if (!response.ok) {
		throw new Error(`Yelp request failed (${response.status})`)
	}
	return schema.parse(await response.json())
}

export async function listYelpLocations(
	organizationId: string,
	locationId: string,
): Promise<YelpBusinessLocation[]> {
	if (!locationId) {
		throw new Error('A restaurant location is required.')
	}
	const { token, integration } = await getConnection(organizationId, locationId)
	if (isYelpMockMode()) return MOCK_YELP_LOCATIONS
	const config = parseIntegrationConfig(integration.config)
	const businessId =
		typeof config.businessId === 'string' ? config.businessId : ''
	if (businessId) {
		const url = new URL(
			`https://api.yelp.com/v3/businesses/${encodeURIComponent(businessId)}`,
		)
		const business = await yelpGet(url, token, yelpLocationSchema)
		return [business]
	}
	return []
}

export async function importYelpLocation(
	organizationId: string,
	businessId: string,
	scopedLocationId?: string,
) {
	const locationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'yelp',
		scopedLocationId,
	)
	if (!locationId) {
		throw new Error('A restaurant location is required.')
	}
	const { integration, token } = await getConnection(organizationId, locationId)
	const location = isYelpMockMode()
		? MOCK_YELP_LOCATIONS.find((candidate) => candidate.id === businessId)
		: await (async () => {
				const url = new URL(
					`https://api.yelp.com/v3/businesses/${encodeURIComponent(businessId)}`,
				)
				return yelpGet(url, token, yelpLocationSchema)
			})()
	if (!location) throw new Error('Yelp business listing was not found.')
	const config = parseIntegrationConfig(integration.config)

	const street = [location.location?.address1, location.location?.address2]
		.filter(Boolean)
		.join(', ')
	const formattedAddress =
		location.location?.display_address?.join(', ') ||
		[
			street,
			location.location?.city,
			location.location?.state,
			location.location?.zip_code,
			location.location?.country,
		]
			.filter(Boolean)
			.join(', ')

	const importedAddress: LocationAddress = {
		formattedAddress,
		city: location.location?.city || '',
		state: location.location?.state || '',
		postalCode: location.location?.zip_code || '',
		country: location.location?.country || '',
		lat: 0,
		lng: 0,
	}

	await db
		.update(OrganizationLocation)
		.set({
			name: location.name,
			address: JSON.stringify(importedAddress),
			phone: location.phone || location.display_phone || null,
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
				businessId: location.id,
				businessName: location.name,
				businessUrl: location.url,
				business: location,
			}),
		})
		.where(eq(IntegrationTable.id, integration.id))

	return location
}

export async function listYelpReviews(
	organizationId: string,
	pageTokens: YelpReviewPageTokens = {},
) {
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
				eq(IntegrationTable.providerName, 'yelp'),
				eq(IntegrationTable.isActive, true),
			),
		)
		.where(eq(OrganizationLocation.organizationId, organizationId))

	if (connectedLocations.length === 0) {
		return {
			reviews: [],
			totalReviewCount: 0,
			nextPageTokens: {} as YelpReviewPageTokens,
		}
	}

	const pages = await Promise.all(
		connectedLocations.map(async (location) => {
			if (pageTokens[location.id] === null) {
				return { reviews: [], total: 0, next: null as string | null }
			}
			const { integration, token } = await getConnection(
				organizationId,
				location.id,
			)
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

			if (isYelpMockMode()) {
				const allReviews = MOCK_YELP_REVIEWS.map((review) => ({
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
			}

			const businessId = (config.businessId as string) || location.id
			const url = new URL(
				`https://api.yelp.com/v3/businesses/${encodeURIComponent(businessId)}/reviews`,
			)
			const result = await yelpGet(
				url,
				token,
				z.object({
					reviews: z.array(yelpReviewSchema).optional(),
					total: z.number().optional(),
				}),
			)
			const reviews = (result.reviews ?? []).map((review) => ({
				...review,
				...(storedReplies[review.id]
					? { reviewReply: storedReplies[review.id] }
					: {}),
				locationId: location.id,
				locationName: location.name,
			}))
			return {
				reviews,
				total: result.total ?? reviews.length,
				next: null,
			}
		}),
	)

	const reviews = pages
		.flatMap((page) => page.reviews)
		.sort(
			(a, b) =>
				new Date(b.time_created ?? 0).getTime() -
				new Date(a.time_created ?? 0).getTime(),
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

export async function replyToYelpReview(
	organizationId: string,
	locationId: string,
	reviewId: string,
	comment: string,
) {
	const parsedComment = z.string().trim().min(1).max(4096).parse(comment)
	const { integration, token } = await getConnection(organizationId, locationId)
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

	if (isYelpMockMode()) {
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

	const businessId =
		typeof rawConfig.businessId === 'string' ? rawConfig.businessId : ''
	if (!businessId) {
		throw new Error(
			'Please import a Yelp listing for this location before replying.',
		)
	}
	const response = await fetch(
		`https://api.yelp.com/v3/businesses/${encodeURIComponent(businessId)}/reviews/${encodeURIComponent(reviewId)}/responses`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ text: parsedComment }),
			signal: AbortSignal.timeout(15000),
		},
	)
	if (!response.ok) {
		throw new Error(
			`Yelp could not save the reply (status ${response.status}).`,
		)
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
