import { type z } from 'zod'
import { unauthorizedError } from '../api/api-error'
import { type HttpMethod, type HttpTransport } from '../api/http'
import {
	buildUrl,
	decodeResponse,
	performRequest,
	type QueryItems,
} from '../api/request'
import { type CustomerSession } from '../session/customer-session'
import { authOriginHeader, siteQuery } from '../support/site-address'
import {
	holdReleaseSchema,
	type ReservationAvailability,
	reservationAvailabilitySchema,
	type ReservationBooking,
	reservationBookingSchema,
	type ReservationCalendar,
	reservationCalendarSchema,
	reservationErrorFrom,
	type ReservationGuestDetails,
	type ReservationHold,
	reservationHoldSchema,
	type ReservationManageView,
	reservationManageViewSchema,
	type ReservationMine,
	reservationMineSchema,
	type ReservationPaymentStatus,
	reservationPaymentStatusSchema,
	type ReservationsConfig,
	reservationsConfigSchema,
	type ReservationWaitlistJoin,
	reservationWaitlistJoinSchema,
	type ReservationWaitlistStatus,
	reservationWaitlistStatusSchema,
} from './models'

/** The `X-Client` value; tenant-api records channel `native` for both. */
export type ReservationsClientPlatform = 'ios' | 'android'

type Query = Record<string, string | number | null | undefined>

type Call<Schema extends z.ZodTypeAny> = {
	method: HttpMethod
	path: string
	schema: Schema
	query?: Query
	body?: Record<string, unknown>
	headers?: Record<string, string>
	token?: string
}

/**
 * Typed client for the public `/reservations/*` routes of the regional
 * tenant-api. The app talks to the node that owns the organization's data
 * directly; nothing is proxied through the control plane.
 *
 * Every call
 * - goes through `CustomerSession.authorized`, so it carries the customer's
 *   `Authorization: Bearer` token (a verified customer stands in for
 *   Turnstile) and gets one transparent refresh on `401`,
 * - sends `X-Client: ios | android` (the server records channel `native`),
 * - sends the tenant binding: the site `Origin` for https sites and the
 *   `slug`/`host` query that tenant-api accepts outside production, exactly as
 *   the sign-in calls do.
 *
 * Mutations are POST only. A hold, manage or waitlist token travels in the
 * `X-Reservation-Token` header or the body, never in a URL. Tokens and guest
 * details are never logged: errors carry only the stable `error` code.
 */
export class ReservationsClient {
	readonly platform: ReservationsClientPlatform
	readonly #session: CustomerSession
	readonly #transport: HttpTransport

	constructor(
		session: CustomerSession,
		options: {
			platform: ReservationsClientPlatform
			transport?: HttpTransport
		},
	) {
		this.#session = session
		this.platform = options.platform
		this.#transport = options.transport ?? session.client.transport
	}

	// Discovery

