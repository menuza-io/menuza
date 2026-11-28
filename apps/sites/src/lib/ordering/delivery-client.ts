import { type DeliveryFeePricing } from '@repo/common/delivery-fees'
import { getOrgBinding, tenantFetch } from '~/lib/client-auth'

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
	/**
	 * What the cart needs to price delivery as it changes (#244, #421): the fee
	 * for this address and the table by order size. Absent from an older node,
	 * which then prices by `deliveryFee` alone.
	 */
	pricing?: DeliveryFeePricing
}

export type DeliveryUnavailableReason =
	| 'delivery_disabled'
	| 'geocoding_unavailable'
	| 'store_location_missing'
	| 'no_zones'

/** The saved address (#113) a quote was made for. */
export type QuotedSavedAddress = {
	id: string
	label: string
	notes: string | null
}

export type DeliveryQuoteResult =
	| {
			status: 'deliverable'
			quote: DeliveryQuote
			/** Set when the quote was asked for a saved address (`addressId`). */
			savedAddress?: QuotedSavedAddress
	  }
	| {
			status: 'out_of_range'
			address: QuoteAddress | null
			/** True when no store of a brand delivers to the address (#161). */
			noStore?: boolean
	  }
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

function parseSavedAddress(value: unknown): QuotedSavedAddress | null {
	if (!value || typeof value !== 'object') return null
	const a = value as Record<string, unknown>
	if (!isString(a.id) || !a.id || !isString(a.label)) return null
	return { id: a.id, label: a.label, notes: isString(a.notes) ? a.notes : null }
}

function parsePricing(value: unknown): DeliveryFeePricing | undefined {
	if (!value || typeof value !== 'object') return undefined
	const p = value as Record<string, unknown>
	if (!isNumber(p.baseFee) || p.baseFee < 0 || !Array.isArray(p.steps)) {
		return undefined
	}
	const steps: DeliveryFeePricing['steps'] = []
	for (const step of p.steps) {
		if (!step || typeof step !== 'object') return undefined
		const s = step as Record<string, unknown>
		if (!isNumber(s.from) || !isNumber(s.fee) || s.from < 0 || s.fee < 0) {
			return undefined
		}
		steps.push({ from: s.from, fee: s.fee })
	}
	return { baseFee: p.baseFee, steps, byDistance: p.byDistance === true }
}

function parseQuote(q: Record<string, unknown> | undefined): DeliveryQuote {
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
	const pricing = parsePricing(q.pricing)
	return {
		token: q.token,
		expiresAt: q.expiresAt,
		address,
		zoneId: isString(q.zoneId) ? q.zoneId : '',
		zoneName: isString(q.zoneName) ? q.zoneName : '',
		deliveryFee: q.deliveryFee,
		minimumOrder: q.minimumOrder,
		eta: { min: eta.min, max: eta.max },
		...(pricing ? { pricing } : {}),
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
			const saved = parseSavedAddress(v.savedAddress)
			return {
				status: 'deliverable',
				quote: parseQuote(v.quote as Record<string, unknown> | undefined),
				...(saved ? { savedAddress: saved } : {}),
			}
		}
		case 'out_of_range':
			return {
				status: 'out_of_range',
				address: parseAddress(v.address),
			}
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
	/** A saved address of the signed-in guest (#113), quoted again as it is now. */
	addressId?: string
	/** The items subtotal in major units, so the fee shown fits the cart. */
	subtotal?: number
	signal?: AbortSignal
}): Promise<DeliveryQuoteResult> {
	const body: Record<string, string | number> = {
		...binding(),
		locationId: input.locationId,
		locale: input.locale,
	}
	if (input.subtotal !== undefined && input.subtotal > 0) {
		body.subtotal = input.subtotal
	}
	if (input.addressId) body.addressId = input.addressId
	if (input.placeId) body.placeId = input.placeId
	if (input.address?.trim()) body.address = input.address.trim()
	if (input.unit?.trim()) body.unit = input.unit.trim()
	if (input.sessionToken) body.sessionToken = input.sessionToken
	if (input.addressId) {
		return parseQuoteResult(
			await readJson(await signedInPost('/delivery/quote', body, input.signal)),
		)
	}
	const response = await fetch(`${regionalUrl()}/delivery/quote`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: input.signal,
	})
	return parseQuoteResult(await readJson(response))
}

