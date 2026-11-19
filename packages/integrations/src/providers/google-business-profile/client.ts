/**
 * The one door to Google Business Profile writes and reads beyond the
 * original import (#87, #284, #209, #208, #199, #135, #136). Every Google
 * call the App makes goes through `GbpClient`, which has a live HTTP
 * implementation (below) and a stateful mock (`mock-client.ts`). Tests
 * replace the client with `setGbpClientFactory`; they never reach Google.
 *
 * A failed call throws `GbpError` with a code (`gbp_token_expired`,
 * `gbp_rate_limited`, ...). The client never retries by itself: callers
 * record the failure and wait an hour before sending the same field again.
 */
import {
	type GoogleAttributeMeta,
	type VerificationMethod,
	type VerificationOption,
	GbpError,
	gbpErrorFromResponse,
} from '@repo/common/gbp-listing'
import {
	type GooglePeriod,
	type GoogleSpecialHourPeriod,
} from '@repo/common/gbp-hours'
import { type PlaceActionType } from '@repo/common/ordering-providers'
import { type Integration } from '../../database-types'
import { tokenManager } from '../../token-manager'
import {
	GoogleBusinessProfileProvider,
	isGoogleBusinessProfileMockMode,
} from './provider'
import { mockGbpClient } from './mock-client'

/** The listing fields Menuza reads and writes. */
export type GbpListing = {
	name: string
	title?: string
	phoneNumbers?: { primaryPhone?: string }
	storefrontAddress?: Record<string, unknown>
	websiteUri?: string
	regularHours?: { periods?: GooglePeriod[] }
	specialHours?: { specialHourPeriods?: GoogleSpecialHourPeriod[] }
	openInfo?: {
		status?: string
		openingDate?: { year: number; month: number; day: number }
	}
	categories?: unknown
	profile?: { description?: string }
	metadata?: Record<string, unknown>
}

export const GBP_LISTING_READ_MASK =
	'name,title,phoneNumbers,storefrontAddress,websiteUri,regularHours,specialHours,openInfo,categories,profile,metadata'

export type PatchOutcome = {
	/** `accepted` is live; `pending` is held by Google for review. */
	status: 'accepted' | 'pending'
	listing?: GbpListing
}

export type PlaceActionLink = {
	name: string
	uri: string
	placeActionType: string
	isPreferred: boolean
	isEditable: boolean
	/** `MERCHANT` (the owner) or `AGGREGATOR_3P` (a partner). */
	providerType: string
}

export type VoiceOfMerchantState = {
	/** The operator may edit the listing (it is verified and ours). */
	hasVoiceOfMerchant: boolean
	hasBusinessAuthority: boolean
	hasPendingVerification: boolean
	suspended: boolean
	/** Another account already manages the listing. */
	ownershipConflict: boolean
}

export type VerificationRecord = {
	name: string
	method: string
	// PENDING | COMPLETED | FAILED
	state: string
	createTime?: string
}

export type GbpMediaItem = { name: string; googleUrl?: string }

export type FoodMenusBody = {
	menus: unknown[]
}

export type LocalPostBody = Record<string, unknown>
export type LocalPost = {
	name: string
	// PROCESSING | LIVE | REJECTED
	state: string
	searchUrl?: string
	rejectionReason?: string
}

export type DailyMetricSeries = Array<{
	metric: string
	date: string
	value: number
}>

export type SearchKeywordCount = {
	keyword: string
	value: number | null
	threshold: number | null
}

export type AttributeValues = Record<string, boolean | string | null>

export interface GbpClient {
	getListing(locationName: string): Promise<GbpListing>
	patchListing(
		locationName: string,
		updateMask: string,
		body: Partial<GbpListing>,
	): Promise<PatchOutcome>
	/** Fields Google changed or holds for review (`getGoogleUpdated`). */
	getGoogleUpdated(locationName: string): Promise<{
		listing: GbpListing | null
		pendingMask: string
		diffMask: string
	}>

