import { type PeopleAccess } from './people-access.ts'

/**
 * Browser-direct client for tenant-api `/operator/people`. The App only mints
 * the short-lived token (`/:org/people-token`); people data never transits it.
 */

export const PEOPLE_PAGE_SIZE = 50
export const LAPSED_DAYS = 90

export const PEOPLE_SORTS = ['recent', 'name', 'visits', 'last_visit'] as const
export type PeopleSort = (typeof PEOPLE_SORTS)[number]

export type PersonStatus = 'signed_in' | 'guest_no_sign_in' | 'unverified'

export type PersonTag = {
	id: string
	name: string
	category: string
	colorToken: string
	sensitive: boolean
	system: boolean
}

export type PersonRow = {
	key: string
	kind: 'customer' | 'guest'
	name: string
	phone: string | null
	email: string | null
	status: PersonStatus
	signedIn: boolean
	hasDining: boolean
	customerLinked: boolean
	walkIn: boolean
	dining: {
		visits: number
		covers: number
		noShows: number
		lastVisitAt: number | null
		nextBookingAt: number | null
	} | null
	orders: { count: number; lastOrderAt: number | null } | null
	flags: { vip: boolean; allergy: boolean | null; noShowRisk: boolean }
	tags: PersonTag[]
	createdAt: number
	lastActivityAt: number
}

export type PeoplePage = {
	people: PersonRow[]
	nextCursor: string | null
	total: number
	hasOrders: boolean
	walkInCount: number | null
}

export type PeopleQuickFilter =
	| 'vip'
	| 'allergy'
	| 'lapsed'
	| 'upcoming'
	| 'signed_in'
	| 'guest_only'
	| 'walk_ins'

export type PeopleListParams = {
	q?: string
	filters: ReadonlySet<PeopleQuickFilter>
	/** Only people with reservation history (merge candidates). */
	hasDining?: boolean
	sort?: PeopleSort
	cursor?: string | null
}

export type PersonNote = {
	id: string
	body: string
	pinned: boolean
	createdAt: number
}

export type PersonVisit = {
	id: string
	locationId: string
	businessDate: string
	localStartMin: number
	partySize: number
	status: string
	channel: string
	lateCancel: boolean
	serviceName: string | null
	guestRequests: string | null
	dietaryNotes: string | null
}

export type PersonSubscription = {
	topic: string
	channel: string
	subscribed: boolean
	subscribedAt: number
	unsubscribedAt: number | null
	source: string
}

export type PersonProfile = {
	key: string
	canonicalKey: string
	kind: 'customer' | 'guest'
	status: PersonStatus
	signedIn: boolean
	customerLinked: boolean
	walkIn: boolean
	name: string
	phone: string | null
	email: string | null
	customer: {
		id: string
		name: string
		email: string | null
		phone: string | null
		phoneVerified: boolean
		createdAt: number
		orders: { count: number; lastOrderAt: number | null }
	} | null
	dining: {
		guest: {
			id: string
			firstName: string
			lastName: string
			phone: string | null
			email: string | null
			locale: string
			allergyNotes: string | null
			hasAllergy: boolean | null
			visits: number
			covers: number
			noShows: number
			lateCancels: number
			cancels: number
			firstVisitAt: number | null
			lastVisitAt: number | null
			version: number
			tags: PersonTag[]
		}
		nextBookingAt: number | null
		notes: PersonNote[]
		pinnedNotes: Array<{ id: string; body: string }>
		reservations: PersonVisit[]
	} | null
	marketing: { subscriptions: PersonSubscription[] } | null
	access: PeopleAccess
}

export class PeopleApiError extends Error {
	status: number
	code: string | null
	/** The error body, in the shape the shared error helpers read. */
	body: { error: string } | null
	constructor(message: string, status: number, code: string | null) {
		super(message)
		this.name = 'PeopleApiError'
		this.status = status
		this.code = code
		this.body = code ? { error: code } : null
	}
}

export type PeopleRequestOptions = {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
	query?: Record<string, string | number | boolean | undefined | null>
	body?: unknown
	signal?: AbortSignal
}

export type PeopleClient = {
	request<T = unknown>(path: string, options?: PeopleRequestOptions): Promise<T>
}

type TokenResponse = { jwt: string; tenantApiUrl: string; expiresAt: number }
const REFRESH_SKEW_MS = 30_000

