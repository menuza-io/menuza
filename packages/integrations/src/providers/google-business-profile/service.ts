import {
	DAYS_OF_WEEK,
	type LocationAddress,
	type WeeklySchedule,
} from '@repo/common/location-types'
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
import {
	GoogleBusinessProfileProvider,
	isGoogleBusinessProfileMockMode,
} from './provider'

const addressSchema = z
	.object({
		addressLines: z.array(z.string()).optional(),
		locality: z.string().optional(),
		administrativeArea: z.string().optional(),
		postalCode: z.string().optional(),
		regionCode: z.string().optional(),
	})
	.passthrough()
const periodSchema = z.object({
	openDay: z.string(),
	closeDay: z.string(),
	openTime: z.object({
		hours: z.number().optional(),
		minutes: z.number().optional(),
	}),
	closeTime: z.object({
		hours: z.number().optional(),
		minutes: z.number().optional(),
	}),
})
const locationSchema = z
	.object({
		name: z.string().regex(/^locations\/[A-Za-z0-9_-]+$/),
		title: z.string().min(1),
		phoneNumbers: z.object({ primaryPhone: z.string().optional() }).optional(),
		storefrontAddress: addressSchema.optional(),
		websiteUri: z.string().optional(),
		regularHours: z
			.object({ periods: z.array(periodSchema).optional() })
			.optional(),
		categories: z.unknown().optional(),
		profile: z.object({ description: z.string().optional() }).optional(),
		metadata: z.unknown().optional(),
		latlng: z
			.object({
				latitude: z.number().optional(),
				longitude: z.number().optional(),
			})
			.optional(),
		openInfo: z.unknown().optional(),
	})
	.passthrough()
export type GoogleBusinessLocation = z.infer<typeof locationSchema>

const READ_MASK =
	'name,title,phoneNumbers,storefrontAddress,websiteUri,regularHours,categories,profile,metadata,latlng,openInfo'

