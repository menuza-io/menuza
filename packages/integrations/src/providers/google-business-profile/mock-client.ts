/**
 * The stateful Google Business Profile mock (`MOCKS=true`, or `MOCK_`
 * credentials). It keeps one fake Google listing per location name in memory
 * and answers like Google: an accepted edit, an edit held for review, a refused
 * edit, a verification with a code, place action links, a menu, media, posts
 * and daily metrics. Every call is recorded (`gbpMockCalls`) so a test can
 * assert the exact `updateMask` and body that would have gone to Google.
 *
 * Triggers (documented in docs/google-business-profile.md):
 *  - changing `title`, `storefrontAddress` or `categories` is held for review;
 *  - the phone `+1-555-0000` and a description containing `mock-reject` are
 *    refused; a description containing `mock-pending` is held for review;
 *  - verification code `123456` completes, any other code fails;
 *  - a post whose text contains `mock-reject` is rejected, `mock-pending`
 *    stays `PROCESSING` until read twice.
 */
import {
	type GoogleAttributeMeta,
	type VerificationMethod,
	GbpError,
} from '@repo/common/gbp-listing'
import { type PlaceActionType } from '@repo/common/ordering-providers'
import {
	type AttributeValues,
	type DailyMetricSeries,
	type FoodMenusBody,
	type GbpClient,
	type GbpListing,
	type GbpMediaItem,
	type LocalPost,
	type LocalPostBody,
	type PlaceActionLink,
	type SearchKeywordCount,
	type VerificationRecord,
	type VoiceOfMerchantState,
} from './client'

export type GbpMockCall = {
	method: string
	args: unknown[]
}

export const gbpMockCalls: GbpMockCall[] = []

export const MOCK_VERIFICATION_CODE = '123456'

type MockLocationState = {
	listing: GbpListing
	pendingMask: string[]
	verified: boolean
	suspended: boolean
	accessLost: boolean
	verification: VerificationRecord | null
	links: PlaceActionLink[]
	attributes: AttributeValues
	foodMenus: FoodMenusBody | null
	media: Array<{ name: string; category: string; sourceUrl: string }>
	posts: Map<string, { body: LocalPostBody; state: string; reads: number }>
	counters: { link: number; media: number; post: number; verification: number }
}

const states = new Map<string, MockLocationState>()

function seedListing(name: string): GbpListing {
	return {
		name,
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
		specialHours: { specialHourPeriods: [] },
		openInfo: { status: 'OPEN' },
		categories: { primaryCategory: { displayName: 'Restaurant' } },
		profile: {
			description: 'A sample restaurant for offline GBP development.',
		},
	}
}

function stateFor(name: string): MockLocationState {
	let state = states.get(name)
	if (!state) {
		state = {
			listing: seedListing(name),
			pendingMask: [],
			verified: true,
			suspended: false,
			accessLost: false,
			verification: null,
			links: [
				{
					name: `${name}/placeActionLinks/seed-1`,
					uri: 'https://www.ubereats.com/store/menuza-demo-bistro/abc',
					placeActionType: 'FOOD_ORDERING',
					isPreferred: true,
					isEditable: true,
					providerType: 'MERCHANT',
				},
				{
					name: `${name}/placeActionLinks/seed-2`,
					uri: 'https://order.doordash.com/store/menuza-demo-bistro',
					placeActionType: 'FOOD_DELIVERY',
					isPreferred: false,
					isEditable: false,
					providerType: 'AGGREGATOR_3P',
				},
			],
			attributes: {
				'attributes/has_delivery': false,
				'attributes/has_takeout': true,
			},
			foodMenus: null,
			media: [],
			posts: new Map(),
			counters: { link: 2, media: 0, post: 0, verification: 0 },
		}
		states.set(name, state)
	}
	return state
}

/** Test and dev helpers: reset, or force a state the real API would report. */
export function resetGbpMock() {
	states.clear()
	gbpMockCalls.length = 0
}

export function setGbpMockState(
	name: string,
	patch: Partial<
		Pick<MockLocationState, 'verified' | 'suspended' | 'accessLost' | 'listing'>
	>,
) {
	Object.assign(stateFor(name), patch)
}

export function readGbpMockState(name: string) {
	return stateFor(name)
}

function record(method: string, ...args: unknown[]) {
	gbpMockCalls.push({ method, args })
}

function guardAccess(state: MockLocationState) {
	if (state.accessLost) throw new GbpError('gbp_access_lost', 403)
	if (state.suspended) throw new GbpError('gbp_suspended', 403)
}

