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
import { ResyProvider, isResyMockMode } from './provider'

const resyVenueSchema = z
	.object({
		venue_id: z
			.number()
			.or(z.string())
			.transform((val) => String(val)),
		name: z.string().min(1),
		url: z.string().optional(),
		phone_number: z.string().optional(),
		location: z
			.object({
				address_1: z.string().optional(),
				address_2: z.string().optional(),
				locality: z.string().optional(),
				region: z.string().optional(),
				postal_code: z.string().optional(),
				country: z.string().optional(),
			})
			.optional(),
		rating: z.number().optional(),
		review_count: z.number().optional(),
	})
	.passthrough()

export type ResyVenue = z.infer<typeof resyVenueSchema>

export const resyReviewSchema = z
	.object({
		id: z.string(),
		guest_name: z.string().optional(),
		rating: z.number().min(1).max(5),
		food_rating: z.number().optional(),
		service_rating: z.number().optional(),
		drinks_rating: z.number().optional(),
		comment: z.string().optional(),
		visit_date: z.string().optional(),
		created_at: z.string().optional(),
		reviewReply: z
			.object({ comment: z.string(), updateTime: z.string().optional() })
			.optional(),
	})
	.passthrough()

export type ResyReview = z.infer<typeof resyReviewSchema> & {
	locationId: string
	locationName: string
}

export type ResyReviewPageTokens = Record<string, string | null>

const MOCK_RESY_VENUES: ResyVenue[] = [
	{
		venue_id: 'mock-menuza-resy-venue-2048',
		name: 'Menuza Demo Bistro',
		url: 'https://resy.com/cities/ny/menuza-demo-bistro',
		phone_number: '+1 (555) 555-0123',
		location: {
			address_1: '45 Mock Avenue',
			locality: 'New York',
			region: 'NY',
			postal_code: '10013',
			country: 'US',
		},
		rating: 4.7,
		review_count: 312,
	},
]

const MOCK_RESY_REVIEWS: z.infer<typeof resyReviewSchema>[] = [
	{
		id: 'resy-review-1',
		guest_name: 'Priya S.',
		rating: 5,
		food_rating: 5,
		service_rating: 5,
		drinks_rating: 4,
		comment:
			'Booked the chef counter for a birthday and every course landed. The team remembered our allergies without being reminded.',
		visit_date: '2026-02-20',
		created_at: '2026-02-21T09:45:00Z',
	},
	{
		id: 'resy-review-2',
		guest_name: 'Marcus L.',
		rating: 4,
		food_rating: 4,
		service_rating: 5,
		drinks_rating: 4,
		comment:
			'Great cocktails and a warm welcome. Our table was ready right on time for an 8pm reservation.',
		visit_date: '2026-02-10',
		created_at: '2026-02-11T16:20:00Z',
	},
	{
		id: 'resy-review-3',
		guest_name: 'Resy guest',
		rating: 2,
		food_rating: 3,
		service_rating: 2,
		drinks_rating: 3,
		comment:
			'We waited 25 minutes past our reservation time before being seated, and nobody checked in on us.',
		visit_date: '2026-01-28',
		created_at: '2026-01-29T12:05:00Z',
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
		'resy',
		organizationLocationId,
	)
	if (!integration?.isActive) {
		throw new Error('Resy is not connected for this restaurant location.')
	}
	const token = isResyMockMode()
		? 'mock-resy-access-token'
		: await tokenManager.getValidAccessToken(integration, new ResyProvider())
	if (!token) {
		throw new Error('Reconnect Resy to continue')
	}
	return { integration, token }
}

export async function listResyVenues(
	organizationId: string,
	locationId: string,
): Promise<ResyVenue[]> {
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (isResyMockMode()) return MOCK_RESY_VENUES
	const config = parseIntegrationConfig(integration.config)
	if (config.venue) {
		const parsed = resyVenueSchema.safeParse(config.venue)
		if (parsed.success) return [parsed.data]
	}
	return []
}

export async function importResyVenue(
	organizationId: string,
	venueId: string,
	scopedLocationId?: string,
) {
	const locationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'resy',
		scopedLocationId,
	)
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (!isResyMockMode()) {
		throw new Error('Resy live venue import is not supported yet.')
	}
	const venue =
		MOCK_RESY_VENUES.find((candidate) => candidate.venue_id === venueId) ??
		MOCK_RESY_VENUES[0]
	if (!venue) throw new Error('Resy venue was not found.')
	const config = parseIntegrationConfig(integration.config)

	const street = [venue.location?.address_1, venue.location?.address_2]
		.filter(Boolean)
		.join(', ')
	const formattedAddress = [
		street,
		venue.location?.locality,
		venue.location?.region,
		venue.location?.postal_code,
		venue.location?.country,
	]
		.filter(Boolean)
		.join(', ')

	const importedAddress: LocationAddress = {
		formattedAddress,
		city: venue.location?.locality || '',
		state: venue.location?.region || '',
		postalCode: venue.location?.postal_code || '',
		country: venue.location?.country || '',
		lat: 0,
		lng: 0,
	}

	await db
		.update(OrganizationLocation)
		.set({
			name: venue.name,
			address: JSON.stringify(importedAddress),
			phone: venue.phone_number || null,
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
				venueId: venue.venue_id,
				venueName: venue.name,
				venueUrl: venue.url,
				portalUrl: 'https://os.resy.com',
				venue,
			}),
		})
		.where(eq(IntegrationTable.id, integration.id))

	return venue
}

export async function listResyReviews(
	organizationId: string,
	pageTokens: ResyReviewPageTokens = {},
) {
	if (!isResyMockMode()) {
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
				eq(IntegrationTable.providerName, 'resy'),
				eq(IntegrationTable.isActive, true),
			),
		)
		.where(eq(OrganizationLocation.organizationId, organizationId))

	if (connectedLocations.length === 0) {
		return {
			reviews: [],
			totalReviewCount: 0,
			nextPageTokens: {} as ResyReviewPageTokens,
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

			const allReviews = MOCK_RESY_REVIEWS.map((review) => ({
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
				new Date(b.created_at ?? 0).getTime() -
				new Date(a.created_at ?? 0).getTime(),
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

export async function replyToResyReview(
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
