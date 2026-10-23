import { type CLOCK_EVENTS, KIOSK_IDENTIFY_MODES } from '@repo/staffing'
import {
	clockIdentifyResponseSchema,
	clockPunchResponseSchema,
	type KioskIdentifyView,
	type KioskPunchView,
} from '@repo/staffing/clock-flow'
import { z } from 'zod'

/**
 * Browser client for the public `/kiosk` routes on the regional node. The
 * device secret is the only credential; a response carries a first name and a
 * clock state, never a surname, contact detail, pay figure or PIN. Nothing in
 * this file goes through the App's servers.
 */

const kioskConfigSchema = z.object({
	device: z.object({
		id: z.string(),
		name: z.string(),
		scopeId: z.string(),
		identifyMode: z.enum(KIOSK_IDENTIFY_MODES),
		showNextShifts: z.boolean(),
	}),
	scope: z.object({
		name: z.string().nullable(),
		timeZone: z.string().nullable(),
	}),
	serverNow: z.number(),
})
export type KioskConfigView = z.infer<typeof kioskConfigSchema>

const pairResponseSchema = kioskConfigSchema.extend({
	deviceSecret: z.string().min(20),
})

const identifyResponseSchema = clockIdentifyResponseSchema
const punchResponseSchema = clockPunchResponseSchema
export type { KioskIdentifyView, KioskPunchView }

const peopleResponseSchema = z.object({
	people: z.array(
		z.object({
			staffId: z.string(),
			firstName: z.string(),
			lastInitial: z.string(),
		}),
	),
})
export type KioskPersonView = z.infer<
	typeof peopleResponseSchema
>['people'][number]

export type KioskPunchBody = {
	id: string
	kind: (typeof CLOCK_EVENTS)[number]
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
export class KioskApiError extends Error {
	readonly status: number
	readonly code: string
	readonly retryAfterSeconds: number

	constructor(status: number, code: string, retryAfterSeconds = 0) {
		super(code)
		this.name = 'KioskApiError'
		this.status = status
		this.code = code
		this.retryAfterSeconds = retryAfterSeconds
	}

	/**
	 * The device itself is no longer accepted: pair again. The kill switch
	 * (`kiosk_disabled`) is deliberately not here: it is an operator pause that
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

	/** The regional kill switch is on: keep everything, try again later. */
	get paused(): boolean {
		return this.code === 'kiosk_disabled'
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
export class KioskNetworkError extends Error {
	constructor(cause?: unknown) {
		super('network_unavailable')
		this.name = 'KioskNetworkError'
		this.cause = cause
	}
}

export type KioskApiOptions = {
	tenantApiUrl: string
	deviceSecret?: string
	fetchImpl?: typeof fetch
	/** Give up on a request after this long (a hung connection looks offline). */
	timeoutMs?: number
}

const errorBodySchema = z
	.object({
		error: z.string().optional(),
		retryAfterSeconds: z.number().optional(),
	})
	.passthrough()

export function createKioskApi(options: KioskApiOptions) {
	const {
		tenantApiUrl,
		deviceSecret,
		fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
		timeoutMs = 8000,
	} = options
	const base = tenantApiUrl.replace(/\/+$/, '')

	async function call<S extends z.ZodTypeAny>(
		path: string,
		schema: S,
		init: { method?: string; json?: unknown; secret?: string } = {},
	): Promise<z.infer<S>> {
		const headers = new Headers({ Accept: 'application/json' })
		const secret = init.secret ?? deviceSecret
		if (secret) headers.set('Authorization', `Bearer ${secret}`)
		let body: string | undefined
		if (init.json !== undefined) {
			headers.set('Content-Type', 'application/json')
			body = JSON.stringify(init.json)
		}
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		let response: Response
		try {
			response = await fetchImpl(`${base}/kiosk${path}`, {
				method: init.method ?? 'GET',
				headers,
				body,
				cache: 'no-store',
				signal: controller.signal,
			})
		} catch (error) {
			throw new KioskNetworkError(error)
		} finally {
			clearTimeout(timer)
		}
		const text = await response.text().catch(() => '')
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
			throw new KioskApiError(
				response.status,
				(failure.success && failure.data.error) || 'request_failed',
				retry,
			)
		}
		const ok = schema.safeParse(parsed)
		// An HTML error page from a proxy is not a kiosk answer: treat as outage.
		if (!ok.success) throw new KioskApiError(502, 'malformed_response')
		return ok.data
	}

	return {
		pair: (code: string) =>
			call('/pair', pairResponseSchema, { method: 'POST', json: { code } }),
		config: () => call('/config', kioskConfigSchema),
		people: () => call('/people', peopleResponseSchema),
		identify: (pin: string, staffId?: string) =>
			call('/identify', identifyResponseSchema, {
				method: 'POST',
				json: { pin, ...(staffId ? { staffId } : {}) },
			}),
		punch: (request: KioskPunchBody) =>
			call('/punch', punchResponseSchema, { method: 'POST', json: request }),
	}
}

export type KioskApi = ReturnType<typeof createKioskApi>
