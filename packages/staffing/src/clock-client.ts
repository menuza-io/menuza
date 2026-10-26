import { z } from 'zod'
import { type ClockEvent } from './clock-state.ts'

/**
 * Browser plumbing shared by every time clock client: the kiosk (App `/kiosk`)
 * and the Station till (`/pos/timeclock`). The device secret is the only
 * credential; answers carry a first name and a clock state, nothing else.
 */

const PAUSE_CODES = new Set([
	'kiosk_disabled',
	'pos_disabled',
	'timeclock_disabled',
	'timeclock_not_enabled',
])

export type ClockPunchBody = {
	id: string
	kind: ClockEvent
	pin: string
	staffId?: string
	positionId?: string
	breakKind?: 'meal' | 'rest'
	clientAt: number
	deviceNowAt?: number
	offline: boolean
	cashTipsMinor?: number
}

/** The server answered with a refusal. `code` is its short machine string. */
export class ClockApiError extends Error {
	readonly status: number
	readonly code: string
	readonly retryAfterSeconds: number

	constructor(status: number, code: string, retryAfterSeconds = 0) {
		super(code)
		this.name = 'ClockApiError'
		this.status = status
		this.code = code
		this.retryAfterSeconds = retryAfterSeconds
	}

	/**
	 * The device itself is no longer accepted: pair again. The kill switches
	 * (`kiosk_disabled`, `pos_disabled`) are deliberately not here: it is an operator pause that
	 * will be lifted, and a tablet that forgot its pairing (and its waiting
	 * punches) over it would have to be paired again by hand.
	 */
	get deviceGone(): boolean {
		return this.code === 'device_revoked' || this.code === 'invalid_device'
	}

	/** Only a manager's explicit removal is certain; the rest needs confirming. */
	get certainlyRevoked(): boolean {
		return this.code === 'device_revoked'
	}

	/**
	 * A switch is off (the regional kill switch, or the time clock on this
	 * terminal or for the organization): keep everything, try again later.
	 */
	get paused(): boolean {
		return PAUSE_CODES.has(this.code)
	}

	/**
	 * Worth retrying later without changing anything: an outage or a pause, not
	 * a verdict about this punch.
	 */
	get transient(): boolean {
		return (
			this.status >= 500 ||
			this.status === 429 ||
			this.code === 'backoff' ||
			this.code === 'person_locked'
		)
	}
}

/** The request never got an answer (offline, DNS, timeout, blocked). */
export class ClockNetworkError extends Error {
	constructor(cause?: unknown) {
		super('network_unavailable')
		this.name = 'ClockNetworkError'
		this.cause = cause
	}
}

const errorBodySchema = z
	.object({
		error: z.string().optional(),
		retryAfterSeconds: z.number().optional(),
	})
	.passthrough()

export type ClockRequestOptions = {
	/** `https://node.example/kiosk` or `https://node.example/pos/timeclock`. */
	baseUrl: string
	deviceSecret?: string
	fetchImpl?: typeof fetch
	/** Give up on a request after this long (a hung connection looks offline). */
	timeoutMs?: number
	/** Extra fetch options every call carries, such as the browser cache mode. */
	requestInit?: Pick<RequestInit, 'cache'>
}

/**
 * One JSON request. A refusal throws `ClockApiError` with the server's code; no
 * answer at all throws `ClockNetworkError`; an answer that is not the expected
 * shape (a proxy's HTML page) is treated as an outage.
 */
function trimTrailingSlashes(url: string): string {
	let end = url.length
	while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1
	return end === url.length ? url : url.slice(0, end)
}

export async function clockRequest<S extends z.ZodTypeAny>(
	options: ClockRequestOptions,
	path: string,
	schema: S,
	init: { method?: string; json?: unknown; secret?: string } = {},
): Promise<z.infer<S>> {
	const fetchImpl =
		options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
	const headers = new Headers({ Accept: 'application/json' })
	const secret = init.secret ?? options.deviceSecret
	if (secret) headers.set('Authorization', `Bearer ${secret}`)
	let body: string | undefined
	if (init.json !== undefined) {
		headers.set('Content-Type', 'application/json')
		body = JSON.stringify(init.json)
	}
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
	let response: Response
	let text: string
	try {
		try {
			response = await fetchImpl(
				`${trimTrailingSlashes(options.baseUrl)}${path}`,
				{
					method: init.method ?? 'GET',
					headers,
					body,
					...options.requestInit,
					signal: controller.signal,
				},
			)
		} catch (error) {
			throw new ClockNetworkError(error)
		}
		text = await response.text().catch(() => {
			if (controller.signal.aborted)
				throw new ClockNetworkError(controller.signal.reason)
			return ''
		})
	} finally {
		clearTimeout(timer)
	}
	let parsed: unknown = null
	try {
		parsed = text ? JSON.parse(text) : null
	} catch {
		parsed = null
	}
	if (!response.ok) {
		const failure = errorBodySchema.safeParse(parsed)
		const retryHeader = Number(response.headers.get('Retry-After'))
		const retry =
			(failure.success ? failure.data.retryAfterSeconds : undefined) ??
			(Number.isFinite(retryHeader) ? retryHeader : 0)
		throw new ClockApiError(
			response.status,
			(failure.success && failure.data.error) || 'request_failed',
			retry,
		)
	}
	const ok = schema.safeParse(parsed)
	if (!ok.success) throw new ClockApiError(502, 'malformed_response')
	return ok.data
}
