import {
	type LoyaltyAdjustmentReason,
	loyaltyActivityResponseSchema,
	loyaltyAdjustmentResponseSchema,
	loyaltyMemberDetailResponseSchema,
	type LoyaltyMemberSummary,
	loyaltyMemberSummarySchema,
	loyaltyCustomerMemberResponseSchema,
	type LoyaltyOperatorProgram,
	loyaltyOperatorProgramSchema,
	loyaltyOperatorProgramResponseSchema,
	type LoyaltyOperatorPurchase,
	loyaltyOperatorPurchaseSchema,
	type LoyaltyOperatorRedemption,
	loyaltyOperatorRedemptionSchema,
	type LoyaltyOperatorReward,
	type LoyaltyProgramConfig,
	type LoyaltyPurchaseSource,
	loyaltyRefundResultSchema,
	type LoyaltyReport,
	loyaltyReportSchema,
	loyaltyRequeueResponseSchema,
	loyaltyReviewResponseSchema,
	type LoyaltyRewardDefinition,
	loyaltyRewardResponseSchema,
	loyaltyRewardsResponseSchema,
	loyaltyFeaturesSchema,
	loyaltyGrantSchema,
	type LoyaltyScope,
	loyaltyScopeSchema,
} from '@repo/loyalty'
import { z } from 'zod'

const REFRESH_SKEW_MS = 60_000

const LOYALTY_API_BASE = '/operator/loyalty'

/** A failed regional call. `code` is the API's machine-readable error code. */
export class LoyaltyApiError extends Error {
	status: number
	code: string | null
	body: unknown

	constructor(
		message: string,
		status: number,
		code: string | null = null,
		body?: unknown,
	) {
		super(message)
		this.name = 'LoyaltyApiError'
		this.status = status
		this.code = code
		this.body = body
	}
}

export function loyaltyErrorInfo(error: unknown): {
	status: number | null
	code: string | null
} {
	if (error instanceof LoyaltyApiError) {
		return { status: error.status, code: error.code }
	}
	return { status: null, code: null }
}

/** What `/:org/loyalty/token` answers; mirrors `MintedLoyaltyToken`. */
const loyaltyTokenResponseSchema = z.object({
	jwt: z.string().min(1),
	tenantApiUrl: z.string().url(),
	expiresAt: z.number(),
	scope: loyaltyScopeSchema,
	grants: z.array(loyaltyGrantSchema),
	locationIds: z.array(z.string()).nullable(),
	features: loyaltyFeaturesSchema,
})
export type LoyaltyTokenResponse = z.infer<typeof loyaltyTokenResponseSchema>

export type LoyaltyRequestOptions = {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
	query?: Record<string, string | number | boolean | undefined | null>
	body?: unknown
	headers?: Record<string, string>
	signal?: AbortSignal
}

export type LoyaltyScopedClient = {
	scope: LoyaltyScope
	request<T = unknown>(
		path: string,
		options?: LoyaltyRequestOptions,
	): Promise<T>
	getToken(): Promise<LoyaltyTokenResponse>
	invalidate(): void
}

export type LoyaltyClientPool = {
	orgSlug: string
	forScope(scope: LoyaltyScope): LoyaltyScopedClient
	invalidateAll(): void
}