	getVoiceOfMerchantState(locationName: string): Promise<VoiceOfMerchantState>
	fetchVerificationOptions(
		locationName: string,
		languageCode: string,
	): Promise<VerificationOption[]>
	startVerification(
		locationName: string,
		input: {
			method: VerificationMethod
			languageCode: string
			destination?: string | null
		},
	): Promise<VerificationRecord>
	completeVerification(
		verificationName: string,
		pin: string,
	): Promise<VerificationRecord>
	listVerifications(locationName: string): Promise<VerificationRecord[]>

	listPlaceActionLinks(locationName: string): Promise<PlaceActionLink[]>
	createPlaceActionLink(
		locationName: string,
		input: {
			uri: string
			placeActionType: PlaceActionType
			isPreferred: boolean
		},
	): Promise<PlaceActionLink>
	patchPlaceActionLink(
		linkName: string,
		input: { uri?: string; isPreferred?: boolean },
	): Promise<PlaceActionLink>
	deletePlaceActionLink(linkName: string): Promise<void>

	listAttributeMetadata(locationName: string): Promise<GoogleAttributeMeta[]>
	getAttributes(locationName: string): Promise<AttributeValues>
	updateAttributes(
		locationName: string,
		values: AttributeValues,
	): Promise<PatchOutcome>

	publishFoodMenus(
		accountName: string,
		locationName: string,
		body: FoodMenusBody,
	): Promise<void>
	uploadMedia(
		accountName: string,
		locationName: string,
		input: { sourceUrl: string; category: string },
	): Promise<GbpMediaItem>
	deleteMedia(mediaName: string): Promise<void>

	createLocalPost(
		accountName: string,
		locationName: string,
		body: LocalPostBody,
	): Promise<LocalPost>
	getLocalPost(postName: string): Promise<LocalPost>
	deleteLocalPost(postName: string): Promise<void>

	fetchDailyMetrics(
		locationName: string,
		start: string,
		end: string,
	): Promise<DailyMetricSeries>
	listSearchKeywords(
		locationName: string,
		month: string,
	): Promise<SearchKeywordCount[]>
}

// ---------------------------------------------------------------------------
// Live client
// ---------------------------------------------------------------------------

const BUSINESS_INFO = 'https://mybusinessbusinessinformation.googleapis.com/v1'
const PLACE_ACTIONS = 'https://mybusinessplaceactions.googleapis.com/v1'
const VERIFICATIONS = 'https://mybusinessverifications.googleapis.com/v1'
const MY_BUSINESS_V4 = 'https://mybusiness.googleapis.com/v4'
const PERFORMANCE = 'https://businessprofileperformance.googleapis.com/v1'

const LOCATION_NAME = /^locations\/[A-Za-z0-9_-]+$/
const ACCOUNT_NAME = /^accounts\/[A-Za-z0-9_-]+$/

function assertLocationName(name: string) {
	if (!LOCATION_NAME.test(name))
		throw new GbpError('gbp_api_error', 400, 'bad_location')
}
function assertAccountName(name: string) {
	if (!ACCOUNT_NAME.test(name))
		throw new GbpError('gbp_api_error', 400, 'bad_account')
}

function dateParts(iso: string) {
	const [year, month, day] = iso.split('-').map(Number)
	return { year: year!, month: month!, day: day! }
}

