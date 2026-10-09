import { getOrgBinding } from '~/lib/client-auth'

/**
 * Delivery address lookup and coverage quotes. Calls go from the browser to
 * the regional tenant-api only: the typed address never transits Sites SSR
 * or Google directly (docs/tenant-data-residency.md).
 */

export type PlacePrediction = {
	placeId: string
	mainText: string
	secondaryText: string
}

export type QuoteAddress = {
	formatted: string
	line1: string
	unit?: string
	city: string
	state?: string
	postalCode?: string
	country?: string
	lat: number
	lng: number
}

export type DeliveryQuote = {
	token: string
	expiresAt: string
	address: QuoteAddress
	zoneId: string
	zoneName: string
	deliveryFee: number
	minimumOrder: number
	eta: { min: number; max: number }
}

export type DeliveryUnavailableReason =
	| 'delivery_disabled'
	| 'geocoding_unavailable'
	| 'store_location_missing'
	| 'no_zones'

export type DeliveryQuoteResult =
	| { status: 'deliverable'; quote: DeliveryQuote }
	| { status: 'out_of_range'; address: QuoteAddress | null }
	| { status: 'not_found' }
	| { status: 'unavailable'; reason: DeliveryUnavailableReason | string }

export class DeliveryRequestError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code)
		this.name = 'DeliveryRequestError'
	}
}

export const MIN_PLACES_QUERY_LENGTH = 3

function regionalUrl(): string {
	const url =
		typeof document === 'undefined'
			? undefined
			: document.documentElement.dataset.tenantApiUrl
	if (!url) throw new DeliveryRequestError('region_unavailable', 503)
	return url.replace(/\/$/, '')
}

function binding(): Record<string, string> {
	return typeof document === 'undefined' ? {} : { ...getOrgBinding() }
}

/** One Places session spans the keystrokes and the quote that ends it. */
export function createSessionToken(): string {
	if (
		typeof crypto !== 'undefined' &&
		typeof crypto.randomUUID === 'function'
	) {
		return crypto.randomUUID()
	}
	return Array.from({ length: 32 }, () =>
		Math.floor(Math.random() * 16).toString(16),
	).join('')
}

async function readJson(response: Response): Promise<unknown> {
	const value: unknown = await response.json().catch(() => null)
	if (!response.ok) {
		const code =
			value &&
			typeof value === 'object' &&
			'error' in value &&
			typeof value.error === 'string'
				? value.error
				: 'delivery_request_failed'
		throw new DeliveryRequestError(code, response.status)
	}
	return value
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value)

export function parsePredictions(value: unknown): PlacePrediction[] {
	if (!value || typeof value !== 'object') return []
	const list = (value as { predictions?: unknown }).predictions
	if (!Array.isArray(list)) return []
	return list.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') return []
		const e = entry as Record<string, unknown>
		if (!isString(e.placeId) || !e.placeId || !isString(e.mainText)) return []
		return [
			{
				placeId: e.placeId,
				mainText: e.mainText,
				secondaryText: isString(e.secondaryText) ? e.secondaryText : '',
			},
		]
	})
}

function parseAddress(value: unknown): QuoteAddress | null {
	if (!value || typeof value !== 'object') return null
	const a = value as Record<string, unknown>
	if (!isString(a.formatted) || !isString(a.line1)) return null
	const optional = (key: string) =>
		isString(a[key]) && a[key] ? { [key]: a[key] as string } : {}
	return {
		formatted: a.formatted,
		line1: a.line1,
		city: isString(a.city) ? a.city : '',
		lat: isNumber(a.lat) ? a.lat : 0,
		lng: isNumber(a.lng) ? a.lng : 0,
		...optional('unit'),
		...optional('state'),
		...optional('postalCode'),
		...optional('country'),
	}
}

