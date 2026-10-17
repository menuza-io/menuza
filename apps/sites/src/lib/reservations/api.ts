import {
	type Availability,
	type BookingResponse,
	type CalendarResponse,
	type HoldResponse,
	type ManageView,
	type MineResponse,
	type NotifyMeResponse,
	type ReservationsConfig,
	type SlotRef,
	type WaitlistJoinResponse,
	type WaitlistStatus,
} from './types.ts'
import { randomUuid } from './uuid.ts'

/**
 * Browser-side client for the public `/reservations/*` routes of the regional
 * tenant-api. The organization is resolved by tenant-api from the page's
 * `Origin`; nothing here names an organization. Mutations are POST only. A
 * manage or hold token travels in `X-Reservation-Token`, never in a URL.
 */

export class ReservationsApiError extends Error {
	readonly status: number
	readonly code: string
	readonly body: Record<string, unknown>

	constructor(status: number, code: string, body: Record<string, unknown>) {
		super(code)
		this.name = 'ReservationsApiError'
		this.status = status
		this.code = code
		this.body = body
	}
}

export type ReservationsApiDeps = {
	baseUrl: string
	fetchImpl?: typeof fetch
	/** Sends the signed-in customer's token (refreshing it when it lapsed). */
	authedFetch?: (path: string, init: RequestInit) => Promise<Response>
	isSignedIn?: () => boolean
	/** Drops a customer session the server no longer accepts. */
	clearSession?: () => void
	newKey?: () => string
}

type RequestOptions = {
	method?: 'GET' | 'POST'
	body?: unknown
	headers?: Record<string, string>
	/** Attach the customer token when signed in (binds the booking to them). */
	auth?: boolean
	keepalive?: boolean
}

function defaultKey() {
	return randomUuid()
}

