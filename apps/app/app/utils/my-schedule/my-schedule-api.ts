import { z } from 'zod'

/**
 * Browser client for the public `/schedule-link` routes on the regional node.
 * The link's token is the only credential; it lives in memory (and this tab's
 * session storage) and travels only in the Authorization header, so it never
 * reaches the App's servers, its logs or a referrer. Every answer is parsed, and
 * a refusal becomes a `MyScheduleApiError` carrying the short machine code.
 */

const shiftSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	positionName: z.string().nullable(),
	positionNameAr: z.string().nullable(),
	startsAt: z.number(),
	endsAt: z.number(),
	localDate: z.string(),
	timeZone: z.string(),
	unpaidBreakMinutes: z.number(),
	notes: z.string().nullable(),
})
export type MyShift = z.infer<typeof shiftSchema>

const scopeSchema = z.object({
	id: z.string(),
	name: z.string().nullable(),
	timeZone: z.string(),
	scheduleVisibility: z.enum(['own', 'team']),
})
export type MyScope = z.infer<typeof scopeSchema>

const scheduleSchema = z.object({
	serverNow: z.number(),
	person: z.object({
		firstName: z.string(),
		firstNameAr: z.string().nullable(),
		locale: z.string().nullable(),
	}),
	scopes: z.array(scopeSchema),
	from: z.string(),
	to: z.string(),
	shifts: z.array(shiftSchema),
	link: z.object({ expiresAt: z.number() }),
})
export type MySchedule = z.infer<typeof scheduleSchema>

const timesSchema = z
	.object({
		clockInAt: z.number().nullable(),
		clockOutAt: z.number().nullable(),
	})
	.nullable()

const editSchema = z.object({
	id: z.string(),
	action: z.string(),
	via: z.string(),
	reason: z.string(),
	hoursDeltaMinutes: z.number().nullable(),
	before: timesSchema,
	after: timesSchema,
	createdAt: z.number(),
})
export type MyTimeCardEdit = z.infer<typeof editSchema>

const timeCardSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	positionName: z.string().nullable(),
	positionNameAr: z.string().nullable(),
	timeZone: z.string(),
	localDate: z.string(),
	clockInAt: z.number(),
	clockOutAt: z.number().nullable(),
	status: z.string(),
	paidMinutes: z.number(),
	unpaidBreakMinutes: z.number(),
	edited: z.boolean(),
	edits: z.array(editSchema),
})
export type MyTimeCard = z.infer<typeof timeCardSchema>

const timeCardsSchema = z.object({
	serverNow: z.number(),
	from: z.string(),
	to: z.string(),
	cards: z.array(timeCardSchema),
})
export type MyTimeCards = z.infer<typeof timeCardsSchema>

const timeOffSchema = z.object({
	id: z.string(),
	category: z.string(),
	startDate: z.string(),
	endDate: z.string(),
	allDay: z.boolean(),
	startMinute: z.number().nullable(),
	endMinute: z.number().nullable(),
	note: z.string().nullable(),
	status: z.string(),
	decisionNote: z.string().nullable(),
	createdAt: z.number(),
})
export type MyTimeOff = z.infer<typeof timeOffSchema>

const availabilitySchema = z.object({
	id: z.string(),
	kind: z.string(),
	weekday: z.number().nullable(),
	date: z.string().nullable(),
	availability: z.string(),
	allDay: z.boolean(),
	startMinute: z.number().nullable(),
	endMinute: z.number().nullable(),
	effectiveFrom: z.string().nullable(),
	effectiveTo: z.string().nullable(),
	note: z.string().nullable(),
	status: z.string(),
	decisionNote: z.string().nullable(),
	createdAt: z.number(),
})
export type MyAvailability = z.infer<typeof availabilitySchema>

const shiftRequestSchema = z.object({
	id: z.string(),
	kind: z.string(),
	shiftId: z.string(),
	localDate: z.string(),
	startsAt: z.number(),
	endsAt: z.number(),
	timeZone: z.string(),
	targetName: z.string().nullable(),
	note: z.string().nullable(),
	status: z.string(),
	decisionNote: z.string().nullable(),
	createdAt: z.number(),
})
export type MyShiftRequest = z.infer<typeof shiftRequestSchema>

const requestsSchema = z.object({
	timeOff: z.array(timeOffSchema),
	availability: z.array(availabilitySchema),
	shiftRequests: z.array(shiftRequestSchema),
})
export type MyRequests = z.infer<typeof requestsSchema>

const teammatesSchema = z.object({
	teammates: z.array(z.object({ id: z.string(), name: z.string() })),
	swapCandidates: z.array(
		z.object({
			id: z.string(),
			staffId: z.string(),
			startsAt: z.number(),
			endsAt: z.number(),
			localDate: z.string(),
			timeZone: z.string(),
			positionName: z.string().nullable(),
			positionNameAr: z.string().nullable(),
		}),
	),
	canSwap: z.boolean(),
})
export type MyTeammates = z.infer<typeof teammatesSchema>