	config(locale?: string | null): Promise<ReservationsConfig> {
		return this.#execute({
			method: 'GET',
			path: '/reservations/config',
			schema: reservationsConfigSchema,
			query: { locale },
		})
	}

	availability(params: {
		locationId: string
		date: string
		partySize: number
		localMin?: number | null
		locale?: string | null
	}): Promise<ReservationAvailability> {
		return this.#execute({
			method: 'GET',
			path: '/reservations/availability',
			schema: reservationAvailabilitySchema,
			query: {
				locationId: params.locationId,
				date: params.date,
				partySize: params.partySize,
				localMin: params.localMin,
				locale: params.locale,
			},
		})
	}

	calendar(params: {
		locationId: string
		partySize: number
		from: string
		to: string
	}): Promise<ReservationCalendar> {
		return this.#execute({
			method: 'GET',
			path: '/reservations/calendar',
			schema: reservationCalendarSchema,
			query: { ...params },
		})
	}

	// Holds and bookings

	/**
	 * Holds a table for the location's `holdMinutes`. A hold the guest abandons
	 * is released with `releaseHold`; replacing a hold passes the old token so
	 * the slot is never double-held.
	 */
	createHold(params: {
		locationId: string
		date: string
		localMin: number
		partySize: number
		serviceId?: string | null
		areaId?: string | null
		replaceHoldToken?: string | null
	}): Promise<ReservationHold> {
		const slot: Record<string, unknown> = {
			date: params.date,
			localMin: params.localMin,
			partySize: params.partySize,
		}
		if (params.serviceId != null) slot.serviceId = params.serviceId
		const body: Record<string, unknown> = {
			locationId: params.locationId,
			slot,
		}
		if (params.areaId != null) body.areaPref = params.areaId
		if (params.replaceHoldToken != null)
			body.replaceHoldToken = params.replaceHoldToken
		return this.#execute({
			method: 'POST',
			path: '/reservations/holds',
			schema: reservationHoldSchema,
			body,
		})
	}

	async releaseHold(holdToken: string): Promise<void> {
		await this.#execute({
			method: 'POST',
			path: '/reservations/holds/release',
			schema: holdReleaseSchema,
			body: { holdToken },
		})
	}

	/**
	 * Books a hold. The `Idempotency-Key` is chosen by the caller (the booking
	 * flow) so a retry after a network error reuses it and the server replays
	 * the first answer instead of booking twice.
	 */
	book(params: {
		holdToken: string
		details: ReservationGuestDetails
		idempotencyKey: string
	}): Promise<ReservationBooking> {
		return this.#execute({
			method: 'POST',
			path: '/reservations',
			schema: reservationBookingSchema,
			body: { ...detailsBody(params.details), holdToken: params.holdToken },
			headers: { 'Idempotency-Key': params.idempotencyKey },
		})
	}

	/** Sends a large-party request (no hold). The booking is `requested` until the restaurant approves it. */
	requestLargeParty(params: {
		locationId: string
		date: string
		localMin: number
		partySize: number
		details: ReservationGuestDetails
		idempotencyKey: string
	}): Promise<ReservationBooking> {
		return this.#execute({
			method: 'POST',
			path: '/reservations/requests',
			schema: reservationBookingSchema,
			body: {
				...detailsBody(params.details),
				locationId: params.locationId,
				slot: {
					date: params.date,
					localMin: params.localMin,
					partySize: params.partySize,
				},
			},
			headers: { 'Idempotency-Key': params.idempotencyKey },
		})
	}

	/** The signed-in customer's bookings with fresh manage tokens (recovers tokens after a reinstall). */
	mine(): Promise<ReservationMine> {
		return this.#execute({
			method: 'GET',
			path: '/reservations/mine',
			schema: reservationMineSchema,
		})
	}

	// Manage (capability token in X-Reservation-Token)

	manage(token: string): Promise<ReservationManageView> {
		return this.#execute({
			method: 'GET',
			path: '/reservations/manage',
			schema: reservationManageViewSchema,
			token,
		})
	}

	manageAvailability(
		token: string,
		params: {
			date?: string | null
			partySize?: number | null
			localMin?: number | null
		} = {},
	): Promise<ReservationAvailability> {
		return this.#execute({
			method: 'GET',
			path: '/reservations/manage/availability',
			schema: reservationAvailabilitySchema,
			query: {
				date: params.date,
				partySize: params.partySize,
				localMin: params.localMin,
			},
			token,
		})
	}

	modify(
		token: string,
		params: {
			localMin: number
			date?: string | null
			partySize?: number | null
		},
	): Promise<ReservationManageView> {
		const body: Record<string, unknown> = { localMin: params.localMin }
		if (params.date != null) body.date = params.date
		if (params.partySize != null) body.partySize = params.partySize
		return this.#manageMutation('/reservations/manage/modify', token, body)
	}

	cancel(token: string): Promise<ReservationManageView> {
		return this.#manageMutation('/reservations/manage/cancel', token, {})
	}

	/** Confirms attendance when the restaurant asked for it. */
	confirm(token: string): Promise<ReservationManageView> {
		return this.#manageMutation('/reservations/manage/confirm', token, {})
	}

	runningLate(token: string, minutes: number): Promise<ReservationManageView> {
		return this.#manageMutation('/reservations/manage/running-late', token, {
			minutes,
		})
	}

	/**
	 * The payment status poll: exactly `{ paymentStatus, reservationStatus, now }`.
	 * The token may be the manage token or the booking's payment token.
	 */
	paymentStatus(token: string): Promise<ReservationPaymentStatus> {
		return this.#execute({
			method: 'GET',
			path: '/reservations/manage/payment',
			schema: reservationPaymentStatusSchema,
			token,
		})
	}

	// Waitlist

	joinWaitlist(params: {
		locationId: string
		name: string
		partySize: number
		phone: string
		smsOptIn: boolean
		locale?: string | null
		idempotencyKey: string
	}): Promise<ReservationWaitlistJoin> {
		const body: Record<string, unknown> = {
			locationId: params.locationId,
			name: params.name,
			partySize: params.partySize,
			phone: params.phone,
			smsOptIn: params.smsOptIn,
		}
		if (params.locale != null) body.locale = params.locale
		return this.#execute({
			method: 'POST',
			path: '/reservations/waitlist/join',
			schema: reservationWaitlistJoinSchema,
			body,
			headers: { 'Idempotency-Key': params.idempotencyKey },
		})
	}

	waitlistStatus(token: string): Promise<ReservationWaitlistStatus> {
		return this.#execute({
			method: 'GET',
			path: '/reservations/waitlist/status',
			schema: reservationWaitlistStatusSchema,
			token,
		})
	}

	leaveWaitlist(token: string): Promise<ReservationWaitlistStatus> {
		return this.#execute({
			method: 'POST',
			path: '/reservations/waitlist/status/leave',
			schema: reservationWaitlistStatusSchema,
			body: {},
			token,
		})
	}

	waitlistOnMyWay(token: string): Promise<ReservationWaitlistStatus> {
		return this.#execute({
			method: 'POST',
			path: '/reservations/waitlist/status/on-my-way',
			schema: reservationWaitlistStatusSchema,
			body: {},
			token,
		})
	}

	// Request plumbing

	#manageMutation(
		path: string,
		token: string,
		body: Record<string, unknown>,
	): Promise<ReservationManageView> {
		return this.#execute({
			method: 'POST',
			path,
			schema: reservationManageViewSchema,
			body,
			token,
		})
	}

	#execute<Schema extends z.ZodTypeAny>(
		call: Call<Schema>,
	): Promise<z.output<Schema>> {
		return this.#session.authorized(async (accessToken) => {
			const client = this.#session.client
			const configuration = client.configuration
			const response = await performRequest(
				this.#transport,
				{
					method: call.method,
					url: buildUrl(
						client.regionalBaseUrl(),
						call.path,
						this.#query(call.query),
					),
					headers: this.#headers(call, accessToken),
					json: call.body,
					timeoutMs: configuration.requestTimeoutMs,
				},
				// A 401 carries no reservation detail; the session refreshes once on it.
				(status, body) =>
					status === 401
						? unauthorizedError()
						: reservationErrorFrom(status, body),
			)
			return decodeResponse(response, call.schema, call.path)
		})
	}

	/** The binding first, then the call's own parameters by name. */
	#query(query: Query = {}): QueryItems {
		const items: QueryItems = []
		const binding = siteQuery(this.#session.client.configuration.siteAddress)
		if (binding) items.push([binding.name, binding.value])
		for (const name of Object.keys(query).sort()) {
			const value = query[name]
			if (value === null || value === undefined) continue
			const text = String(value)
			if (text !== '') items.push([name, text])
		}
		return items
	}

	#headers(
		call: Call<z.ZodTypeAny>,
		accessToken: string,
	): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'X-Client': this.platform,
			Authorization: `Bearer ${accessToken}`,
		}
		const origin = authOriginHeader(
			this.#session.client.configuration.siteAddress,
		)
		if (origin) headers.Origin = origin
		if (call.token !== undefined) headers['X-Reservation-Token'] = call.token
		return { ...headers, ...call.headers }
	}
}

/** The JSON body of `book` and `requestLargeParty`; both use the same guest block as Sites. */
export function detailsBody(
	details: ReservationGuestDetails,
): Record<string, unknown> {
	const guest: Record<string, unknown> = {
		firstName: details.firstName.trim(),
		lastName: details.lastName.trim(),
		phone: details.phone,
	}
	const email = details.email.trim()
	if (email !== '') guest.email = email

	const body: Record<string, unknown> = {
		guest,
		locale: details.locale,
		smsOptIn: details.smsOptIn,
		// The honeypot stays empty; a native app has no Turnstile token (the
		// customer token stands in for it).
		website: '',
	}
	if (details.occasionTagId !== null) body.occasionTagId = details.occasionTagId
	const requests = details.requests.trim()
	if (requests !== '') body.requests = requests
	const dietary = details.dietary.trim()
	if (dietary !== '') body.dietary = dietary
	if (details.areaId !== null) body.areaPref = details.areaId
	if (details.policyTermsVersion !== null) {
		body.policyAccepted = { termsVersion: details.policyTermsVersion }
	}
	return body
}