export function createLoyaltyClientPool({
	orgSlug,
	fetchImpl = fetch,
}: {
	orgSlug: string
	fetchImpl?: typeof fetch
}): LoyaltyClientPool {
	const cached = new Map<string, LoyaltyTokenResponse>()
	const inFlight = new Map<string, Promise<LoyaltyTokenResponse>>()

	async function mintToken(scope: LoyaltyScope): Promise<LoyaltyTokenResponse> {
		const params = new URLSearchParams({ scope })
		const response = await fetchImpl(
			`/${encodeURIComponent(orgSlug)}/loyalty/token?${params.toString()}`,
			{
				method: 'GET',
				headers: { Accept: 'application/json' },
				credentials: 'same-origin',
				cache: 'no-store',
			},
		)
		if (!response.ok) {
			let code: string | null = null
			try {
				const detail = (await response.json()) as { code?: string }
				code = typeof detail?.code === 'string' ? detail.code : null
			} catch {
				// ignore a non-JSON error body
			}
			throw new LoyaltyApiError(
				`Failed to mint loyalty token (${response.status})`,
				response.status,
				code,
			)
		}
		return loyaltyTokenResponseSchema.parse(await response.json())
	}

	async function getOrMint(scope: LoyaltyScope): Promise<LoyaltyTokenResponse> {
		const existing = cached.get(scope)
		if (existing && existing.expiresAt - Date.now() > REFRESH_SKEW_MS) {
			return existing
		}
		const pending = inFlight.get(scope)
		if (pending) return pending

		const promise = mintToken(scope)
			.then((token) => {
				cached.set(scope, token)
				inFlight.delete(scope)
				return token
			})
			.catch((error) => {
				inFlight.delete(scope)
				throw error
			})
		inFlight.set(scope, promise)
		return promise
	}

	return {
		orgSlug,
		forScope(scope) {
			return {
				scope,
				getToken: () => getOrMint(scope),
				invalidate: () => {
					cached.delete(scope)
				},
				async request<T = unknown>(
					path: string,
					options: LoyaltyRequestOptions = {},
				): Promise<T> {
					const execute = async (
						token: LoyaltyTokenResponse,
					): Promise<Response> => {
						const baseUrl = token.tenantApiUrl.replace(/\/+$/, '')
						const relPath = path.startsWith('/') ? path : `/${path}`
						const url = new URL(`${baseUrl}${relPath}`)
						if (options.query) {
							for (const [key, value] of Object.entries(options.query)) {
								if (value !== undefined && value !== null) {
									url.searchParams.set(key, String(value))
								}
							}
						}
						const headers: Record<string, string> = {
							Accept: 'application/json',
							Authorization: `Bearer ${token.jwt}`,
							...options.headers,
						}
						let body: BodyInit | undefined
						if (options.body !== undefined) {
							headers['Content-Type'] = 'application/json'
							body = JSON.stringify(options.body)
						}
						return fetchImpl(url.toString(), {
							method: options.method ?? 'GET',
							headers,
							body,
							cache: 'no-store',
							signal: options.signal,
						})
					}

					let token = await getOrMint(scope)
					let response = await execute(token)
					if (response.status === 401) {
						cached.delete(scope)
						token = await getOrMint(scope)
						response = await execute(token)
					}

					if (!response.ok) {
						let detail: unknown = null
						try {
							detail = await response.json()
						} catch {
							// ignore a non-JSON error body
						}
						const record = detail as {
							message?: string
							error?: string
							code?: string
						} | null
						throw new LoyaltyApiError(
							record?.message ??
								record?.error ??
								`Loyalty API error (${response.status})`,
							response.status,
							typeof record?.code === 'string' ? record.code : null,
							detail,
						)
					}

					if (response.status === 204) {
						return undefined as T
					}
					return (await response.json()) as T
				},
			}
		},
		invalidateAll() {
			cached.clear()
			inFlight.clear()
		},
	}
}

/** `lty-<prefix>-<uuid>`; a retry after a lost response must reuse the key. */
export function newLoyaltyIdempotencyKey(prefix = 'op'): string {
	return `lty-${prefix}-${crypto.randomUUID()}`
}

/**
 * Idempotency key for a form that can be resubmitted: kept while the content
 * is unchanged so a retry replays, rotated after a definite (4xx) rejection or
 * a success.
 */
export type LoyaltySubmitKeyRef = {
	current: { key: string; fingerprint: string | null }
}

export function newLoyaltySubmitKey(
	prefix: string,
): LoyaltySubmitKeyRef['current'] {
	return { key: newLoyaltyIdempotencyKey(prefix), fingerprint: null }
}

export function loyaltyKeyForSubmit(
	ref: LoyaltySubmitKeyRef,
	prefix: string,
	payload: unknown,
): string {
	const fingerprint = JSON.stringify(payload)
	if (
		ref.current.fingerprint !== null &&
		ref.current.fingerprint !== fingerprint
	) {
		ref.current = newLoyaltySubmitKey(prefix)
	}
	ref.current.fingerprint = fingerprint
	return ref.current.key
}

export function afterFailedLoyaltySubmit(
	ref: LoyaltySubmitKeyRef,
	prefix: string,
	error: unknown,
) {
	if (
		error instanceof LoyaltyApiError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 408
	) {
		ref.current = newLoyaltySubmitKey(prefix)
	}
}

// ---------------------------------------------------------------------------
// Typed operator API
// ---------------------------------------------------------------------------

export type LoyaltyMemberDetail = z.infer<
	typeof loyaltyMemberDetailResponseSchema
>
export type LoyaltyActivityPage = z.infer<typeof loyaltyActivityResponseSchema>
export type LoyaltyReviewQueue = z.infer<typeof loyaltyReviewResponseSchema>
export type LoyaltyAdjustmentResult = z.infer<
	typeof loyaltyAdjustmentResponseSchema
>
export type LoyaltyRefundResult = z.infer<typeof loyaltyRefundResultSchema>
/**
 * Sales whose refunds an operator records here: QR tabs paid from the phone.
 * Online orders record refunds on the order; till refunds arrive with the sale.
 */
export type LoyaltyRefundSource = {
	type: 'qr_tab'
	id: string
}