export function createPeopleClient({
	orgSlug,
	fetchImpl = (...args) => fetch(...args),
}: {
	orgSlug: string
	fetchImpl?: typeof fetch
}): PeopleClient {
	let cached: TokenResponse | null = null
	let inFlight: Promise<TokenResponse> | null = null

	async function token(): Promise<TokenResponse> {
		if (cached && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) return cached
		if (inFlight) return inFlight
		inFlight = fetchImpl(`/${encodeURIComponent(orgSlug)}/people-token`, {
			headers: { Accept: 'application/json' },
			credentials: 'same-origin',
			cache: 'no-store',
		})
			.then(async (response) => {
				if (!response.ok) {
					throw new PeopleApiError(
						'Unable to authorize customers.',
						response.status,
						null,
					)
				}
				const body = (await response.json()) as TokenResponse
				cached = body
				return body
			})
			.finally(() => {
				inFlight = null
			})
		return inFlight
	}

	return {
		async request<T>(path: string, options: PeopleRequestOptions = {}) {
			const send = async () => {
				const { jwt, tenantApiUrl } = await token()
				const url = new URL(
					`${tenantApiUrl.replace(/\/+$/, '')}/operator/people${path}`,
				)
				for (const [k, v] of Object.entries(options.query ?? {})) {
					if (v !== undefined && v !== null && v !== '') {
						url.searchParams.set(k, String(v))
					}
				}
				const headers: Record<string, string> = {
					Accept: 'application/json',
					Authorization: `Bearer ${jwt}`,
				}
				if (options.body !== undefined)
					headers['Content-Type'] = 'application/json'
				return fetchImpl(url.toString(), {
					method: options.method ?? 'GET',
					headers,
					body:
						options.body === undefined
							? undefined
							: JSON.stringify(options.body),
					cache: 'no-store',
					signal: options.signal,
				})
			}
			let response = await send()
			if (response.status === 401) {
				cached = null
				response = await send()
			}
			if (!response.ok) {
				const detail = (await response.json().catch(() => null)) as {
					error?: unknown
					message?: unknown
				} | null
				const code = typeof detail?.error === 'string' ? detail.error : null
				throw new PeopleApiError(
					typeof detail?.message === 'string'
						? detail.message
						: (code ?? `People API error (${response.status})`),
					response.status,
					code,
				)
			}
			return (await response.json()) as T
		},
	}
}

const clients = new Map<string, PeopleClient>()

/** One client per organization for the life of the page, so the token is shared. */
export function getPeopleClient(orgSlug: string): PeopleClient {
	let client = clients.get(orgSlug)
	if (!client) {
		client = createPeopleClient({ orgSlug })
		clients.set(orgSlug, client)
	}
	return client
}

export function listQuery(params: PeopleListParams) {
	const f = params.filters
	return {
		q: params.q?.trim() || undefined,
		vip: f.has('vip') ? 1 : undefined,
		allergy: f.has('allergy') ? 1 : undefined,
		lapsed: f.has('lapsed') ? 1 : undefined,
		lapsedDays: f.has('lapsed') ? LAPSED_DAYS : undefined,
		upcoming: f.has('upcoming') ? 1 : undefined,
		account: f.has('signed_in')
			? 'signed_in'
			: f.has('guest_only')
				? 'guest_only'
				: undefined,
		includeWalkIns: f.has('walk_ins') ? 1 : undefined,
		hasDining: params.hasDining ? 1 : undefined,
		sort: params.sort,
		cursor: params.cursor || undefined,
		limit: PEOPLE_PAGE_SIZE,
	}
}

export async function fetchPeoplePage(
	client: PeopleClient,
	params: PeopleListParams,
	signal?: AbortSignal,
): Promise<PeoplePage> {
	const raw = await client.request<{
		people: PersonRow[]
		nextCursor: string | null
		total: number
		meta?: { hasOrders?: boolean; walkInCount?: number | null }
	}>('', { query: listQuery(params), signal })
	return {
		people: raw.people ?? [],
		nextCursor: raw.nextCursor ?? null,
		total: raw.total ?? 0,
		hasOrders: Boolean(raw.meta?.hasOrders),
		walkInCount: raw.meta?.walkInCount ?? null,
	}
}

export async function fetchPerson(
	client: PeopleClient,
	key: string,
	signal?: AbortSignal,
): Promise<PersonProfile> {
	return client.request<PersonProfile>(`/${encodeURIComponent(key)}`, {
		signal,
	})
}

export type PersonPatch = {
	name?: string
	email?: string | null
	phone?: string | null
	allergyNotes?: string | null
	expectedVersion?: number
}

export async function updatePerson(
	client: PeopleClient,
	key: string,
	patch: PersonPatch,
): Promise<PersonProfile> {
	return client.request<PersonProfile>(`/${encodeURIComponent(key)}`, {
		method: 'PATCH',
		body: patch,
	})
}