const googleReviewSchema = z
	.object({
		name: z.string(),
		reviewer: z
			.object({
				displayName: z.string().optional(),
				profilePhotoUrl: z.string().optional(),
				isAnonymous: z.boolean().optional(),
			})
			.optional(),
		starRating: z.enum(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']).optional(),
		comment: z.string().optional(),
		createTime: z.string().optional(),
		updateTime: z.string().optional(),
		reviewReply: z
			.object({ comment: z.string(), updateTime: z.string().optional() })
			.optional(),
	})
	.passthrough()

const MOCK_GOOGLE_ACCOUNT_NAME = 'accounts/mock-menuza'
const MOCK_GOOGLE_LOCATIONS: GoogleBusinessLocation[] = [
	{
		name: 'locations/mock-menuza-downtown',
		title: 'Menuza Demo Bistro',
		phoneNumbers: { primaryPhone: '+1-555-0100' },
		storefrontAddress: {
			addressLines: ['123 Demo Street'],
			locality: 'Chicago',
			administrativeArea: 'IL',
			postalCode: '60601',
			regionCode: 'US',
		},
		websiteUri: 'https://example.com/menuza-demo-bistro',
		regularHours: {
			periods: [
				'MONDAY',
				'TUESDAY',
				'WEDNESDAY',
				'THURSDAY',
				'FRIDAY',
				'SATURDAY',
				'SUNDAY',
			].map((day) => ({
				openDay: day,
				closeDay: day,
				openTime: { hours: 11, minutes: 0 },
				closeTime: { hours: day === 'MONDAY' ? 21 : 22, minutes: 0 },
			})),
		},
		categories: { primaryCategory: { displayName: 'Restaurant' } },
		profile: {
			description: 'A sample restaurant for offline GBP development.',
		},
	},
]

const MOCK_GOOGLE_REVIEWS: z.infer<typeof googleReviewSchema>[] = [
	{
		name: `${MOCK_GOOGLE_ACCOUNT_NAME}/locations/mock-menuza-downtown/reviews/review-1`,
		reviewer: { displayName: 'Jordan Rivera' },
		starRating: 'FIVE',
		comment: 'Wonderful food and a welcoming team. We will be back!',
		createTime: '2026-02-12T18:30:00.000Z',
		updateTime: '2026-02-12T18:30:00.000Z',
	},
	{
		name: `${MOCK_GOOGLE_ACCOUNT_NAME}/locations/mock-menuza-downtown/reviews/review-2`,
		reviewer: { displayName: 'Alex Morgan' },
		starRating: 'FOUR',
		comment: 'Great atmosphere and generous portions.',
		createTime: '2026-01-28T19:15:00.000Z',
		updateTime: '2026-01-28T19:15:00.000Z',
	},
	{
		name: `${MOCK_GOOGLE_ACCOUNT_NAME}/locations/mock-menuza-downtown/reviews/review-3`,
		reviewer: { displayName: 'Taylor Chen' },
		starRating: 'THREE',
		comment: 'The meal was good, though service was a little slow.',
		createTime: '2026-01-09T20:00:00.000Z',
		updateTime: '2026-01-09T20:00:00.000Z',
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

export type GoogleBusinessReview = z.infer<typeof googleReviewSchema> & {
	locationId: string
	locationName: string
}

export type GoogleReviewPageTokens = Record<string, string | null>

async function resolveGoogleAccountName(
	token: string,
	googleLocationName: string,
): Promise<string> {
	const accountNames: string[] = []
	let accountPageToken: string | undefined
	do {
		const url = new URL(
			'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
		)
		url.searchParams.set('pageSize', '20')
		if (accountPageToken) url.searchParams.set('pageToken', accountPageToken)
		const page = await googleGet(
			url,
			token,
			z.object({
				accounts: z
					.array(
						z.object({ name: z.string().regex(/^accounts\/[A-Za-z0-9_-]+$/) }),
					)
					.optional(),
				nextPageToken: z.string().optional(),
			}),
		)
		accountNames.push(...(page.accounts ?? []).map((account) => account.name))
		accountPageToken = page.nextPageToken
	} while (accountPageToken)

	for (const accountName of accountNames) {
		let locationPageToken: string | undefined
		do {
			const url = new URL(
				`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`,
			)
			url.searchParams.set('readMask', 'name')
			url.searchParams.set('pageSize', '100')
			if (locationPageToken)
				url.searchParams.set('pageToken', locationPageToken)
			const page = await googleGet(
				url,
				token,
				z.object({
					locations: z.array(z.object({ name: z.string() })).optional(),
					nextPageToken: z.string().optional(),
				}),
			)
			if (
				page.locations?.some((location) => location.name === googleLocationName)
			)
				return accountName
			locationPageToken = page.nextPageToken
		} while (locationPageToken)
	}
	throw new Error(
		'Google could not find the account for this restaurant location. Reconnect Google Business Profile and try again.',
	)
}

async function getScopedReviewConnection(
	organizationId: string,
	locationId: string,
) {
	const { integration, token } = await getConnection(organizationId, locationId)
	const rawConfig = parseIntegrationConfig(integration.config)
	const config = z
		.object({
			googleLocationName: z.string().regex(/^locations\/[A-Za-z0-9_-]+$/),
			googleAccountName: z
				.string()
				.regex(/^accounts\/[A-Za-z0-9_-]+$/)
				.optional(),
		})
		.passthrough()
		.safeParse(rawConfig)
	if (!config.success)
		throw new Error(
			'Import a Google Business Profile location before loading its reviews.',
		)
	const accountName =
		config.data.googleAccountName ??
		(isGoogleBusinessProfileMockMode()
			? MOCK_GOOGLE_ACCOUNT_NAME
			: await resolveGoogleAccountName(token, config.data.googleLocationName))
	if (!config.data.googleAccountName) {
		await db
			.update(IntegrationTable)
			.set({
				config: JSON.stringify({
					...(rawConfig as Record<string, unknown>),
					googleAccountName: accountName,
				}),
			})
			.where(eq(IntegrationTable.id, integration.id))
	}
	return {
		integration,
		token,
		accountName,
		googleLocationName: config.data.googleLocationName,
	}
}

/** Fetches one Google API page for each connected GBP location and merges by newest review. */
export async function listGoogleBusinessReviews(
	organizationId: string,
	pageTokens: GoogleReviewPageTokens = {},
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
				eq(IntegrationTable.providerName, 'google-business-profile'),
				eq(IntegrationTable.isActive, true),
			),
		)
		.where(eq(OrganizationLocation.organizationId, organizationId))

	if (connectedLocations.length === 0)
		return {
			reviews: [],
			totalReviewCount: 0,
			nextPageTokens: {} as GoogleReviewPageTokens,
		}

	const pages = await Promise.all(
		connectedLocations.map(async (location) => {
			if (pageTokens[location.id] === null)
				return { reviews: [], total: 0, next: null as string | null }
			const connection = await getScopedReviewConnection(
				organizationId,
				location.id,
			)
			if (isGoogleBusinessProfileMockMode()) {
				const config = parseIntegrationConfig(connection.integration.config)
				const storedReplies = z
					.record(
						z.object({
							comment: z.string(),
							updateTime: z.string().optional(),
						}),
					)
					.catch({})
					.parse(config.mockReviewReplies)
				const allReviews = MOCK_GOOGLE_REVIEWS.filter((review) =>
					review.name.startsWith(
						`${connection.accountName}/${connection.googleLocationName}/reviews/`,
					),
				).map((review) => ({
					...review,
					...(storedReplies[review.name]
						? { reviewReply: storedReplies[review.name] }
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
			const url = new URL(
				`https://mybusiness.googleapis.com/v4/${connection.accountName}/${connection.googleLocationName}/reviews`,
			)
			url.searchParams.set('pageSize', '50')
			url.searchParams.set('orderBy', 'updateTime desc')
			const pageToken = pageTokens[location.id]
			if (pageToken) url.searchParams.set('pageToken', pageToken)
			const result = await googleGet(
				url,
				connection.token,
				z.object({
					reviews: z.array(googleReviewSchema).optional(),
					totalReviewCount: z.number().optional(),
					nextPageToken: z.string().optional(),
				}),
			)
			return {
				reviews: (result.reviews ?? []).map((review) => ({
					...review,
					locationId: location.id,
					locationName: location.name,
				})),
				total: result.totalReviewCount ?? 0,
				next: result.nextPageToken ?? null,
			}
		}),
	)
	const reviews = pages
		.flatMap((page) => page.reviews)
		.sort(
			(a, b) =>
				new Date(b.updateTime ?? b.createTime ?? 0).getTime() -
				new Date(a.updateTime ?? a.createTime ?? 0).getTime(),
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

/** Posts a review response only when the review belongs to the linked GBP location. */
export async function replyToGoogleBusinessReview(
	organizationId: string,
	locationId: string,
	reviewName: string,
	comment: string,
) {
	const parsedComment = z.string().trim().min(1).max(4096).parse(comment)
	const connection = await getScopedReviewConnection(organizationId, locationId)
	const reviewPattern = new RegExp(
		`^${connection.accountName}/${connection.googleLocationName}/reviews/[A-Za-z0-9_-]+$`,
	)
	const parsedName = z
		.string()
		.regex(reviewPattern, 'Review does not belong to this connected location.')
		.parse(reviewName)
	if (isGoogleBusinessProfileMockMode()) {
		if (!MOCK_GOOGLE_REVIEWS.some((review) => review.name === parsedName)) {
			throw new Error(
				'Google review was not found in the local GBP sample data.',
			)
		}
		const rawConfig = parseIntegrationConfig(connection.integration.config)
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
					mockReviewReplies: { ...parsedReplies, [parsedName]: reply },
				}),
			})
			.where(eq(IntegrationTable.id, connection.integration.id))
		return reply
	}
	const response = await fetch(
		`https://mybusiness.googleapis.com/v4/${parsedName}/reply`,
		{
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${connection.token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ comment: parsedComment }),
			signal: AbortSignal.timeout(15000),
		},
	)
	if (!response.ok)
		throw new Error(
			`Google Business Profile could not save the reply (${response.status}).`,
		)
	return z
		.object({ comment: z.string(), updateTime: z.string().optional() })
		.parse(await response.json())
}

async function getConnection(
	organizationId: string,
	organizationLocationId: string,
) {
	const integration = await findScopedIntegration(
		organizationId,
		'google-business-profile',
		organizationLocationId,
	)
	if (!integration?.isActive) {
		throw new Error('Connect Google Business Profile first')
	}
	const token = await tokenManager.getValidAccessToken(
		integration,
		new GoogleBusinessProfileProvider(),
	)
	if (!token) throw new Error('Reconnect Google Business Profile to continue')
	return { integration, token }
}

async function googleGet<T>(
	url: URL,
	token: string,
	schema: z.ZodType<T>,
): Promise<T> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15000),
	})
	if (!response.ok)
		throw new Error(
			`Google Business Profile request failed (${response.status})`,
		)
	return schema.parse(await response.json())
}