const programEnvelopeSchema = z.object({
	program: loyaltyOperatorProgramSchema,
})
const rewardEnvelopeSchema = loyaltyRewardResponseSchema
const memberEnvelopeSchema = z.object({ member: loyaltyMemberSummarySchema })
const reportEnvelopeSchema = z.object({ report: loyaltyReportSchema })
const redemptionEnvelopeSchema = z.object({
	redemption: loyaltyOperatorRedemptionSchema,
})
const purchaseEnvelopeSchema = z.object({
	purchase: loyaltyOperatorPurchaseSchema,
})

export type LoyaltyClient = {
	getProgram(signal?: AbortSignal): Promise<LoyaltyOperatorProgram | null>
	saveProgram(
		input: { expectedVersion: number | null; config: LoyaltyProgramConfig },
		idempotencyKey?: string,
	): Promise<LoyaltyOperatorProgram>
	setProgramStatus(
		input: { expectedVersion: number; status: 'active' | 'paused' },
		idempotencyKey?: string,
	): Promise<LoyaltyOperatorProgram>
	listRewards(signal?: AbortSignal): Promise<LoyaltyOperatorReward[]>
	createReward(
		definition: LoyaltyRewardDefinition,
		idempotencyKey?: string,
	): Promise<LoyaltyOperatorReward>
	updateReward(
		rewardId: string,
		input: { expectedVersion: number; definition: LoyaltyRewardDefinition },
		idempotencyKey?: string,
	): Promise<LoyaltyOperatorReward>
	setRewardStatus(
		rewardId: string,
		input: { expectedVersion: number; status: 'active' | 'archived' },
		idempotencyKey?: string,
	): Promise<LoyaltyOperatorReward>
	/**
	 * The loyalty account of one customer, or `null` before they have signed
	 * in with a verified phone (accounts open automatically then).
	 */
	getCustomerMember(
		customerId: string,
		signal?: AbortSignal,
	): Promise<LoyaltyMemberSummary | null>
	getMember(
		memberId: string,
		signal?: AbortSignal,
	): Promise<LoyaltyMemberDetail>
	adjustMember(
		memberId: string,
		input: { delta: number; reason: LoyaltyAdjustmentReason; note: string },
		idempotencyKey?: string,
	): Promise<LoyaltyAdjustmentResult>
	setMemberStatus(
		memberId: string,
		input: { status: 'active' | 'suspended' },
		idempotencyKey?: string,
	): Promise<LoyaltyMemberSummary>
	listActivity(
		params?: {
			locationId?: string
			cursor?: string | null
			limit?: number
		},
		signal?: AbortSignal,
	): Promise<LoyaltyActivityPage>
	getReport(
		query: { from: string; to: string },
		signal?: AbortSignal,
	): Promise<LoyaltyReport>
	getReview(signal?: AbortSignal): Promise<LoyaltyReviewQueue>
	resolveRedemption(
		redemptionId: string,
		input: { action: 'consume' | 'release'; note: string },
		idempotencyKey?: string,
	): Promise<LoyaltyOperatorRedemption>
	resolvePurchase(
		purchaseId: string,
		input: { action: 'award' | 'exclude'; note: string },
		idempotencyKey?: string,
	): Promise<LoyaltyOperatorPurchase>
	/**
	 * Tries a parked source again. `queued: false`: nothing was left on it to
	 * reconcile, so it was cleared instead. Sends no `Idempotency-Key`: the
	 * region does not read one here, and asking twice is harmless.
	 */
	requeue(source: {
		type: LoyaltyPurchaseSource
		id: string
	}): Promise<{ queued: boolean }>
	/** Money already returned to the customer; `full` refunds what is left. */
	recordRefund(
		input: {
			source: LoyaltyRefundSource
			amountMinor?: number
			full?: boolean
			note: string
		},
		idempotencyKey?: string,
	): Promise<LoyaltyRefundResult>
}

