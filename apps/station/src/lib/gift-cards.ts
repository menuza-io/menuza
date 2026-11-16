import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import { z } from 'zod'
import { noteServerDate } from './clock.ts'
import { type PosSettings } from './config.ts'
import { type Session } from './signin.ts'

/**
 * The till's client for the regional gift card routes (`/pos/gift-cards/*`).
 * Online only: selling, topping up and redeeming are never queued, so a till
 * that is offline says so and takes another tender instead. The paired device
 * secret authenticates the terminal and, when sign-in is required, the person's
 * server session goes with it (the named staff member is on every entry). A
 * guest's QR is a one-use token, never the card number. Nothing is stored or
 * logged here: no code, no balance.
 */

const TIMEOUT_MS = 8_000

export class GiftCardApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly balanceMinor: number | null = null,
	) {
		super(code)
		this.name = 'GiftCardApiError'
	}
	/** No network or timeout: gift cards need the internet. */
	get offline() {
		return this.status === 0
	}
	get needsSignIn() {
		return this.code === 'staff_session_required' || this.code === 'staff_session_invalid'
	}
}

const viewSchema = z.object({
	id: z.string(),
	last4: z.string(),
	status: z.string(),
	balanceMinor: z.number().int().nonnegative(),
	currency: z.string(),
	note: z.string().nullable().optional(),
})
export type GiftCardView = z.infer<typeof viewSchema>

const soldSchema = z.object({
	cardId: z.string(),
	last4: z.string(),
	code: z.string().nullable(),
	formattedCode: z.string().nullable(),
	balanceMinor: z.number().int(),
	currency: z.string(),
	status: z.string(),
	saleRef: z.string(),
})
export type SoldGiftCard = z.infer<typeof soldSchema>

const toppedSchema = z.object({
	cardId: z.string(),
	last4: z.string(),
	balanceMinor: z.number().int(),
	currency: z.string(),
})

const redeemedSchema = z.object({
	cardId: z.string(),
	last4: z.string(),
	redeemedMinor: z.number().int().positive(),
	balanceMinor: z.number().int().nonnegative(),
	currency: z.string(),
	reference: z.string().min(1),
})
export type RedeemedGiftCard = z.infer<typeof redeemedSchema>

const refundedSchema = z.object({ balanceMinor: z.number().int() })

const errorSchema = z.object({
	error: z.string().optional(),
	code: z.string().optional(),
	balanceMinor: z.number().int().optional(),
})

export function createGiftCardApi(
	deps: { settings: () => PosSettings; session: () => Session | null },
	fetchImpl: typeof fetch = (...args) => fetch(...args),
) {
	async function call<T>(
		path: string,
		body: unknown,
		schema: z.ZodType<T, unknown>,
		idempotencyKey?: string,
	): Promise<T> {
		const settings = deps.settings()
		if (!settings.deviceToken || !settings.tenantApiUrl) {
			throw new GiftCardApiError(401, 'invalid_device')
		}
		const session = deps.session()
		const sentAt = Date.now()
		let response: Response
		try {
			response = await fetchImpl(
				`${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/gift-cards${path}`,
				{
					method: 'POST',
					cache: 'no-store',
					credentials: 'omit',
					headers: {
						Authorization: `Bearer ${settings.deviceToken}`,
						'Content-Type': 'application/json',
						...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
						...(session?.serverSession
							? { [POS_STAFF_SESSION_HEADER]: session.serverSession.token }
							: {}),
					},
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(TIMEOUT_MS),
				},
			)
		} catch {
			throw new GiftCardApiError(0, 'offline')
		}
		noteServerDate(response, sentAt)
		const raw: unknown = await response.json().catch(() => null)
		if (!response.ok) {
			const parsed = errorSchema.safeParse(raw)
			const code = (parsed.success && (parsed.data.code ?? parsed.data.error)) || `http_${response.status}`
			throw new GiftCardApiError(
				response.status,
				code,
				parsed.success ? (parsed.data.balanceMinor ?? null) : null,
			)
		}
		const result = schema.safeParse(raw)
		if (!result.success) throw new GiftCardApiError(502, 'malformed_response')
		return result.data
	}

	return {
		lookup: (code: string) => call('/lookup', { code }, viewSchema),
		sell: (input: {
			code?: string
			amountMinor: number
			paymentMethod: 'cash' | 'card' | 'other'
			clientRequestId: string
		}) => call('/sell', input, soldSchema, `sell-${input.clientRequestId}`),
		topUp: (input: { code: string; amountMinor: number; clientRequestId: string }) =>
			call('/top-up', input, toppedSchema, `topup-${input.clientRequestId}`),
		redeem: (input: {
			code: string
			amountMinor: number
			saleId: string
			clientRequestId: string
		}) => call('/redeem', input, redeemedSchema, `redeem-${input.clientRequestId}`),
		refund: (input: { reference: string; amountMinor: number; clientRequestId: string }) =>
			call('/refund', input, refundedSchema, `refund-${input.clientRequestId}`),
	}
}

export type GiftCardApi = ReturnType<typeof createGiftCardApi>