/** The live Google client for one access token. */
export function googleGbpClient(
	accessToken: string,
	fetchImpl: typeof fetch = fetch,
): GbpClient {
	async function call<T>(
		url: string | URL,
		init: RequestInit = {},
	): Promise<T | null> {
		const response = await fetchImpl(url, {
			...init,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': 'application/json',
				...init.headers,
			},
			signal: AbortSignal.timeout(20_000),
		})
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: { status?: string; message?: string }
			} | null
			throw gbpErrorFromResponse(response.status, body)
		}
		const text = await response.text()
		return text ? (JSON.parse(text) as T) : null
	}

	const url = (base: string, path: string, params?: Record<string, string>) => {
		const built = new URL(`${base}/${path}`)
		for (const [key, value] of Object.entries(params ?? {})) {
			built.searchParams.set(key, value)
		}
		return built
	}

	const toLink = (raw: Record<string, unknown>): PlaceActionLink => ({
		name: String(raw.name ?? ''),
		uri: String(raw.uri ?? ''),
		placeActionType: String(raw.placeActionType ?? ''),
		isPreferred: raw.isPreferred === true,
		isEditable: raw.isEditable !== false,
		providerType: String(raw.providerType ?? ''),
	})

	return {
		async getListing(name) {
			assertLocationName(name)
			const listing = await call<GbpListing>(
				url(BUSINESS_INFO, name, { readMask: GBP_LISTING_READ_MASK }),
			)
			return listing ?? { name }
		},
		async patchListing(name, updateMask, body) {
			assertLocationName(name)
			const listing = await call<GbpListing>(
				url(BUSINESS_INFO, name, { updateMask }),
				{ method: 'PATCH', body: JSON.stringify(body) },
			)
			// Google applies most edits at once and holds some for review; the
			// pending mask of `getGoogleUpdated` says which.
			const updated = await call<{ pendingMask?: string }>(
				url(BUSINESS_INFO, `${name}:getGoogleUpdated`, {
					readMask: GBP_LISTING_READ_MASK,
				}),
			).catch(() => null)
			const pending = (updated?.pendingMask ?? '').split(',').filter(Boolean)
			const masked = updateMask.split(',')
			const isPending = masked.some((field) =>
				pending.some((p) => p === field || field.startsWith(`${p}.`)),
			)
			return {
				status: isPending ? 'pending' : 'accepted',
				listing: listing ?? undefined,
			}
		},
		async getGoogleUpdated(name) {
			assertLocationName(name)
			const data = await call<{
				location?: GbpListing
				diffMask?: string
				pendingMask?: string
			}>(
				url(BUSINESS_INFO, `${name}:getGoogleUpdated`, {
					readMask: GBP_LISTING_READ_MASK,
				}),
			)
			return {
				listing: data?.location ?? null,
				diffMask: data?.diffMask ?? '',
				pendingMask: data?.pendingMask ?? '',
			}
		},

		async getVoiceOfMerchantState(name) {
			assertLocationName(name)
			const data = await call<{
				hasVoiceOfMerchant?: boolean
				hasBusinessAuthority?: boolean
				verify?: { hasPendingVerification?: boolean }
				complyWithGuidelines?: { recommendationReason?: string }
				resolveOwnershipConflict?: unknown
			}>(url(VERIFICATIONS, `${name}/VoiceOfMerchantState`))
			const reason = data?.complyWithGuidelines?.recommendationReason ?? ''
			return {
				hasVoiceOfMerchant: data?.hasVoiceOfMerchant === true,
				hasBusinessAuthority: data?.hasBusinessAuthority === true,
				hasPendingVerification: data?.verify?.hasPendingVerification === true,
				suspended: /SUSPENDED|DISABLED/.test(reason),
				ownershipConflict: Boolean(data?.resolveOwnershipConflict),
			}
		},
		async fetchVerificationOptions(name, languageCode) {
			assertLocationName(name)
			const data = await call<{
				options?: Array<{
					verificationMethod?: string
					addressData?: { address?: { addressLines?: string[] } }
					emailData?: { domainName?: string; userName?: string }
					phoneNumber?: string
				}>
			}>(url(VERIFICATIONS, `${name}:fetchVerificationOptions`), {
				method: 'POST',
				body: JSON.stringify({ languageCode }),
			})
			return (data?.options ?? []).flatMap((option) => {
				const method = option.verificationMethod as VerificationMethod
				if (!method) return []
				const destination =
					option.phoneNumber ??
					option.addressData?.address?.addressLines?.join(', ') ??
					(option.emailData?.userName
						? `${option.emailData.userName}@${option.emailData.domainName ?? ''}`
						: null)
				return [{ method, destination: destination ?? null }]
			})
		},
		async startVerification(name, input) {
			assertLocationName(name)
			const body: Record<string, unknown> = {
				method: input.method,
				languageCode: input.languageCode,
			}
			if (input.method === 'EMAIL' && input.destination) {
				body.emailAddress = input.destination
			} else if (
				(input.method === 'PHONE_CALL' || input.method === 'SMS') &&
				input.destination
			) {
				body.phoneNumber = input.destination
			}
			const data = await call<{ verification?: Record<string, unknown> }>(
				url(VERIFICATIONS, `${name}:verify`),
				{ method: 'POST', body: JSON.stringify(body) },
			)
			const verification = data?.verification ?? {}
			return {
				name: String(verification.name ?? ''),
				method: String(verification.method ?? input.method),
				state: String(verification.state ?? 'PENDING'),
				createTime: verification.createTime as string | undefined,
			}
		},
		async completeVerification(verificationName, pin) {
			if (
				!/^locations\/[A-Za-z0-9_-]+\/verifications\/[A-Za-z0-9_-]+$/.test(
					verificationName,
				)
			) {
				throw new GbpError('gbp_api_error', 400, 'bad_verification')
			}
			const data = await call<{ verification?: Record<string, unknown> }>(
				url(VERIFICATIONS, `${verificationName}:complete`),
				{ method: 'POST', body: JSON.stringify({ pin }) },
			)
			const verification = data?.verification ?? {}
			return {
				name: verificationName,
				method: String(verification.method ?? ''),
				state: String(verification.state ?? 'COMPLETED'),
			}
		},
		async listVerifications(name) {
			assertLocationName(name)
			const data = await call<{
				verifications?: Array<Record<string, unknown>>
			}>(url(VERIFICATIONS, `${name}/verifications`))
			return (data?.verifications ?? []).map((verification) => ({
				name: String(verification.name ?? ''),
				method: String(verification.method ?? ''),
				state: String(verification.state ?? ''),
				createTime: verification.createTime as string | undefined,
			}))
		},

		async listPlaceActionLinks(name) {
			assertLocationName(name)
			const links: PlaceActionLink[] = []
			let pageToken = ''
			do {
				const data = await call<{
					placeActionLinks?: Array<Record<string, unknown>>
					nextPageToken?: string
				}>(
					url(PLACE_ACTIONS, `${name}/placeActionLinks`, {
						pageSize: '100',
						...(pageToken ? { pageToken } : {}),
					}),
				)
				links.push(...(data?.placeActionLinks ?? []).map(toLink))
				pageToken = data?.nextPageToken ?? ''
			} while (pageToken)
			return links
		},
		async createPlaceActionLink(name, input) {
			assertLocationName(name)
			const data = await call<Record<string, unknown>>(
				url(PLACE_ACTIONS, `${name}/placeActionLinks`),
				{
					method: 'POST',
					body: JSON.stringify({
						uri: input.uri,
						placeActionType: input.placeActionType,
						isPreferred: input.isPreferred,
					}),
				},
			)
			return toLink(data ?? {})
		},
		async patchPlaceActionLink(linkName, input) {
			const mask = [
				input.uri !== undefined ? 'uri' : null,
				input.isPreferred !== undefined ? 'isPreferred' : null,
			]
				.filter(Boolean)
				.join(',')
			const data = await call<Record<string, unknown>>(
				url(PLACE_ACTIONS, linkName, { updateMask: mask }),
				{ method: 'PATCH', body: JSON.stringify(input) },
			)
			return toLink(data ?? {})
		},
		async deletePlaceActionLink(linkName) {
			await call(url(PLACE_ACTIONS, linkName), { method: 'DELETE' })
		},

		async listAttributeMetadata(name) {
			assertLocationName(name)
			const out: GoogleAttributeMeta[] = []
			let pageToken = ''
			do {
				const data = await call<{
					attributeMetadata?: Array<Record<string, unknown>>
					nextPageToken?: string
				}>(
					url(BUSINESS_INFO, 'attributes', {
						parent: name,
						languageCode: 'en',
						pageSize: '200',
						...(pageToken ? { pageToken } : {}),
					}),
				)
				for (const item of data?.attributeMetadata ?? []) {
					out.push({
						name: String(item.parent ?? item.name ?? ''),
						displayName: String(item.displayName ?? ''),
						groupDisplayName: item.groupDisplayName as string | undefined,
						valueType: String(item.valueType ?? 'BOOL'),
						deprecated: item.deprecated === true,
					})
				}
				pageToken = data?.nextPageToken ?? ''
			} while (pageToken)
			return out
		},
		async getAttributes(name) {
			assertLocationName(name)
			const data = await call<{
				attributes?: Array<{
					name: string
					values?: unknown[]
					uriValues?: Array<{ uri: string }>
				}>
			}>(url(BUSINESS_INFO, `${name}/attributes`))
			const out: AttributeValues = {}
			for (const attribute of data?.attributes ?? []) {
				const first = attribute.values?.[0]
				if (typeof first === 'boolean') out[attribute.name] = first
				else if (attribute.uriValues?.[0]) {
					out[attribute.name] = attribute.uriValues[0].uri
				}
			}
			return out
		},
		async updateAttributes(name, values) {
			assertLocationName(name)
			// `null` clears the attribute (Google takes an empty value list).
			const attributes = Object.entries(values).map(([attribute, value]) =>
				value === null
					? { name: attribute, values: [] }
					: typeof value === 'string'
						? { name: attribute, uriValues: [{ uri: value }] }
						: { name: attribute, values: [value === true] },
			)
			await call(
				url(BUSINESS_INFO, `${name}/attributes`, {
					attributeMask: Object.keys(values).join(','),
				}),
				{
					method: 'PATCH',
					body: JSON.stringify({ name: `${name}/attributes`, attributes }),
				},
			)
			const updated = await call<{ pendingMask?: string }>(
				url(BUSINESS_INFO, `${name}:getGoogleUpdated`, { readMask: 'name' }),
			).catch(() => null)
			return {
				status: (updated?.pendingMask ?? '').includes('attributes')
					? 'pending'
					: 'accepted',
			}
		},

		async publishFoodMenus(accountName, name, body) {
			assertAccountName(accountName)
			assertLocationName(name)
			await call(
				url(MY_BUSINESS_V4, `${accountName}/${name}/foodMenus`, {
					updateMask: 'menus',
				}),
				{
					method: 'PATCH',
					body: JSON.stringify({
						name: `${accountName}/${name}/foodMenus`,
						...body,
					}),
				},
			)
		},
		async uploadMedia(accountName, name, input) {
			assertAccountName(accountName)
			assertLocationName(name)
			const data = await call<{ name?: string; googleUrl?: string }>(
				url(MY_BUSINESS_V4, `${accountName}/${name}/media`),
				{
					method: 'POST',
					body: JSON.stringify({
						mediaFormat: 'PHOTO',
						locationAssociation: { category: input.category },
						sourceUrl: input.sourceUrl,
					}),
				},
			)
			return { name: data?.name ?? '', googleUrl: data?.googleUrl }
		},
		async deleteMedia(mediaName) {
			await call(url(MY_BUSINESS_V4, mediaName), { method: 'DELETE' })
		},

		async createLocalPost(accountName, name, body) {
			assertAccountName(accountName)
			assertLocationName(name)
			const data = await call<Record<string, unknown>>(
				url(MY_BUSINESS_V4, `${accountName}/${name}/localPosts`),
				{ method: 'POST', body: JSON.stringify(body) },
			)
			return {
				name: String(data?.name ?? ''),
				state: String(data?.state ?? 'PROCESSING'),
				searchUrl: data?.searchUrl as string | undefined,
			}
		},
		async getLocalPost(postName) {
			const data = await call<Record<string, unknown>>(
				url(MY_BUSINESS_V4, postName),
			)
			const rejection = data?.rejectionReason ?? data?.state
			return {
				name: postName,
				state: String(data?.state ?? 'PROCESSING'),
				searchUrl: data?.searchUrl as string | undefined,
				rejectionReason:
					data?.state === 'REJECTED' ? String(rejection ?? '') : undefined,
			}
		},
		async deleteLocalPost(postName) {
			await call(url(MY_BUSINESS_V4, postName), { method: 'DELETE' })
		},

		async fetchDailyMetrics(name, start, end) {
			assertLocationName(name)
			const metrics = [
				'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
				'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
				'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
				'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
				'CALL_CLICKS',
				'BUSINESS_DIRECTION_REQUESTS',
				'WEBSITE_CLICKS',
				'BUSINESS_FOOD_ORDERS',
				'BUSINESS_BOOKINGS',
				'BUSINESS_CONVERSATIONS',
			]
			const built = url(PERFORMANCE, `${name}:fetchMultiDailyMetricsTimeSeries`)
			for (const metric of metrics)
				built.searchParams.append('dailyMetrics', metric)
			const from = dateParts(start)
			const to = dateParts(end)
			built.searchParams.set('dailyRange.startDate.year', String(from.year))
			built.searchParams.set('dailyRange.startDate.month', String(from.month))
			built.searchParams.set('dailyRange.startDate.day', String(from.day))
			built.searchParams.set('dailyRange.endDate.year', String(to.year))
			built.searchParams.set('dailyRange.endDate.month', String(to.month))
			built.searchParams.set('dailyRange.endDate.day', String(to.day))
			const data = await call<{
				multiDailyMetricTimeSeries?: Array<{
					dailyMetricTimeSeries?: Array<{
						dailyMetric?: string
						timeSeries?: {
							datedValues?: Array<{
								date?: { year: number; month: number; day: number }
								value?: string
							}>
						}
					}>
				}>
			}>(built)
			const out: DailyMetricSeries = []
			for (const group of data?.multiDailyMetricTimeSeries ?? []) {
				for (const series of group.dailyMetricTimeSeries ?? []) {
					for (const dated of series.timeSeries?.datedValues ?? []) {
						if (!series.dailyMetric || !dated.date) continue
						out.push({
							metric: series.dailyMetric,
							date: `${String(dated.date.year).padStart(4, '0')}-${String(dated.date.month).padStart(2, '0')}-${String(dated.date.day).padStart(2, '0')}`,
							// Google omits `value` for a zero day.
							value: Number(dated.value ?? 0) || 0,
						})
					}
				}
			}
			return out
		},
		async listSearchKeywords(name, month) {
			assertLocationName(name)
			const [year, monthNumber] = month.split('-').map(Number)
			const out: SearchKeywordCount[] = []
			let pageToken = ''
			do {
				const built = url(
					PERFORMANCE,
					`${name}/searchkeywords/impressions/monthly`,
					{
						'monthlyRange.startMonth.year': String(year),
						'monthlyRange.startMonth.month': String(monthNumber),
						'monthlyRange.endMonth.year': String(year),
						'monthlyRange.endMonth.month': String(monthNumber),
						pageSize: '100',
						...(pageToken ? { pageToken } : {}),
					},
				)
				const data = await call<{
					searchKeywordsCounts?: Array<{
						searchKeyword?: string
						insightsValue?: { value?: string; threshold?: string }
					}>
					nextPageToken?: string
				}>(built)
				for (const item of data?.searchKeywordsCounts ?? []) {
					if (!item.searchKeyword) continue
					out.push({
						keyword: item.searchKeyword,
						value:
							item.insightsValue?.value !== undefined
								? Number(item.insightsValue.value)
								: null,
						threshold:
							item.insightsValue?.threshold !== undefined
								? Number(item.insightsValue.threshold)
								: null,
					})
				}
				pageToken = data?.nextPageToken ?? ''
			} while (pageToken && out.length < 300)
			return out
		},
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type ClientFactory = (integration: Integration) => Promise<GbpClient>

let clientFactoryOverride: ClientFactory | null = null

/** Tests replace the Google client; `null` restores the default. */
export function setGbpClientFactory(factory: ClientFactory | null) {
	clientFactoryOverride = factory
}

/**
 * The client for a connected integration: the test factory, the mock (local
 * development without Google credentials), or the live client with a fresh
 * access token. A token that cannot be refreshed is `gbp_token_expired`.
 */
export async function gbpClientFor(
	integration: Integration,
): Promise<GbpClient> {
	if (clientFactoryOverride) return clientFactoryOverride(integration)
	if (isGoogleBusinessProfileMockMode()) return mockGbpClient()
	const token = await tokenManager.getValidAccessToken(
		integration,
		new GoogleBusinessProfileProvider(),
	)
	if (!token) throw new GbpError('gbp_token_expired', 401)
	return googleGbpClient(token)
}