export function createLoyaltyClient(pool: LoyaltyClientPool): LoyaltyClient {
	const read = pool.forScope('read')
	const setup = pool.forScope('setup')
	const members = pool.forScope('members')
	const reconcile = pool.forScope('reconcile')
	const reports = pool.forScope('reports')

	const idem = (key?: string) => ({
		'Idempotency-Key': key ?? newLoyaltyIdempotencyKey(),
	})

	return {
		async getProgram(signal) {
			const raw = await read.request<unknown>(`${LOYALTY_API_BASE}/program`, {
				signal,
			})
			return loyaltyOperatorProgramResponseSchema.parse(raw).program
		},
		async saveProgram(input, idempotencyKey) {
			const raw = await setup.request<unknown>(`${LOYALTY_API_BASE}/program`, {
				method: 'PUT',
				headers: idem(idempotencyKey),
				body: input,
			})
			return programEnvelopeSchema.parse(raw).program
		},
		async setProgramStatus(input, idempotencyKey) {
			const raw = await setup.request<unknown>(
				`${LOYALTY_API_BASE}/program/status`,
				{ method: 'POST', headers: idem(idempotencyKey), body: input },
			)
			return programEnvelopeSchema.parse(raw).program
		},
		async listRewards(signal) {
			const raw = await read.request<unknown>(`${LOYALTY_API_BASE}/rewards`, {
				signal,
			})
			return loyaltyRewardsResponseSchema.parse(raw).rewards
		},
		async createReward(definition, idempotencyKey) {
			const raw = await setup.request<unknown>(`${LOYALTY_API_BASE}/rewards`, {
				method: 'POST',
				headers: idem(idempotencyKey),
				body: { definition },
			})
			return rewardEnvelopeSchema.parse(raw).reward
		},
		async updateReward(rewardId, input, idempotencyKey) {
			const raw = await setup.request<unknown>(
				`${LOYALTY_API_BASE}/rewards/${encodeURIComponent(rewardId)}`,
				{ method: 'PUT', headers: idem(idempotencyKey), body: input },
			)
			return rewardEnvelopeSchema.parse(raw).reward
		},
		async setRewardStatus(rewardId, input, idempotencyKey) {
			const raw = await setup.request<unknown>(
				`${LOYALTY_API_BASE}/rewards/${encodeURIComponent(rewardId)}/status`,
				{ method: 'POST', headers: idem(idempotencyKey), body: input },
			)
			return rewardEnvelopeSchema.parse(raw).reward
		},
		async getCustomerMember(customerId, signal) {
			const raw = await members.request<unknown>(
				`${LOYALTY_API_BASE}/members/customer/${encodeURIComponent(customerId)}`,
				{ signal },
			)
			return loyaltyCustomerMemberResponseSchema.parse(raw).member
		},
		async getMember(memberId, signal) {
			const raw = await members.request<unknown>(
				`${LOYALTY_API_BASE}/members/${encodeURIComponent(memberId)}`,
				{ signal },
			)
			return loyaltyMemberDetailResponseSchema.parse(raw)
		},
		async adjustMember(memberId, input, idempotencyKey) {
			const raw = await members.request<unknown>(
				`${LOYALTY_API_BASE}/members/${encodeURIComponent(memberId)}/adjust`,
				{ method: 'POST', headers: idem(idempotencyKey), body: input },
			)
			return loyaltyAdjustmentResponseSchema.parse(raw)
		},
		async setMemberStatus(memberId, input, idempotencyKey) {
			const raw = await members.request<unknown>(
				`${LOYALTY_API_BASE}/members/${encodeURIComponent(memberId)}/status`,
				{ method: 'POST', headers: idem(idempotencyKey), body: input },
			)
			return memberEnvelopeSchema.parse(raw).member
		},
		async listActivity(params = {}, signal) {
			const raw = await read.request<unknown>(`${LOYALTY_API_BASE}/activity`, {
				query: {
					locationId: params.locationId,
					cursor: params.cursor ?? undefined,
					limit: params.limit,
				},
				signal,
			})
			return loyaltyActivityResponseSchema.parse(raw)
		},
		async getReport(query, signal) {
			const raw = await reports.request<unknown>(
				`${LOYALTY_API_BASE}/reports`,
				{ query: { from: query.from, to: query.to }, signal },
			)
			return reportEnvelopeSchema.parse(raw).report
		},
		async getReview(signal) {
			const raw = await reconcile.request<unknown>(
				`${LOYALTY_API_BASE}/review`,
				{ signal },
			)
			return loyaltyReviewResponseSchema.parse(raw)
		},
		async resolveRedemption(redemptionId, input, idempotencyKey) {
			const raw = await reconcile.request<unknown>(
				`${LOYALTY_API_BASE}/redemptions/${encodeURIComponent(redemptionId)}/resolve`,
				{ method: 'POST', headers: idem(idempotencyKey), body: input },
			)
			return redemptionEnvelopeSchema.parse(raw).redemption
		},
		async resolvePurchase(purchaseId, input, idempotencyKey) {
			const raw = await reconcile.request<unknown>(
				`${LOYALTY_API_BASE}/purchases/${encodeURIComponent(purchaseId)}/resolve`,
				{ method: 'POST', headers: idem(idempotencyKey), body: input },
			)
			return purchaseEnvelopeSchema.parse(raw).purchase
		},
		async requeue(source) {
			const raw = await reconcile.request<unknown>(
				`${LOYALTY_API_BASE}/requeue`,
				{ method: 'POST', body: { source } },
			)
			return loyaltyRequeueResponseSchema.parse(raw)
		},
		async recordRefund(input, idempotencyKey) {
			const raw = await reconcile.request<unknown>(
				`${LOYALTY_API_BASE}/refunds`,
				{ method: 'POST', headers: idem(idempotencyKey), body: input },
			)
			return loyaltyRefundResultSchema.parse(raw)
		},
	}
}