export async function listGoogleBusinessLocations(
	organizationId: string,
	organizationLocationId?: string | null,
) {
	const locationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'google-business-profile',
		organizationLocationId,
	)
	if (!locationId) {
		throw new Error('A restaurant location is required.')
	}
	const { token } = await getConnection(organizationId, locationId)
	if (isGoogleBusinessProfileMockMode()) return MOCK_GOOGLE_LOCATIONS
	const results: GoogleBusinessLocation[] = []
	let pageToken: string | undefined
	do {
		const url = new URL(
			'https://mybusinessbusinessinformation.googleapis.com/v1/accounts/-/locations',
		)
		url.searchParams.set('readMask', READ_MASK)
		url.searchParams.set('pageSize', '100')
		if (pageToken) url.searchParams.set('pageToken', pageToken)
		const page = await googleGet(
			url,
			token,
			z.object({
				locations: z.array(locationSchema).optional(),
				nextPageToken: z.string().optional(),
			}),
		)
		results.push(...(page.locations ?? []))
		pageToken = page.nextPageToken
	} while (pageToken)
	return results
}

export function googleBusinessSchedule(
	location: GoogleBusinessLocation,
): WeeklySchedule | null {
	const periods = location.regularHours?.periods
	if (!periods) return null
	const slotsByDay = new Map<string, Array<{ start: string; end: string }>>()
	const time = (value: { hours?: number; minutes?: number }) =>
		`${String(value.hours ?? 0).padStart(2, '0')}:${String(value.minutes ?? 0).padStart(2, '0')}`
	const addSlot = (day: string, start: string, end: string) => {
		if (!DAYS_OF_WEEK.includes(day as (typeof DAYS_OF_WEEK)[number])) return
		const slots = slotsByDay.get(day) ?? []
		slots.push({ start, end })
		slotsByDay.set(day, slots)
	}
	for (const period of periods) {
		const openDay = period.openDay.toLowerCase()
		const closeDay = period.closeDay.toLowerCase()
		if (openDay === closeDay) {
			addSlot(openDay, time(period.openTime), time(period.closeTime))
		} else {
			addSlot(openDay, time(period.openTime), '23:59')
			addSlot(closeDay, '00:00', time(period.closeTime))
		}
	}
	return DAYS_OF_WEEK.map((day) => {
		const slots = slotsByDay.get(day) ?? []
		return { day, isOpen: slots.length > 0, slots }
	})
}

