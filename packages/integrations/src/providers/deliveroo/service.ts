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
import { DeliverooProvider, isDeliverooMockMode } from './provider'

const deliverooLocationSchema = z
	.object({
		id: z.string(),
		name: z.string().min(1),
		url: z.string().optional(),
		phone: z.string().optional(),
		address: z
			.object({
				address1: z.string().optional(),
				address2: z.string().optional(),
				postcode: z.string().optional(),
				city: z.string().optional(),
				country: z.string().optional(),
			})
			.optional(),
		status: z.string().optional(),
		rating: z.number().optional(),
	})
	.passthrough()

export type DeliverooLocation = z.infer<typeof deliverooLocationSchema>

export const deliverooReviewSchema = z
	.object({
		id: z.string(),
		rating: z.number().min(1).max(5),
		comment: z.string().optional(),
		submitted_at: z.string().optional(),
		order_id: z.string().optional(),
		customer_name: z.string().optional(),
		tags: z.array(z.string()).optional(),
		reviewReply: z
			.object({ comment: z.string(), updateTime: z.string().optional() })
			.optional(),
	})
	.passthrough()

export type DeliverooReview = z.infer<typeof deliverooReviewSchema> & {
	locationId: string
	locationName: string
}

export type DeliverooReviewPageTokens = Record<string, string | null>

const MOCK_DELIVEROO_LOCATIONS: DeliverooLocation[] = [
	{
		id: 'mock-menuza-deliveroo-site-1',
		name: 'Menuza Demo Bistro - Delivery Kitchen',
		url: 'https://deliveroo.co.uk/menu/london/central/menuza-demo-bistro',
		phone: '+44 20 7946 0910',
		address: {
			address1: '123 Demo Street',
			city: 'London',
			postcode: 'EC1A 1BB',
			country: 'UK',
		},
		status: 'OPEN',
		rating: 4.7,
	},
]

const MOCK_DELIVEROO_REVIEWS: z.infer<typeof deliverooReviewSchema>[] = [
	{
		id: 'del-review-1',
		rating: 5,
		comment:
			'Food arrived piping hot and neatly packaged. The truffle fries were incredible!',
		submitted_at: '2026-02-17T20:05:00Z',
		order_id: 'DEL-98421',
		customer_name: 'Liam S.',
		tags: ['Fast delivery', 'Hot food', 'Great packaging'],
	},
	{
		id: 'del-review-2',
		rating: 4,
		comment:
			'Generous portions and very fresh salad. Would appreciate extra sauce next time.',
		submitted_at: '2026-02-09T18:40:00Z',
		order_id: 'DEL-97643',
		customer_name: 'Sophie M.',
		tags: ['Tasty meal', 'Good portions'],
	},
	{
		id: 'del-review-3',
		rating: 3,
		comment:
			'Delivery was slightly delayed during peak rush hour, though the burger itself was very tasty.',
		submitted_at: '2026-01-25T19:50:00Z',
		order_id: 'DEL-95211',
		customer_name: 'Oliver K.',
		tags: ['Delivery delay'],
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
		'deliveroo',
		organizationLocationId,
	)
	if (!integration?.isActive) {
		throw new Error('Deliveroo is not connected for this restaurant location.')
	}
	const token = isDeliverooMockMode()
		? 'mock-deliveroo-access-token'
		: await tokenManager.getValidAccessToken(
				integration,
				new DeliverooProvider(),
			)
	if (!token) {
		throw new Error('Reconnect Deliveroo to continue')
	}
	return { integration, token }
}

export async function listDeliverooLocations(
	organizationId: string,
	locationId: string,
): Promise<DeliverooLocation[]> {
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (isDeliverooMockMode()) return MOCK_DELIVEROO_LOCATIONS
	const config = parseIntegrationConfig(integration.config)
	if (config.location) {
		const parsed = deliverooLocationSchema.safeParse(config.location)
		if (parsed.success) return [parsed.data]
	}
	return []
}

export async function importDeliverooLocation(
	organizationId: string,
	siteId: string,
	scopedLocationId?: string,
) {
	const locationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'deliveroo',
		scopedLocationId,
	)
	if (!locationId) throw new Error('A restaurant location is required.')
	const { integration } = await getConnection(organizationId, locationId)
	if (!isDeliverooMockMode()) {
		throw new Error('Deliveroo live listing import is not supported yet.')
	}
	const location = MOCK_DELIVEROO_LOCATIONS.find(
		(candidate) => candidate.id === siteId,
	)
	if (!location) throw new Error('Deliveroo site listing was not found.')
	const config = parseIntegrationConfig(integration.config)

	const street = [location.address?.address1, location.address?.address2]
		.filter(Boolean)
		.join(', ')
	const formattedAddress = [
		street,
		location.address?.city,
		location.address?.postcode,
		location.address?.country,
	]
		.filter(Boolean)
		.join(', ')

	const importedAddress: LocationAddress = {
		formattedAddress,
		city: location.address?.city || '',
		state: '',
		postalCode: location.address?.postcode || '',
		country: location.address?.country || '',
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
				siteId: location.id,
				siteName: location.name,
				siteUrl: location.url,
				hubUrl: 'https://hub.deliveroo.net',
				location,
			}),
		})
		.where(eq(IntegrationTable.id, integration.id))

	return location
}

export async function listDeliverooReviews(
	organizationId: string,
	pageTokens: DeliverooReviewPageTokens = {},
) {
	if (!isDeliverooMockMode()) {
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
				eq(IntegrationTable.providerName, 'deliveroo'),
				eq(IntegrationTable.isActive, true),
			),
		)
		.where(eq(OrganizationLocation.organizationId, organizationId))

	if (connectedLocations.length === 0) {
		return {
			reviews: [],
			totalReviewCount: 0,
			nextPageTokens: {} as DeliverooReviewPageTokens,
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

			const allReviews = MOCK_DELIVEROO_REVIEWS.map((review) => ({
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
				new Date(b.submitted_at ?? 0).getTime() -
				new Date(a.submitted_at ?? 0).getTime(),
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

export async function replyToDeliverooReview(
	organizationId: string,
	locationId: string,
	reviewId: string,
	comment: string,
) {
	if (!isDeliverooMockMode()) {
		throw new Error('Deliveroo does not support public review replies via API.')
	}
	if (!MOCK_DELIVEROO_REVIEWS.some((review) => review.id === reviewId)) {
		throw new Error('Deliveroo review was not found in the local sample data.')
	}
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
