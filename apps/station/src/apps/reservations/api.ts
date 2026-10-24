import {
	POS_STAFF_SESSION_HEADER,
	type PosReservationsTokenResponse,
} from '@repo/common/pos-orders'
import {
	waitlistEntryResponseSchema,
	waitlistListingSchema,
	waitlistQuoteSchema,
	type WaitlistListing,
	type WaitlistQuote,
} from '@repo/reservations'
import { z } from 'zod'
import {
	availabilitySchema,
	dayFeedSchema,
	type Availability,
	type DayFeed,
} from './feed.ts'
import { clockSkewMs, noteServerDate } from '~/lib/clock.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'

/**
 * The host stand's client. The till trades its device secret and the signed-in
 * person's session for a short-lived reservations token
 * (`POST /pos/reservations/token`), then calls the day-of-service routes the
 * App uses (`/operator/reservations/book/*`) directly, browser to region.
 *
 * The token lives in memory only, belongs to the person who signed in, and is
 * dropped when the till locks or someone else signs in. Nothing here is
 * stored on the device.
 */

/** The server refused, or could not be reached (`status` 0). */
export class HostApiError extends Error {
	readonly status: number
	readonly code: string
	readonly serverMessage: string | null

	constructor(
		status: number,
		code: string,
		serverMessage: string | null = null,
	) {
		super(code)
		this.name = 'HostApiError'
		this.status = status
		this.code = code
		this.serverMessage = serverMessage
	}

	/** The table is taken for (part of) this party's time; the host may seat anyway. */
	get occupied(): boolean {
		return this.code === 'table_occupied'
	}

	/** Someone else changed it first: reload and look again. */
	get stale(): boolean {
		return (
			this.status === 409 &&
			!this.alreadyDone &&
			/stale|version|conflict/.test(this.code)
		)
	}

	/**
	 * This idempotency key already carried a request (a retry after no answer,
	 * with the form changed since): the first one went through.
	 */
	get alreadyDone(): boolean {
		return this.code === 'idempotency_conflict'
	}

	/**
	 * No answer, or one that says nothing about this request (a timeout, an
	 * outage, a rate limit): retrying sends the same request under the same key.
	 */
	get retryable(): boolean {
		return (
			this.status === 0 ||
			this.status === 408 ||
			this.status === 425 ||
			this.status === 429 ||
			this.status >= 500 ||
			// Refused at the door (sign-in, permission): it never reached the
			// request, so whether the first one landed is still unknown.
			this.status === 401 ||
			this.status === 403
		)
	}

	/** The person must sign in again (an offline sign-in, or a session that ended). */
	get needsSignIn(): boolean {
		return (
			this.code === 'staff_session_required' ||
			this.code === 'staff_session_invalid'
		)
	}

	get offline(): boolean {
		return this.status === 0
	}

	/** The request went out and no answer came back in time: it may have been applied. */
	get unsure(): boolean {
		return this.code === 'timeout'
	}
}

const errorBody = z
	.object({ error: z.string().optional(), message: z.string().optional() })
	.passthrough()

const tokenSchema = z.object({
	token: z.string().min(20),
	expiresAt: z.number(),
	locationId: z.string(),
	canReadGuest: z.boolean(),
	features: z.object({ waitlist: z.boolean(), online: z.boolean() }),
})

/** Refresh this long before the token expires, so a slow tap never lands on a dead one. */
const TOKEN_MARGIN_MS = 60_000
const TIMEOUT_MS = 10_000

export type HostDeps = {
	settings: () => PosSettings
	session: () => Session | null
	fetchImpl?: typeof fetch
	now?: () => number
	/** Server time minus tablet time, as last measured (0 when unknown). */
	skewMs?: () => number
}

/** Seat on a table that another booking also holds, with the host's reason. */
export type Overbook = { overbook?: boolean; overbookReason?: string }

export type StatusTarget =
	'arrived' | 'seated' | 'finished' | 'no_show' | 'cancelled' | 'confirmed'