export type TimeOffBody = {
	category: 'unpaid' | 'pto' | 'sick'
	startDate: string
	endDate: string
	allDay: boolean
	startTime?: string
	endTime?: string
	note?: string | null
}

export type AvailabilityBody = {
	rows: Array<{
		kind: 'weekly' | 'one_off'
		weekday?: number
		date?: string
		availability: 'available' | 'unavailable'
		allDay: boolean
		startTime?: string
		endTime?: string
	}>
	replaceWeekly: boolean
}

export type ShiftRequestBody = {
	kind: 'swap' | 'cover' | 'drop'
	shiftId: string
	targetStaffId?: string
	targetShiftId?: string
	note?: string | null
}

/** The server answered with a refusal. `code` is its short machine string. */
export class MyScheduleApiError extends Error {
	readonly status: number
	readonly code: string
	readonly retryAfterSeconds: number

	constructor(status: number, code: string, retryAfterSeconds = 0) {
		super(code)
		this.name = 'MyScheduleApiError'
		this.status = status
		this.code = code
		this.retryAfterSeconds = retryAfterSeconds
	}

	/** The link itself no longer works: nothing on the page can succeed. */
	get linkGone(): boolean {
		return LINK_GONE_CODES.has(this.code)
	}
}

const LINK_GONE_CODES = new Set([
	'invalid_link',
	'link_revoked',
	'link_expired',
	'staff_inactive',
	'schedule_disabled',
])

/** The request never got an answer (offline, DNS, timeout, blocked). */
export class MyScheduleNetworkError extends Error {
	constructor(cause?: unknown) {
		super('network_unavailable')
		this.name = 'MyScheduleNetworkError'
		this.cause = cause
	}
}

const errorBodySchema = z
	.object({
		error: z.string().optional(),
		retryAfterSeconds: z.number().optional(),
	})
	.passthrough()

export type MyScheduleApiOptions = {
	tenantApiUrl: string
	token: string
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

function query(params: Record<string, string | undefined>): string {
	const search = new URLSearchParams()
	for (const [key, value] of Object.entries(params)) {
		if (value) search.set(key, value)
	}
	const text = search.toString()
	return text ? `?${text}` : ''
}

export function createMyScheduleApi(options: MyScheduleApiOptions) {
	const {
		tenantApiUrl,
		token,
		fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
		timeoutMs = 10_000,
	} = options
	const base = tenantApiUrl.replace(/\/+$/, '')

	async function call<S extends z.ZodTypeAny>(
		path: string,
		schema: S,
		init: { method?: string; json?: unknown } = {},
	): Promise<z.infer<S>> {
		const headers = new Headers({
			Accept: 'application/json',
			Authorization: `Bearer ${token}`,
		})
		let body: string | undefined
		if (init.json !== undefined) {
			headers.set('Content-Type', 'application/json')
			body = JSON.stringify(init.json)
		}
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		let response: Response
		try {
			response = await fetchImpl(`${base}/schedule-link${path}`, {
				method: init.method ?? 'GET',
				headers,
				body,
				cache: 'no-store',
				referrerPolicy: 'no-referrer',
				signal: controller.signal,
			})
		} catch (error) {
			throw new MyScheduleNetworkError(error)
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
			throw new MyScheduleApiError(
				response.status,
				(failure.success && failure.data.error) || 'request_failed',
				retry,
			)
		}
		const ok = schema.safeParse(parsed)
		// An HTML error page from a proxy is not an answer: treat it as an outage.
		if (!ok.success) throw new MyScheduleApiError(502, 'malformed_response')
		return ok.data
	}

	const post = <S extends z.ZodTypeAny>(
		path: string,
		schema: S,
		json: unknown,
	) => call(path, schema, { method: 'POST', json })

	return {
		schedule: (range: { from?: string; to?: string } = {}) =>
			call(`/me${query(range)}`, scheduleSchema),
		timeCards: (range: { from?: string; to?: string } = {}) =>
			call(`/me/time-cards${query(range)}`, timeCardsSchema),
		requests: () => call('/me/requests', requestsSchema),
		teammates: (shiftId: string) =>
			call(`/me/teammates${query({ shiftId })}`, teammatesSchema),
		requestTimeOff: (body: TimeOffBody) =>
			post('/me/time-off', timeOffSchema, body),
		cancelTimeOff: (id: string) =>
			post(`/me/time-off/${encodeURIComponent(id)}/cancel`, timeOffSchema, {}),
		submitAvailability: (body: AvailabilityBody) =>
			post('/me/availability', z.array(availabilitySchema), body),
		cancelAvailability: (id: string) =>
			post(
				`/me/availability/${encodeURIComponent(id)}/cancel`,
				availabilitySchema,
				{},
			),
		requestShiftChange: (body: ShiftRequestBody) =>
			post('/me/shift-requests', shiftRequestSchema, body),
		cancelShiftRequest: (id: string) =>
			post(
				`/me/shift-requests/${encodeURIComponent(id)}/cancel`,
				shiftRequestSchema,
				{},
			),
	}
}

export type MyScheduleApi = ReturnType<typeof createMyScheduleApi>
