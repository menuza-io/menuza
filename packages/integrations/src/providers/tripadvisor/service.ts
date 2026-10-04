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
import { TripAdvisorProvider, isTripAdvisorMockMode } from './provider'

const tripAdvisorLocationSchema = z
	.object({
		location_id: z.string(),
		name: z.string().min(1),
		web_url: z.string().optional(),
		address_obj: z
			.object({
				street1: z.string().optional(),
				street2: z.string().optional(),
				city: z.string().optional(),
				state: z.string().optional(),
				country: z.string().optional(),
				postalcode: z.string().optional(),
				address_string: z.string().optional(),
			})
			.optional(),
		rating: z.string().optional(),
		num_reviews: z.string().optional(),
		phone: z.string().optional(),
	})
	.passthrough()

export type TripAdvisorLocation = z.infer<typeof tripAdvisorLocationSchema>

export const tripAdvisorReviewSchema = z
	.object({
		id: z
			.number()
			.or(z.string())
			.transform((val) => String(val)),
		lang: z.string().optional(),
		location_id: z.string().optional(),
		published_date: z.string().optional(),
		rating: z.number().min(1).max(5),
		helpful_votes: z.number().optional(),
		rating_image_url: z.string().optional(),
		url: z.string().optional(),
		text: z.string().optional(),
		title: z.string().optional(),
		user: z
			.object({
				username: z.string().optional(),
				user_location: z.object({ name: z.string().optional() }).optional(),
				avatar: z.object({ small: z.string().optional() }).optional(),
			})
			.optional(),
		owner_response: z
			.object({
				id: z.number().or(z.string()).optional(),
				title: z.string().optional(),
				text: z.string(),
				published_date: z.string().optional(),
			})
			.optional(),
		reviewReply: z
			.object({ comment: z.string(), updateTime: z.string().optional() })
			.optional(),
	})
	.passthrough()

export type TripAdvisorReview = z.infer<typeof tripAdvisorReviewSchema> & {
	locationId: string
	locationName: string
}

export type TripAdvisorReviewPageTokens = Record<string, string | null>

const MOCK_TRIPADVISOR_LOCATIONS: TripAdvisorLocation[] = [
	{
		location_id: 'mock-menuza-tripadvisor-101',
		name: 'Menuza Demo Bistro',
		web_url:
			'https://www.tripadvisor.com/Restaurant_Review-g35805-d10101-Menuza_Demo_Bistro-Chicago_Illinois.html',
		address_obj: {
			street1: '123 Demo Street',
			city: 'Chicago',
			state: 'Illinois',
			country: 'United States',
			postalcode: '60601',
			address_string: '123 Demo Street, Chicago, IL 60601',
		},
		rating: '4.5',
		num_reviews: '312',
		phone: '+1 555-0100',
	},
]