export function createHostApi(deps: HostDeps) {
	const fetchImpl =
		deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
	const now = deps.now ?? (() => Date.now())
	const skew = deps.skewMs ?? (() => clockSkewMs() ?? 0)
	let cached: {
		forSession: string
		grant: PosReservationsTokenResponse
		/**
		 * When it expires by this tablet's clock. The server's `expiresAt` is in
		 * its time; a tablet running fast would otherwise mint on every call.
		 */
		localExpiresAt: number
	} | null = null
	let inFlight: {
		forSession: string
		promise: Promise<PosReservationsTokenResponse>
	} | null = null
	/** Bumped by `forget`: a token minted for the person before is never kept. */
	let generation = 0

	const base = () => deps.settings().tenantApiUrl.replace(/\/+$/, '')

	async function send(url: string, init: RequestInit): Promise<Response> {
		const sentAt = Date.now()
		try {
			const response = await fetchImpl(url, {
				...init,
				cache: 'no-store',
				signal: AbortSignal.timeout(TIMEOUT_MS),
			})
			noteServerDate(response, sentAt)
			return response
		} catch (error) {
			// No answer in time is not the same as no connection: a write may have landed.
			const timedOut =
				error instanceof DOMException && error.name === 'TimeoutError'
			throw new HostApiError(0, timedOut ? 'timeout' : 'network_unavailable')
		}
	}

	async function refusal(response: Response): Promise<HostApiError> {
		const parsed = errorBody.safeParse(await response.json().catch(() => null))
		return new HostApiError(
			response.status,
			(parsed.success && parsed.data.error) || `http_${response.status}`,
			(parsed.success && parsed.data.message) || null,
		)
	}

	async function mint(sessionToken: string) {
		const { deviceToken } = deps.settings()
		if (!deviceToken) throw new HostApiError(401, 'invalid_device')
		const response = await send(`${base()}/pos/reservations/token`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${deviceToken}`,
				[POS_STAFF_SESSION_HEADER]: sessionToken,
			},
			body: JSON.stringify({ scope: 'book' }),
		})
		if (!response.ok) throw await refusal(response)
		const parsed = tokenSchema.safeParse(
			await response.json().catch(() => null),
		)
		if (!parsed.success) throw new HostApiError(502, 'malformed_response')
		return parsed.data
	}

	/** The current grant, minted when missing, expiring, or for someone else. */
	async function grant(): Promise<PosReservationsTokenResponse> {
		const session = deps.session()
		const sessionToken = session?.serverSession?.token
		if (!sessionToken) throw new HostApiError(401, 'staff_session_required')
		if (
			cached &&
			cached.forSession === sessionToken &&
			cached.localExpiresAt - now() > TOKEN_MARGIN_MS
		)
			return cached.grant
		if (inFlight?.forSession === sessionToken) return inFlight.promise
		const startedIn = generation
		const promise = mint(sessionToken)
			.then((fresh) => {
				if (startedIn === generation)
					cached = {
						forSession: sessionToken,
						grant: fresh,
						localExpiresAt: fresh.expiresAt - skew(),
					}
				return fresh
			})
			.finally(() => {
				if (inFlight?.promise === promise) inFlight = null
			})
		inFlight = { forSession: sessionToken, promise }
		return promise
	}

	async function call<S extends z.ZodTypeAny>(
		method: string,
		path: string,
		schema: S,
		options: { body?: unknown; idempotencyKey?: string; etag?: string } = {},
	): Promise<{ data: z.infer<S>; etag: string | null } | { unchanged: true }> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const { token } = await grant()
			const headers: Record<string, string> = {
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
			}
			if (options.body !== undefined)
				headers['Content-Type'] = 'application/json'
			if (options.idempotencyKey)
				headers['Idempotency-Key'] = options.idempotencyKey
			if (options.etag) headers['If-None-Match'] = options.etag
			const response = await send(
				`${base()}/operator/reservations/book${path}`,
				{
					method,
					headers,
					body:
						options.body === undefined
							? undefined
							: JSON.stringify(options.body),
				},
			)
			if (response.status === 304) return { unchanged: true }
			// A token that died early (the person was removed, the clock jumped): mint once more.
			if (response.status === 401 && attempt === 0) {
				cached = null
				continue
			}
			if (!response.ok) throw await refusal(response)
			const parsed = schema.safeParse(await response.json().catch(() => null))
			if (!parsed.success) throw new HostApiError(502, 'malformed_response')
			return { data: parsed.data, etag: response.headers.get('ETag') }
		}
		throw new HostApiError(401, 'unauthorized')
	}

	async function write(
		path: string,
		body: unknown,
		idempotencyKey: string = crypto.randomUUID(),
	) {
		const result = await call('POST', path, z.unknown(), {
			body,
			idempotencyKey,
		})
		return 'data' in result ? result.data : null
	}

	const locationId = async () => (await grant()).locationId

	return {
		/** What this person may see and use: guest details, waitlist. */
		grant,
		/** Forget the token (the till locked, or someone else signed in). */
		forget() {
			generation += 1
			cached = null
			inFlight = null
		},

		/** Today at this terminal's location, or `unchanged` against `etag`. */
		async day(
			etag?: string,
		): Promise<{ unchanged: true } | { feed: DayFeed; etag: string | null }> {
			const query = new URLSearchParams({ locationId: await locationId() })
			const result = await call('GET', `/day?${query}`, dayFeedSchema, { etag })
			if ('unchanged' in result) return result
			return {
				feed: result.data,
				etag: result.etag ?? result.data.etag ?? null,
			}
		},

		async waitlist(): Promise<WaitlistListing> {
			const query = new URLSearchParams({ locationId: await locationId() })
			const result = await call(
				'GET',
				`/waitlist?${query}`,
				waitlistListingSchema,
			)
			if ('unchanged' in result)
				throw new HostApiError(502, 'malformed_response')
			return result.data
		},

		/** Open times; for changing a booking, without its own table and covers. */
		async availability(
			date: string,
			partySize: number,
			excludeReservationId?: string,
		): Promise<Availability> {
			const query = new URLSearchParams({
				locationId: await locationId(),
				date,
				partySize: String(partySize),
				...(excludeReservationId ? { excludeReservationId } : {}),
			})
			const result = await call(
				'GET',
				`/availability?${query}`,
				availabilitySchema,
			)
			if ('unchanged' in result)
				throw new HostApiError(502, 'malformed_response')
			return result.data
		},

		transition(
			reservationId: string,
			toStatus: StatusTarget,
			options: {
				tableIds?: string[]
				expectedVersion?: number
				reason?: string
			} & Overbook = {},
		) {
			return write(
				`/reservations/${encodeURIComponent(reservationId)}/status`,
				{
					toStatus,
					...options,
				},
			)
		},

		/**
		 * The party's size or time changed ("we're six now", "make it 8:00"): the
		 * only booking fields a till may change. Checked against the version the
		 * host saw.
		 */
		async changeParty(
			reservationId: string,
			change: { partySize?: number; time?: string },
			expectedVersion: number,
		) {
			const result = await call(
				'PATCH',
				`/reservations/${encodeURIComponent(reservationId)}`,
				z.unknown(),
				{
					body: {
						locationId: await locationId(),
						expectedVersion,
						...change,
					},
				},
			)
			return 'data' in result ? result.data : null
		},

		/** The guest called: they will be this many minutes late (0 clears it). */
		runningLate(
			reservationId: string,
			minutes: number,
			expectedVersion: number,
		) {
			return write(
				`/reservations/${encodeURIComponent(reservationId)}/running-late`,
				{ runningLateMin: minutes, expectedVersion },
			)
		},

		/** How long a party of this size would wait now, to tell them before they join. */
		async waitlistQuote(partySize: number): Promise<WaitlistQuote> {
			const query = new URLSearchParams({
				locationId: await locationId(),
				partySize: String(partySize),
			})
			const result = await call(
				'GET',
				`/waitlist/quote?${query}`,
				waitlistQuoteSchema,
			)
			if ('unchanged' in result)
				throw new HostApiError(502, 'malformed_response')
			return result.data
		},

		/** Steps the last status change back (seated to arrived, finished to seated). */
		undo(reservationId: string) {
			return write(
				`/reservations/${encodeURIComponent(reservationId)}/undo`,
				{},
			)
		},

		assign(
			reservationId: string,
			tableIds: string[],
			expectedVersion?: number,
		) {
			return write(
				`/reservations/${encodeURIComponent(reservationId)}/assign`,
				{
					tableIds,
					expectedVersion,
				},
			)
		},

		/**
		 * A party with no booking, seated now. Pass the same `idempotencyKey` when
		 * trying again after no answer, so the party is never seated twice.
		 */
		async walkIn(
			input: {
				partySize: number
				tableIds: string[]
				guestName?: string
			} & Overbook,
			idempotencyKey?: string,
		) {
			return write(
				'/walk-ins',
				{
					locationId: await locationId(),
					partySize: input.partySize,
					tableIds: input.tableIds,
					...(input.overbook
						? { overbook: true, overbookReason: input.overbookReason }
						: {}),
					...(input.guestName?.trim()
						? { guestName: input.guestName.trim() }
						: {}),
				},
				idempotencyKey,
			)
		},

		async book(
			input: {
				date: string
				time: string
				partySize: number
				firstName: string
				lastName: string
				phone: string | null
				notes: string | null
				tableIds?: string[]
			},
			idempotencyKey?: string,
		) {
			return write(
				'/reservations',
				{
					locationId: await locationId(),
					date: input.date,
					time: input.time,
					partySize: input.partySize,
					channel: 'host',
					guest: {
						firstName: input.firstName.trim(),
						lastName: input.lastName.trim(),
						...(input.phone ? { phone: input.phone } : {}),
					},
					...(input.notes ? { staffNotes: input.notes } : {}),
					...(input.tableIds?.length ? { tableIds: input.tableIds } : {}),
				},
				idempotencyKey,
			)
		},

		async joinWaitlist(
			input: {
				displayName: string
				partySize: number
				phone: string | null
			},
			idempotencyKey: string = crypto.randomUUID(),
		) {
			const result = await call(
				'POST',
				'/waitlist',
				waitlistEntryResponseSchema,
				{
					body: {
						locationId: await locationId(),
						displayName: input.displayName.trim(),
						partySize: input.partySize,
						...(input.phone ? { phone: input.phone } : {}),
					},
					idempotencyKey,
				},
			)
			return 'data' in result ? result.data.entry : null
		},

		notifyWaitlist(entryId: string, expectedVersion: number) {
			return write(`/waitlist/${encodeURIComponent(entryId)}/notify`, {
				expectedVersion,
			})
		},

		seatWaitlist(
			entryId: string,
			tableIds: string[],
			expectedVersion: number,
			overbook: Overbook = {},
		) {
			return write(`/waitlist/${encodeURIComponent(entryId)}/seat`, {
				tableIds,
				expectedVersion,
				...overbook,
			})
		},

		leaveWaitlist(entryId: string, expectedVersion: number) {
			return write(`/waitlist/${encodeURIComponent(entryId)}/status`, {
				status: 'left',
				expectedVersion,
			})
		},
	}
}

export type HostApi = ReturnType<typeof createHostApi>