/** Narrows the quote response; anything malformed is a request error. */
export function parseQuoteResult(value: unknown): DeliveryQuoteResult {
	if (!value || typeof value !== 'object') {
		throw new DeliveryRequestError('invalid_quote_response', 502)
	}
	const v = value as Record<string, unknown>
	switch (v.status) {
		case 'deliverable': {
			const q = v.quote as Record<string, unknown> | undefined
			const address = parseAddress(q?.address)
			const eta = q?.eta as Record<string, unknown> | undefined
			if (
				!q ||
				!address ||
				!isString(q.token) ||
				!isString(q.expiresAt) ||
				!isNumber(q.deliveryFee) ||
				!isNumber(q.minimumOrder) ||
				!eta ||
				!isNumber(eta.min) ||
				!isNumber(eta.max)
			) {
				throw new DeliveryRequestError('invalid_quote_response', 502)
			}
			return {
				status: 'deliverable',
				quote: {
					token: q.token,
					expiresAt: q.expiresAt,
					address,
					zoneId: isString(q.zoneId) ? q.zoneId : '',
					zoneName: isString(q.zoneName) ? q.zoneName : '',
					deliveryFee: q.deliveryFee,
					minimumOrder: q.minimumOrder,
					eta: { min: eta.min, max: eta.max },
				},
			}
		}
		case 'out_of_range':
			return { status: 'out_of_range', address: parseAddress(v.address) }
		case 'not_found':
			return { status: 'not_found' }
		case 'unavailable':
			return {
				status: 'unavailable',
				reason: isString(v.reason) ? v.reason : 'delivery_disabled',
			}
		default:
			throw new DeliveryRequestError('invalid_quote_response', 502)
	}
}

export async function fetchPlacePredictions(input: {
	locationId: string
	query: string
	sessionToken: string
	locale: string
	signal?: AbortSignal
}): Promise<PlacePrediction[]> {
	const query = input.query.trim()
	if (query.length < MIN_PLACES_QUERY_LENGTH) return []
	const params = new URLSearchParams(binding())
	params.set('locationId', input.locationId)
	params.set('q', query)
	params.set('sessionToken', input.sessionToken)
	params.set('lng', input.locale)
	const response = await fetch(
		`${regionalUrl()}/delivery/places?${params.toString()}`,
		{ cache: 'no-store', signal: input.signal },
	)
	return parsePredictions(await readJson(response))
}

export async function requestDeliveryQuote(input: {
	locationId: string
	placeId?: string
	address?: string
	unit?: string
	sessionToken?: string
	locale: string
	signal?: AbortSignal
}): Promise<DeliveryQuoteResult> {
	const body: Record<string, string> = {
		...binding(),
		locationId: input.locationId,
		locale: input.locale,
	}
	if (input.placeId) body.placeId = input.placeId
	if (input.address?.trim()) body.address = input.address.trim()
	if (input.unit?.trim()) body.unit = input.unit.trim()
	if (input.sessionToken) body.sessionToken = input.sessionToken
	const response = await fetch(`${regionalUrl()}/delivery/quote`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: input.signal,
	})
	return parseQuoteResult(await readJson(response))
}

export type PlacesSearchState =
	| { status: 'idle'; query: string }
	| { status: 'loading'; query: string }
	| { status: 'ready'; query: string; predictions: PlacePrediction[] }
	| { status: 'error'; query: string; error: unknown }

/**
 * Debounced autocomplete: waits `delay` ms after the last keystroke, aborts
 * the in-flight request when the query changes, and ignores stale answers.
 */
export function createPlacesSearch(options: {
	fetchPredictions: (
		query: string,
		signal: AbortSignal,
	) => Promise<PlacePrediction[]>
	onState: (state: PlacesSearchState) => void
	delay?: number
	minLength?: number
}) {
	const delay = options.delay ?? 250
	const minLength = options.minLength ?? MIN_PLACES_QUERY_LENGTH
	let timer: ReturnType<typeof setTimeout> | null = null
	let controller: AbortController | null = null
	let generation = 0

	const cancel = () => {
		if (timer) clearTimeout(timer)
		timer = null
		controller?.abort()
		controller = null
		generation += 1
	}

	const run = async (query: string) => {
		const current = ++generation
		controller?.abort()
		controller = new AbortController()
		options.onState({ status: 'loading', query })
		try {
			const predictions = await options.fetchPredictions(
				query,
				controller.signal,
			)
			if (current !== generation) return
			options.onState({ status: 'ready', query, predictions })
		} catch (error) {
			if (current !== generation) return
			if ((error as { name?: string })?.name === 'AbortError') return
			options.onState({ status: 'error', query, error })
		}
	}

	return {
		/** Schedules a lookup for `raw` (debounced). */
		search(raw: string) {
			const query = raw.trim()
			cancel()
			if (query.length < minLength) {
				options.onState({ status: 'idle', query })
				return
			}
			timer = setTimeout(() => {
				timer = null
				void run(query)
			}, delay)
		},
		/** Runs immediately (retry button). */
		retry(raw: string) {
			const query = raw.trim()
			cancel()
			if (query.length < minLength) {
				options.onState({ status: 'idle', query })
				return
			}
			void run(query)
		},
		cancel,
	}
}