const MOCK_TRIPADVISOR_REVIEWS: z.infer<typeof tripAdvisorReviewSchema>[] = [
	{
		id: 'ta-review-1',
		title: 'Unforgettable culinary experience in downtown Chicago',
		text: 'From the warm greeting at the door to the dessert course, everything exceeded expectations. The grilled sea bass was exquisite.',
		rating: 5,
		published_date: '2026-02-18T14:20:00Z',
		url: 'https://www.tripadvisor.com/ShowUserReviews-g35805-d10101-r1',
		user: {
			username: 'ClaireTravelsWorld',
			user_location: { name: 'London, UK' },
		},
	},
	{
		id: 'ta-review-2',
		title: 'Fantastic brunch spot with charming ambiance',
		text: 'Enjoyed a leisurely Sunday brunch with family. Great coffee, fresh ingredients, and attentive waitstaff.',
		rating: 4,
		published_date: '2026-02-05T11:45:00Z',
		url: 'https://www.tripadvisor.com/ShowUserReviews-g35805-d10101-r2',
		user: {
			username: 'DavidGastronome',
			user_location: { name: 'Toronto, Canada' },
		},
	},
	{
		id: 'ta-review-3',
		title: 'Good dishes but long wait without reservation',
		text: 'Food quality was undeniable, but the wait time was close to 45 minutes on Friday evening. Definitely recommend booking a table.',
		rating: 3,
		published_date: '2026-01-22T19:10:00Z',
		url: 'https://www.tripadvisor.com/ShowUserReviews-g35805-d10101-r3',
		user: {
			username: 'ElenaChicagoan',
			user_location: { name: 'Chicago, IL' },
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
		'tripadvisor',
		organizationLocationId,
	)
	if (!integration?.isActive) {
		throw new Error(
			'TripAdvisor is not connected for this restaurant location.',
		)
	}
	const token = isTripAdvisorMockMode()
		? 'mock-tripadvisor-access-token'
		: await tokenManager.getValidAccessToken(
				integration,
				new TripAdvisorProvider(),
			)
	if (!token) {
		throw new Error('Reconnect TripAdvisor to continue')
	}
	return { integration, token }
}

export async function listTripAdvisorLocations(
	organizationId: string,
	locationId: string,
): Promise<TripAdvisorLocation[]> {
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (isTripAdvisorMockMode()) return MOCK_TRIPADVISOR_LOCATIONS
	const config = parseIntegrationConfig(integration.config)
	if (config.location) {
		const parsed = tripAdvisorLocationSchema.safeParse(config.location)
		if (parsed.success) return [parsed.data]
	}
	return []
}

export async function importTripAdvisorLocation(
	organizationId: string,
	tripAdvisorLocationId: string,
	scopedLocationId?: string,
) {
	const locationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'tripadvisor',
		scopedLocationId,
	)
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (!isTripAdvisorMockMode()) {
		throw new Error('TripAdvisor live listing import is not supported yet.')
	}
	const location =
		MOCK_TRIPADVISOR_LOCATIONS.find(
			(candidate) => candidate.location_id === tripAdvisorLocationId,
		) ?? MOCK_TRIPADVISOR_LOCATIONS[0]
	if (!location) throw new Error('TripAdvisor location listing was not found.')
	const config = parseIntegrationConfig(integration.config)

	const street = [location.address_obj?.street1, location.address_obj?.street2]
		.filter(Boolean)
		.join(', ')
	const formattedAddress =
		location.address_obj?.address_string ||
		[
			street,
			location.address_obj?.city,
			location.address_obj?.state,
			location.address_obj?.postalcode,
			location.address_obj?.country,
		]
			.filter(Boolean)
			.join(', ')

	const importedAddress: LocationAddress = {
		formattedAddress,
		city: location.address_obj?.city || '',
		state: location.address_obj?.state || '',
		postalCode: location.address_obj?.postalcode || '',
		country: location.address_obj?.country || '',
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
				locationId: location.location_id,
				locationName: location.name,
				webUrl: location.web_url,
				managementUrl: 'https://www.tripadvisor.com/Owners',
				location,
			}),
		})
		.where(eq(IntegrationTable.id, integration.id))

	return location
}

export async function listTripAdvisorReviews(
	organizationId: string,
	pageTokens: TripAdvisorReviewPageTokens = {},
) {
	if (!isTripAdvisorMockMode()) {
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
				eq(IntegrationTable.providerName, 'tripadvisor'),
				eq(IntegrationTable.isActive, true),
			),
		)
		.where(eq(OrganizationLocation.organizationId, organizationId))

	if (connectedLocations.length === 0) {
		return {
			reviews: [],
			totalReviewCount: 0,
			nextPageTokens: {} as TripAdvisorReviewPageTokens,
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

			const allReviews = MOCK_TRIPADVISOR_REVIEWS.map((review) => {
				const reply =
					storedReplies[review.id] ??
					(review.owner_response
						? {
								comment: review.owner_response.text,
								updateTime: review.owner_response.published_date,
							}
						: undefined)
				return {
					...review,
					...(reply ? { reviewReply: reply } : {}),
					locationId: location.id,
					locationName: location.name,
				}
			})
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
				new Date(b.published_date ?? 0).getTime() -
				new Date(a.published_date ?? 0).getTime(),
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

export async function replyToTripAdvisorReview(
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