/**
 * A POST that needs the guest's customer token (a saved address, #113): the
 * session is refreshed once when it expired, and a session the region refuses
 * is a plain `signed_out` error, never a silent typed-address fallback.
 */
async function signedInPost(
	path: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<Response> {
	regionalUrl()
	const { session, response } = await tenantFetch(path, {
		method: 'POST',
		body: JSON.stringify(body),
		signal,
	})
	if (session !== 'ok') {
		throw new DeliveryRequestError(
			session === 'signed_out' ? 'signed_out' : 'session_unavailable',
			401,
		)
	}
	return response
}

/** One store of the picker (#161): how to reach it and, for delivery, its quote. */
export type DeliveryLocationChoice = {
	locationId: string
	name: string
	formattedAddress: string | null
	/** Straight-line distance from the address to the store, meters. */
	distanceMeters: number | null
	/** False when the store is closed now but takes scheduled orders. */
	open: boolean
	/** Prep, busy and delivery minutes now (delivery only). */
	etaMinutes: { min: number; max: number } | null
	quote: DeliveryQuote | null
}

export type DeliveryLocationsResult =
	| { status: 'ok'; locations: DeliveryLocationChoice[] }
	| { status: 'not_found' }
	| { status: 'unavailable'; reason: DeliveryUnavailableReason | string }

export function parseLocationsResult(value: unknown): DeliveryLocationsResult {
	if (!value || typeof value !== 'object') {
		throw new DeliveryRequestError('invalid_locations_response', 502)
	}
	const v = value as Record<string, unknown>
	if (v.status === 'not_found') return { status: 'not_found' }
	if (v.status === 'unavailable') {
		return {
			status: 'unavailable',
			reason: isString(v.reason) ? v.reason : 'delivery_disabled',
		}
	}
	if (v.status !== 'ok' || !Array.isArray(v.locations)) {
		throw new DeliveryRequestError('invalid_locations_response', 502)
	}
	const locations = v.locations.map((entry): DeliveryLocationChoice => {
		const e = (entry ?? {}) as Record<string, unknown>
		if (!isString(e.locationId) || !e.locationId || !isString(e.name)) {
			throw new DeliveryRequestError('invalid_locations_response', 502)
		}
		const eta = e.etaMinutes as Record<string, unknown> | null | undefined
		return {
			locationId: e.locationId,
			name: e.name,
			formattedAddress: isString(e.formattedAddress)
				? e.formattedAddress
				: null,
			distanceMeters: isNumber(e.distanceMeters) ? e.distanceMeters : null,
			open: e.open !== false,
			etaMinutes:
				eta && isNumber(eta.min) && isNumber(eta.max)
					? { min: eta.min, max: eta.max }
					: null,
			quote: e.quote ? parseQuote(e.quote as Record<string, unknown>) : null,
		}
	})
	return { status: 'ok', locations }
}

/**
 * Which store serves an address, or which is nearest (#161): one geocode on the
 * regional node for the whole brand. `purpose: 'delivery'` returns the stores
 * that deliver there, best first, each with a signed quote; `pickup` returns the
 * open stores by distance. A browser location (`point`) is sent only on a
 * guest's tap, goes to the region and is never stored.
 */
export async function requestDeliveryLocations(input: {
	purpose: 'delivery' | 'pickup'
	placeId?: string
	address?: string
	point?: { lat: number; lng: number }
	/** A saved address of the signed-in guest (#113). */
	addressId?: string
	unit?: string
	sessionToken?: string
	locale: string
	subtotal?: number
	signal?: AbortSignal
}): Promise<DeliveryLocationsResult> {
	const body: Record<string, unknown> = {
		...binding(),
		purpose: input.purpose,
		locale: input.locale,
	}
	if (input.placeId) body.placeId = input.placeId
	if (input.address?.trim()) body.address = input.address.trim()
	if (input.point) body.point = input.point
	if (input.addressId) body.addressId = input.addressId
	if (input.unit?.trim()) body.unit = input.unit.trim()
	if (input.sessionToken) body.sessionToken = input.sessionToken
	if (input.subtotal !== undefined && input.subtotal > 0) {
		body.subtotal = input.subtotal
	}
	if (input.addressId) {
		return parseLocationsResult(
			await readJson(
				await signedInPost('/delivery/locations', body, input.signal),
			),
		)
	}
	const response = await fetch(`${regionalUrl()}/delivery/locations`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: input.signal,
	})
	return parseLocationsResult(await readJson(response))
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