function guardVerified(state: MockLocationState) {
	guardAccess(state)
	if (!state.verified) throw new GbpError('gbp_not_verified', 403)
}

const MOCK_ATTRIBUTES: GoogleAttributeMeta[] = [
	{
		name: 'attributes/has_delivery',
		displayName: 'Delivery',
		groupDisplayName: 'Service options',
		valueType: 'BOOL',
	},
	{
		name: 'attributes/has_takeout',
		displayName: 'Takeout',
		groupDisplayName: 'Service options',
		valueType: 'BOOL',
	},
	{
		name: 'attributes/has_curbside_pickup',
		displayName: 'Curbside pickup',
		groupDisplayName: 'Service options',
		valueType: 'BOOL',
	},
	{
		name: 'attributes/has_dine_in',
		displayName: 'Dine-in',
		groupDisplayName: 'Service options',
		valueType: 'BOOL',
	},
	{
		name: 'attributes/accepts_reservations',
		displayName: 'Accepts reservations',
		groupDisplayName: 'Dining options',
		valueType: 'BOOL',
	},
	{
		name: 'attributes/has_outdoor_seating',
		displayName: 'Outdoor seating',
		groupDisplayName: 'Dining options',
		valueType: 'BOOL',
	},
	{
		name: 'attributes/wheelchair_accessible_entrance',
		displayName: 'Wheelchair accessible entrance',
		groupDisplayName: 'Accessibility',
		valueType: 'BOOL',
	},
	{
		name: 'attributes/pay_credit_card',
		displayName: 'Credit cards',
		groupDisplayName: 'Payments',
		valueType: 'BOOL',
	},
	{
		name: 'attributes/serves_halal_food',
		displayName: 'Halal food',
		groupDisplayName: 'Offerings',
		valueType: 'BOOL',
	},
	{
		name: 'attributes/url_menu',
		displayName: 'Menu link',
		groupDisplayName: 'Links',
		valueType: 'URL',
	},
]

