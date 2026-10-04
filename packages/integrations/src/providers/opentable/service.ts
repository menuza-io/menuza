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
import { OpenTableProvider, isOpenTableMockMode } from './provider'

const openTableLocationSchema = z
	.object({
		rid: z
			.number()
			.or(z.string())
			.transform((val) => String(val)),
		name: z.string().min(1),
		profile_url: z.string().optional(),
		phone_number: z.string().optional(),
		address: z
			.object({
				line1: z.string().optional(),
				line2: z.string().optional(),
				city: z.string().optional(),
				state: z.string().optional(),
				post_code: z.string().optional(),
				country: z.string().optional(),
			})
			.optional(),
		overall_rating: z.number().optional(),
		review_count: z.number().optional(),
	})
	.passthrough()

export type OpenTableLocation = z.infer<typeof openTableLocationSchema>

export const openTableReviewSchema = z
	.object({
		id: z.string(),
		diner_display_name: z.string().optional(),
		overall_rating: z.number().min(1).max(5),
		food_rating: z.number().optional(),
		service_rating: z.number().optional(),
		ambience_rating: z.number().optional(),
		comments: z.string().optional(),
		visited_date: z.string().optional(),
		submitted_date: z.string().optional(),
		is_vip: z.boolean().optional(),
		reviewReply: z
			.object({ comment: z.string(), updateTime: z.string().optional() })
			.optional(),
	})
	.passthrough()

export type OpenTableReview = z.infer<typeof openTableReviewSchema> & {
	locationId: string
	locationName: string
}

export type OpenTableReviewPageTokens = Record<string, string | null>

const MOCK_OPENTABLE_LOCATIONS: OpenTableLocation[] = [
	{
		rid: 'mock-menuza-opentable-rid-104',
		name: 'Menuza Demo Bistro',
		profile_url: 'https://www.opentable.com/r/menuza-demo-bistro-chicago',
		phone_number: '+1 (555) 555-0100',
		address: {
			line1: '123 Demo Street',
			city: 'Chicago',
			state: 'IL',
			post_code: '60601',
			country: 'US',
		},
		overall_rating: 4.8,
		review_count: 420,
	},
]

const MOCK_OPENTABLE_REVIEWS: z.infer<typeof openTableReviewSchema>[] = [
	{
		id: 'ot-review-1',
		diner_display_name: 'Diner from Chicago',
		overall_rating: 5,
		food_rating: 5,
		service_rating: 5,
		ambience_rating: 5,
		comments:
			'Celebrated our anniversary here and were treated like royalty. The sommelier wine pairing was unforgettable.',
		visited_date: '2026-02-14',
		submitted_date: '2026-02-15T10:30:00Z',
		is_vip: true,
	},
	{
		id: 'ot-review-2',
		diner_display_name: 'FrequentDiner_Chi',
		overall_rating: 4,
		food_rating: 5,
		service_rating: 4,
		ambience_rating: 4,
		comments:
			'Consistently delicious food and pleasant atmosphere. Perfect for business dinners or casual dates.',
		visited_date: '2026-02-06',
		submitted_date: '2026-02-07T14:15:00Z',
	},
	{
		id: 'ot-review-3',
		diner_display_name: 'GourmetTraveler',
		overall_rating: 3,
		food_rating: 4,
		service_rating: 3,
		ambience_rating: 4,
		comments:
			'The entrees were top notch, but our table was placed very close to the kitchen entrance.',
		visited_date: '2026-01-20',
		submitted_date: '2026-01-21T18:00:00Z',
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
		'opentable',
		organizationLocationId,
	)
	if (!integration?.isActive) {
		throw new Error('OpenTable is not connected for this restaurant location.')
	}
	const token = isOpenTableMockMode()
		? 'mock-opentable-access-token'
		: await tokenManager.getValidAccessToken(
				integration,
				new OpenTableProvider(),
			)
	if (!token) {
		throw new Error('Reconnect OpenTable to continue')
	}
	return { integration, token }
}

export async function listOpenTableLocations(
	organizationId: string,
	locationId: string,
): Promise<OpenTableLocation[]> {
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (isOpenTableMockMode()) return MOCK_OPENTABLE_LOCATIONS
	const config = parseIntegrationConfig(integration.config)
	if (config.location) {
		const parsed = openTableLocationSchema.safeParse(config.location)
		if (parsed.success) return [parsed.data]
	}
	return []
}

export async function importOpenTableLocation(
	organizationId: string,
	restaurantId: string,
	scopedLocationId?: string,
) {
	const locationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'opentable',
		scopedLocationId,
	)
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (!isOpenTableMockMode()) {
		throw new Error('OpenTable live listing import is not supported yet.')
	}
	const location =
		MOCK_OPENTABLE_LOCATIONS.find(
			(candidate) => candidate.rid === restaurantId,
		) ?? MOCK_OPENTABLE_LOCATIONS[0]
	if (!location) throw new Error('OpenTable restaurant listing was not found.')
	const config = parseIntegrationConfig(integration.config)

	const street = [location.address?.line1, location.address?.line2]
		.filter(Boolean)
		.join(', ')
	const formattedAddress = [
		street,
		location.address?.city,
		location.address?.state,
		location.address?.post_code,
		location.address?.country,
	]
		.filter(Boolean)
		.join(', ')

	const importedAddress: LocationAddress = {
		formattedAddress,
		city: location.address?.city || '',
		state: location.address?.state || '',
		postalCode: location.address?.post_code || '',
		country: location.address?.country || '',
		lat: 0,
		lng: 0,
	}

	await db
		.update(OrganizationLocation)
		.set({
			name: location.name,
			address: JSON.stringify(importedAddress),
			phone: location.phone_number || null,
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
				restaurantId: location.rid,
				restaurantName: location.name,
				restaurantUrl: location.profile_url,
				portalUrl: 'https://restaurant.opentable.com',
				location,
			}),
		})
		.where(eq(IntegrationTable.id, integration.id))

	return location
}

export async function listOpenTableReviews(
	organizationId: string,
	pageTokens: OpenTableReviewPageTokens = {},
) {
	if (!isOpenTableMockMode()) {
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
				eq(IntegrationTable.providerName, 'opentable'),
				eq(IntegrationTable.isActive, true),
			),
		)
		.where(eq(OrganizationLocation.organizationId, organizationId))

	if (connectedLocations.length === 0) {
		return {
			reviews: [],
			totalReviewCount: 0,
			nextPageTokens: {} as OpenTableReviewPageTokens,
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

			const allReviews = MOCK_OPENTABLE_REVIEWS.map((review) => ({
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
				new Date(b.submitted_date ?? 0).getTime() -
				new Date(a.submitted_date ?? 0).getTime(),
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

export async function replyToOpenTableReview(
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