export function createReservationsApi(deps: ReservationsApiDeps) {
	const fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args))
	const baseUrl = deps.baseUrl.replace(/\/$/, '')
	const newKey = deps.newKey ?? defaultKey

	function buildInit(options: RequestOptions): RequestInit {
		const headers = new Headers(options.headers)
		headers.set('X-Client', 'web')
		if (options.body !== undefined) {
			headers.set('Content-Type', 'application/json')
		}
		return {
			method: options.method ?? 'GET',
			headers,
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			keepalive: options.keepalive,
		}
	}

	async function send(
		path: string,
		options: RequestOptions,
	): Promise<Response> {
		const init = buildInit(options)
		const signedIn = options.auth && deps.authedFetch && deps.isSignedIn?.()
		if (signedIn) {
			const res = await deps.authedFetch!(path, init)
			if (res.status !== 401 && res.status !== 403) return res
			// A customer token the server refuses must not block a guest booking:
			// check why, and retry anonymously only when the token itself was the problem.
			const body = (await res
				.clone()
				.json()
				.catch(() => ({}))) as Record<string, unknown>
			if (body.error !== 'forbidden' && body.error !== 'unauthorized') {
				return res
			}
			deps.clearSession?.()
			return fetchImpl(`${baseUrl}${path}`, buildInit(options))
		}
		return fetchImpl(`${baseUrl}${path}`, init)
	}

	async function call<T>(
		path: string,
		options: RequestOptions = {},
	): Promise<T> {
		const res = await send(path, options)
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
		if (!res.ok) {
			throw new ReservationsApiError(
				res.status,
				typeof data.error === 'string' ? data.error : 'error',
				data,
			)
		}
		return data as T
	}

	const tokenHeader = (token: string) => ({ 'X-Reservation-Token': token })

	function query(params: Record<string, string | number | null | undefined>) {
		const search = new URLSearchParams()
		for (const [key, value] of Object.entries(params)) {
			if (value !== null && value !== undefined && value !== '') {
				search.set(key, String(value))
			}
		}
		const text = search.toString()
		return text ? `?${text}` : ''
	}

	return {
		config(locale?: string) {
			return call<ReservationsConfig>(
				`/reservations/config${query({ locale })}`,
			)
		},
		availability(params: {
			locationId: string
			date: string
			partySize: number
			localMin?: number | null
			locale?: string
		}) {
			return call<Availability>(
				`/reservations/availability${query({ ...params })}`,
			)
		},
		calendar(params: {
			locationId: string
			partySize: number
			from: string
			to: string
		}) {
			return call<CalendarResponse>(
				`/reservations/calendar${query({ ...params })}`,
			)
		},
		createHold(input: {
			locationId: string
			slot: SlotRef
			areaPref?: string | null
			replaceHoldToken?: string | null
			turnstileToken?: string | null
			website?: string
		}) {
			return call<HoldResponse>('/reservations/holds', {
				method: 'POST',
				auth: true,
				body: input,
			})
		},
		currentHold(holdToken: string) {
			return call<Omit<HoldResponse, 'holdToken'>>(
				'/reservations/holds/current',
				{
					headers: tokenHeader(holdToken),
				},
			)
		},
		releaseHold(holdToken: string) {
			return call<{ released: boolean }>('/reservations/holds/release', {
				method: 'POST',
				body: { holdToken },
				keepalive: true,
			})
		},
		book(body: Record<string, unknown>, key: string = newKey()) {
			return call<BookingResponse>('/reservations', {
				method: 'POST',
				auth: true,
				body,
				headers: { 'Idempotency-Key': key },
			})
		},
		requestLargeParty(body: Record<string, unknown>, key: string = newKey()) {
			return call<BookingResponse>('/reservations/requests', {
				method: 'POST',
				auth: true,
				body,
				headers: { 'Idempotency-Key': key },
			})
		},
		manage: {
			view(token: string) {
				return call<ManageView>('/reservations/manage', {
					headers: tokenHeader(token),
				})
			},
			availability(
				token: string,
				params: { date?: string; partySize?: number; localMin?: number },
			) {
				return call<Availability>(
					`/reservations/manage/availability${query({ ...params })}`,
					{ headers: tokenHeader(token) },
				)
			},
			modify(
				token: string,
				body: { date?: string; localMin: number; partySize?: number },
			) {
				return call<ManageView>('/reservations/manage/modify', {
					method: 'POST',
					body,
					headers: tokenHeader(token),
				})
			},
			cancel(token: string) {
				return call<ManageView>('/reservations/manage/cancel', {
					method: 'POST',
					body: {},
					headers: tokenHeader(token),
				})
			},
			confirm(token: string) {
				return call<ManageView>('/reservations/manage/confirm', {
					method: 'POST',
					body: {},
					headers: tokenHeader(token),
				})
			},
			runningLate(token: string, minutes: number) {
				return call<ManageView>('/reservations/manage/running-late', {
					method: 'POST',
					body: { minutes },
					headers: tokenHeader(token),
				})
			},
			async ics(token: string): Promise<Blob> {
				const res = await send('/reservations/manage/ics', {
					headers: tokenHeader(token),
				})
				if (!res.ok) throw new ReservationsApiError(res.status, 'error', {})
				return res.blob()
			},
		},
		mine() {
			return call<MineResponse>('/reservations/mine', { auth: true })
		},
		waitlist: {
			join(body: Record<string, unknown>, key: string = newKey()) {
				return call<WaitlistJoinResponse>('/reservations/waitlist/join', {
					method: 'POST',
					auth: true,
					body,
					headers: { 'Idempotency-Key': key },
				})
			},
			status(token: string) {
				return call<WaitlistStatus>('/reservations/waitlist/status', {
					headers: tokenHeader(token),
				})
			},
			leave(token: string) {
				return call<WaitlistStatus>('/reservations/waitlist/status/leave', {
					method: 'POST',
					body: {},
					headers: tokenHeader(token),
				})
			},
			onMyWay(token: string) {
				return call<WaitlistStatus>('/reservations/waitlist/status/on-my-way', {
					method: 'POST',
					body: {},
					headers: tokenHeader(token),
				})
			},
		},
		notifyMe: {
			create(body: Record<string, unknown>, key: string = newKey()) {
				return call<NotifyMeResponse>('/reservations/notify-me', {
					method: 'POST',
					auth: true,
					body,
					headers: { 'Idempotency-Key': key },
				})
			},
			cancel(token: string) {
				return call<{ cancelled: boolean; now: string }>(
					'/reservations/notify-me/cancel',
					{ method: 'POST', body: {}, headers: tokenHeader(token) },
				)
			},
		},
	}
}

export type ReservationsApi = ReturnType<typeof createReservationsApi>