const MOCK_METRICS = [
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

/** Deterministic daily figures: the same day always gives the same number. */
function mockMetricValue(metric: string, date: string): number {
	let hash = 7
	for (const char of `${metric}:${date}`)
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0
	const base = metric.startsWith('BUSINESS_IMPRESSIONS') ? 40 : 4
	return base + (hash % (base * 2))
}

/** Google's data runs a few days late: the mock ends 3 days before today. */
export const MOCK_METRICS_LAG_DAYS = 3

export function mockGbpClient(): GbpClient {
	return {
		async getListing(name) {
			record('getListing', name)
			const state = stateFor(name)
			guardAccess(state)
			return structuredClone(state.listing)
		},
		async patchListing(name, updateMask, body) {
			record('patchListing', name, updateMask, structuredClone(body))
			const state = stateFor(name)
			guardVerified(state)
			const fields = updateMask.split(',')
			const phone = body.phoneNumbers?.primaryPhone
			if (fields.includes('phoneNumbers') && phone === '+1-555-0000') {
				throw new GbpError(
					'gbp_rejected',
					400,
					'That phone number is not valid.',
				)
			}
			const description = body.profile?.description ?? ''
			if (fields.includes('profile.description')) {
				if (description.includes('mock-reject')) {
					throw new GbpError(
						'gbp_rejected',
						400,
						'Description breaks Google guidelines.',
					)
				}
			}
			const held =
				fields.some((field) =>
					['title', 'storefrontAddress', 'categories'].includes(field),
				) ||
				(fields.includes('profile.description') &&
					description.includes('mock-pending'))
			for (const field of fields) {
				const [top, child] = field.split('.')
				if (!top) continue
				const listing = state.listing as Record<string, unknown>
				const incoming = (body as Record<string, unknown>)[top]
				if (child && incoming && typeof incoming === 'object') {
					listing[top] = {
						...((listing[top] as object | undefined) ?? {}),
						[child]: (incoming as Record<string, unknown>)[child],
					}
				} else {
					listing[top] = structuredClone(incoming)
				}
			}
			if (held) {
				state.pendingMask = [...new Set([...state.pendingMask, ...fields])]
				return { status: 'pending', listing: structuredClone(state.listing) }
			}
			state.pendingMask = state.pendingMask.filter((f) => !fields.includes(f))
			return { status: 'accepted', listing: structuredClone(state.listing) }
		},
		async getGoogleUpdated(name) {
			record('getGoogleUpdated', name)
			const state = stateFor(name)
			guardAccess(state)
			return {
				listing: structuredClone(state.listing),
				diffMask: '',
				pendingMask: state.pendingMask.join(','),
			}
		},

		async getVoiceOfMerchantState(name): Promise<VoiceOfMerchantState> {
			record('getVoiceOfMerchantState', name)
			const state = stateFor(name)
			return {
				hasVoiceOfMerchant:
					state.verified && !state.suspended && !state.accessLost,
				hasBusinessAuthority: !state.accessLost,
				hasPendingVerification: state.verification?.state === 'PENDING',
				suspended: state.suspended,
				ownershipConflict: state.accessLost,
			}
		},
		async fetchVerificationOptions(name, languageCode) {
			record('fetchVerificationOptions', name, languageCode)
			const state = stateFor(name)
			guardAccess(state)
			return [
				{
					method: 'ADDRESS' as const,
					destination: '123 Demo Street, Chicago, IL',
				},
				{ method: 'PHONE_CALL' as const, destination: '+1-555-0100' },
				{ method: 'EMAIL' as const, destination: 'owner@example.com' },
			]
		},
		async startVerification(name, input) {
			record('startVerification', name, input)
			const state = stateFor(name)
			guardAccess(state)
			state.counters.verification += 1
			state.verification = {
				name: `${name}/verifications/mock-${state.counters.verification}`,
				method: input.method as VerificationMethod,
				state: 'PENDING',
				createTime: new Date().toISOString(),
			}
			return { ...state.verification }
		},
		async completeVerification(verificationName, pin) {
			record('completeVerification', verificationName, pin)
			const name = verificationName.replace(/\/verifications\/.*$/, '')
			const state = stateFor(name)
			if (pin !== MOCK_VERIFICATION_CODE) {
				throw new GbpError('gbp_rejected', 400, 'That code is not right.')
			}
			state.verified = true
			state.verification = {
				name: verificationName,
				method: state.verification?.method ?? 'ADDRESS',
				state: 'COMPLETED',
			}
			return { ...state.verification }
		},
		async listVerifications(name) {
			record('listVerifications', name)
			const state = stateFor(name)
			return state.verification ? [{ ...state.verification }] : []
		},

		async listPlaceActionLinks(name) {
			record('listPlaceActionLinks', name)
			const state = stateFor(name)
			guardAccess(state)
			return state.links.map((link) => ({ ...link }))
		},
		async createPlaceActionLink(
			name,
			input: {
				uri: string
				placeActionType: PlaceActionType
				isPreferred: boolean
			},
		) {
			record('createPlaceActionLink', name, input)
			const state = stateFor(name)
			guardVerified(state)
			state.counters.link += 1
			const link: PlaceActionLink = {
				name: `${name}/placeActionLinks/mock-${state.counters.link}`,
				uri: input.uri,
				placeActionType: input.placeActionType,
				isPreferred: input.isPreferred,
				isEditable: true,
				providerType: 'MERCHANT',
			}
			if (input.isPreferred) {
				for (const other of state.links) {
					if (other.placeActionType === input.placeActionType)
						other.isPreferred = false
				}
			}
			state.links.push(link)
			return { ...link }
		},
		async patchPlaceActionLink(linkName, input) {
			record('patchPlaceActionLink', linkName, input)
			const name = linkName.replace(/\/placeActionLinks\/.*$/, '')
			const state = stateFor(name)
			guardVerified(state)
			const link = state.links.find((item) => item.name === linkName)
			if (!link) throw new GbpError('gbp_api_error', 404)
			if (!link.isEditable)
				throw new GbpError(
					'gbp_rejected',
					403,
					'Google partners manage this link.',
				)
			if (input.uri !== undefined) link.uri = input.uri
			if (input.isPreferred !== undefined) {
				link.isPreferred = input.isPreferred
				if (input.isPreferred) {
					for (const other of state.links) {
						if (
							other !== link &&
							other.placeActionType === link.placeActionType
						) {
							other.isPreferred = false
						}
					}
				}
			}
			return { ...link }
		},
		async deletePlaceActionLink(linkName) {
			record('deletePlaceActionLink', linkName)
			const name = linkName.replace(/\/placeActionLinks\/.*$/, '')
			const state = stateFor(name)
			guardVerified(state)
			const link = state.links.find((item) => item.name === linkName)
			if (link && !link.isEditable) {
				throw new GbpError(
					'gbp_rejected',
					403,
					'Google partners manage this link.',
				)
			}
			state.links = state.links.filter((item) => item.name !== linkName)
		},

		async listAttributeMetadata(name) {
			record('listAttributeMetadata', name)
			guardAccess(stateFor(name))
			return MOCK_ATTRIBUTES.map((attribute) => ({ ...attribute }))
		},
		async getAttributes(name) {
			record('getAttributes', name)
			const state = stateFor(name)
			guardAccess(state)
			return { ...state.attributes }
		},
		async updateAttributes(name, values) {
			record('updateAttributes', name, structuredClone(values))
			const state = stateFor(name)
			guardVerified(state)
			for (const [key, value] of Object.entries(values)) {
				if (value === null) delete state.attributes[key]
				else state.attributes[key] = value
			}
			return { status: 'accepted' }
		},

		async publishFoodMenus(accountName, name, body) {
			record('publishFoodMenus', accountName, name, structuredClone(body))
			const state = stateFor(name)
			guardVerified(state)
			state.foodMenus = structuredClone(body)
		},
		async uploadMedia(accountName, name, input): Promise<GbpMediaItem> {
			record('uploadMedia', accountName, name, input)
			const state = stateFor(name)
			guardVerified(state)
			state.counters.media += 1
			const media = {
				name: `${accountName}/${name}/media/mock-${state.counters.media}`,
				category: input.category,
				sourceUrl: input.sourceUrl,
			}
			state.media.push(media)
			return { name: media.name }
		},
		async deleteMedia(mediaName) {
			record('deleteMedia', mediaName)
			for (const state of states.values()) {
				state.media = state.media.filter((item) => item.name !== mediaName)
			}
		},

		async createLocalPost(accountName, name, body): Promise<LocalPost> {
			record('createLocalPost', accountName, name, structuredClone(body))
			const state = stateFor(name)
			guardVerified(state)
			state.counters.post += 1
			const postName = `${accountName}/${name}/localPosts/mock-${state.counters.post}`
			const summary = String(body.summary ?? '')
			const initial = summary.includes('mock-reject')
				? 'REJECTED'
				: summary.includes('mock-pending')
					? 'PROCESSING'
					: 'LIVE'
			state.posts.set(postName, {
				body: structuredClone(body),
				state: initial,
				reads: 0,
			})
			return {
				name: postName,
				state: initial,
				searchUrl: `https://google.example/posts/${state.counters.post}`,
			}
		},
		async getLocalPost(postName): Promise<LocalPost> {
			record('getLocalPost', postName)
			const name = postName
				.replace(/^accounts\/[^/]+\//, '')
				.replace(/\/localPosts\/.*$/, '')
			const state = stateFor(name)
			const post = state.posts.get(postName)
			if (!post) throw new GbpError('gbp_api_error', 404)
			post.reads += 1
			if (post.state === 'PROCESSING' && post.reads >= 2) post.state = 'LIVE'
			return {
				name: postName,
				state: post.state,
				rejectionReason:
					post.state === 'REJECTED'
						? 'The post breaks Google guidelines.'
						: undefined,
			}
		},
		async deleteLocalPost(postName) {
			record('deleteLocalPost', postName)
			for (const state of states.values()) state.posts.delete(postName)
		},

		async fetchDailyMetrics(name, start, end): Promise<DailyMetricSeries> {
			record('fetchDailyMetrics', name, start, end)
			guardVerified(stateFor(name))
			const out: DailyMetricSeries = []
			const last = new Date(Date.now() - MOCK_METRICS_LAG_DAYS * 86_400_000)
				.toISOString()
				.slice(0, 10)
			for (
				let day = new Date(`${start}T00:00:00Z`);
				day <= new Date(`${end}T00:00:00Z`);
				day = new Date(day.getTime() + 86_400_000)
			) {
				const date = day.toISOString().slice(0, 10)
				if (date > last) break
				for (const metric of MOCK_METRICS) {
					out.push({ metric, date, value: mockMetricValue(metric, date) })
				}
			}
			return out
		},
		async listSearchKeywords(name, month): Promise<SearchKeywordCount[]> {
			record('listSearchKeywords', name, month)
			guardVerified(stateFor(name))
			return [
				{ keyword: 'lebanese restaurant', value: 120, threshold: null },
				{ keyword: 'shawarma near me', value: 84, threshold: null },
				{ keyword: 'best falafel', value: null, threshold: 15 },
			]
		},
	}
}