export async function fetchPeopleTags(
	client: PeopleClient,
	signal?: AbortSignal,
): Promise<PersonTag[]> {
	const raw = await client.request<{ tags: Array<Record<string, unknown>> }>(
		'/tags',
		{ signal },
	)
	return (raw.tags ?? []).map((t) => ({
		id: String(t.id),
		name: String(t.name),
		category: String(t.category ?? 'custom'),
		colorToken: String(t.colorToken ?? 'neutral'),
		sensitive: Boolean(t.sensitive),
		system: t.systemKey != null || t.category === 'system',
	}))
}

export async function createPeopleTag(
	client: PeopleClient,
	input: { name: string },
): Promise<PersonTag> {
	const raw = await client.request<{ tag: Record<string, unknown> }>('/tags', {
		method: 'POST',
		body: { name: input.name.trim() },
	})
	return {
		id: String(raw.tag.id),
		name: String(raw.tag.name),
		category: String(raw.tag.category ?? 'custom'),
		colorToken: String(raw.tag.colorToken ?? 'neutral'),
		sensitive: Boolean(raw.tag.sensitive),
		system: false,
	}
}

export async function assignPersonTag(
	client: PeopleClient,
	key: string,
	tagId: string,
): Promise<void> {
	await client.request(`/${encodeURIComponent(key)}/tags`, {
		method: 'POST',
		body: { tagId },
	})
}

export async function removePersonTag(
	client: PeopleClient,
	key: string,
	tagId: string,
): Promise<void> {
	await client.request(
		`/${encodeURIComponent(key)}/tags/${encodeURIComponent(tagId)}`,
		{ method: 'DELETE' },
	)
}

export async function addPersonNote(
	client: PeopleClient,
	key: string,
	input: { body: string; pinned?: boolean },
): Promise<void> {
	await client.request(`/${encodeURIComponent(key)}/notes`, {
		method: 'POST',
		body: input,
	})
}

export async function updatePersonNote(
	client: PeopleClient,
	key: string,
	noteId: string,
	patch: { body?: string; pinned?: boolean },
): Promise<void> {
	await client.request(
		`/${encodeURIComponent(key)}/notes/${encodeURIComponent(noteId)}`,
		{ method: 'PATCH', body: patch },
	)
}

export async function deletePersonNote(
	client: PeopleClient,
	key: string,
	noteId: string,
): Promise<void> {
	await client.request(
		`/${encodeURIComponent(key)}/notes/${encodeURIComponent(noteId)}`,
		{ method: 'DELETE' },
	)
}

export async function mergePeople(
	client: PeopleClient,
	input: { keepKey: string; mergeKey: string; keepVersion?: number },
): Promise<{ key: string }> {
	return client.request<{ key: string }>('/merge', {
		method: 'POST',
		body: input,
	})
}

export async function exportPerson(
	client: PeopleClient,
	key: string,
	includeSensitive: boolean,
): Promise<unknown> {
	return client.request(`/${encodeURIComponent(key)}/export`, {
		query: { includeSensitive: includeSensitive ? '1' : undefined },
	})
}

export type ErasePersonResult = {
	guestsErased: number
	customersErased: number
	ordersScrubbed: number
	cancelledFutureReservations: number
}

export async function erasePerson(
	client: PeopleClient,
	key: string,
): Promise<ErasePersonResult> {
	return client.request<ErasePersonResult>(
		`/${encodeURIComponent(key)}/erase`,
		{ method: 'POST', body: {} },
	)
}

export type PersonOrder = {
	id: string
	number: string
	status: string
	paymentStatus: string
	fulfillment: string
	currency: string
	totalCents: number
	itemCount: number
	createdAt: string | null
	/** `customer`: bound at checkout. `phone`: matched by the verified phone. */
	matchedBy: 'customer' | 'phone'
}

export type PersonOrdersPage = {
	orders: PersonOrder[]
	nextCursor: string | null
	totals: {
		count: number
		spend: Array<{ currency: string; cents: number }>
	}
}

export const PERSON_ORDERS_PAGE_SIZE = 20

/** One page of a customer's orders, newest first (keyset `cursor`). */
export async function fetchPersonOrders(
	client: PeopleClient,
	key: string,
	cursor?: string | null,
	signal?: AbortSignal,
): Promise<PersonOrdersPage> {
	const raw = await client.request<Partial<PersonOrdersPage>>(
		`/${encodeURIComponent(key)}/orders`,
		{
			query: { cursor: cursor || undefined, limit: PERSON_ORDERS_PAGE_SIZE },
			signal,
		},
	)
	return {
		orders: raw.orders ?? [],
		nextCursor: raw.nextCursor ?? null,
		totals: raw.totals ?? { count: 0, spend: [] },
	}
}