function address(location: GoogleBusinessLocation): LocationAddress | null {
	const source = location.storefrontAddress
	if (!source) return null
	return {
		formattedAddress: [
			...(source.addressLines ?? []),
			source.locality,
			source.administrativeArea,
			source.postalCode,
			source.regionCode,
		]
			.filter(Boolean)
			.join(', '),
		city: source.locality ?? '',
		state: source.administrativeArea ?? '',
		postalCode: source.postalCode ?? '',
		country: source.regionCode ?? '',
		lat: location.latlng?.latitude ?? 0,
		lng: location.latlng?.longitude ?? 0,
	}
}

/** Imports only the listing the operator selected. Reimports update its linked Menuza location. */
export async function importGoogleBusinessLocation(
	organizationId: string,
	googleLocationName: string,
	organizationLocationId?: string | null,
) {
	const selected = z
		.string()
		.regex(/^locations\/[A-Za-z0-9_-]+$/)
		.parse(googleLocationName)
	const scopedLocationId = await resolveOrganizationLocationIdForConnect(
		organizationId,
		'google-business-profile',
		organizationLocationId,
	)
	if (!scopedLocationId) {
		throw new Error('A restaurant location is required.')
	}
	const { integration, token } = await getConnection(
		organizationId,
		scopedLocationId,
	)
	const location = isGoogleBusinessProfileMockMode()
		? MOCK_GOOGLE_LOCATIONS.find((candidate) => candidate.name === selected)
		: await (async () => {
				const url = new URL(
					`https://mybusinessbusinessinformation.googleapis.com/v1/${selected}`,
				)
				url.searchParams.set('readMask', READ_MASK)
				return googleGet(url, token, locationSchema)
			})()
	if (!location)
		throw new Error('Google Business Profile location was not found.')
	const config = parseIntegrationConfig(integration.config)

	const importedAddress = address(location)
	const importedSchedule = googleBusinessSchedule(location)
	const values = {
		name: location.title,
		phone: location.phoneNumbers?.primaryPhone ?? null,
		address: importedAddress ? JSON.stringify(importedAddress) : null,
		storeHours: importedSchedule ? JSON.stringify(importedSchedule) : null,
	}
	const menuzaLocationId = await db.transaction(async (tx) => {
		const locationId = scopedLocationId
		await tx
			.update(OrganizationLocation)
			.set(values)
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			)
		await tx
			.update(IntegrationTable)
			.set({
				organizationLocationId: locationId,
				config: JSON.stringify({
					...config,
					...(isGoogleBusinessProfileMockMode()
						? { googleAccountName: MOCK_GOOGLE_ACCOUNT_NAME }
						: {}),
					googleLocationName: selected,
					menuzaLocationId: locationId,
					business: location,
				}),
				lastSyncAt: new Date(),
			})
			.where(eq(IntegrationTable.id, integration.id))
		return locationId
	})
	return { location, menuzaLocationId }
}
