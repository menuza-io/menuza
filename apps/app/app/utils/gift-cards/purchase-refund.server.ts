import { GIFT_CARD_PERMISSIONS } from '@repo/common/gift-cards'
import { type OrderProviderRefund } from '@repo/common/restaurant-orders'
import { z } from 'zod'
import {
	issueRestaurantOrderProviderRefund,
	loadRestaurantRefundOrg,
	RestaurantOrderRefundError,
} from '#app/utils/restaurant-orders/refunds.server.ts'
import { requireGiftCardAccess } from './access.server.ts'
import { mintGiftCardToken } from './token.server.ts'

const factsSchema = z.object({
	cardId: z.string(),
	refundMinor: z.number().int().positive(),
	currency: z.string().length(3),
	sessionId: z.string().nullable(),
	processor: z.enum(['connect', 'checkout']).nullable(),
	paymentId: z.string().nullable(),
	voided: z.boolean(),
})

export type PurchaseRefundResult =
	| {
			ok: true
			refundMinor: number
			/** `none`: the payment has no provider session to refund (it stays for manual handling). */
			provider: 'done' | 'pending' | 'none'
			voided: boolean
	  }
	| { ok: false; code: string; status: number; unspentMinor?: number }

/**
 * Refunds an online gift card purchase, never more than the unspent balance
 * (#218). Server-side on purpose: the region books the removal of the balance
 * (idempotent per `key`, so a retry replays the same facts) and answers the
 * payment to refund; the App then calls the provider with those facts. The
 * browser never names a payment, so an operator cannot ask the provider to
 * refund anything but this card's own payment.
 */
export async function refundGiftCardPurchase(input: {
	request: Request
	orgSlug: string | undefined
	cardId: string
	/** The click's key: a retry sends the same one. */
	key: string
	amountMinor?: number
}): Promise<PurchaseRefundResult> {
	const access = await requireGiftCardAccess(input.request, input.orgSlug, {
		requireAll: [GIFT_CARD_PERMISSIONS.UPDATE_GIFT_CARD],
	})
	if (access.impersonated) {
		return { ok: false, code: 'forbidden', status: 403 }
	}
	const minted = await mintGiftCardToken({
		organizationId: access.organizationId,
		userId: access.userId,
		actorName: access.userName,
		dataRegion: access.dataRegion,
		scope: 'write',
		grants: access.grants,
		locationIds: access.locationIds,
		features: access.features,
		impersonated: false,
	})
	const response = await fetch(
		`${minted.tenantApiUrl.replace(/\/+$/, '')}/operator/gift-cards/${encodeURIComponent(input.cardId)}/refund-purchase`,
		{
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${minted.jwt}`,
				'Idempotency-Key': input.key,
			},
			body: JSON.stringify(
				input.amountMinor === undefined ? {} : { amountMinor: input.amountMinor },
			),
			redirect: 'error',
			signal: AbortSignal.timeout(15_000),
		},
	)
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
	if (!response.ok) {
		return {
			ok: false,
			code: typeof body.code === 'string' ? body.code : 'refund_failed',
			status: response.status,
			unspentMinor: typeof body.unspentMinor === 'number' ? body.unspentMinor : undefined,
		}
	}
	const facts = factsSchema.safeParse(body)
	if (!facts.success) return { ok: false, code: 'invalid_response', status: 502 }
	const { refundMinor, sessionId, processor, paymentId, currency, voided } = facts.data
	if (!sessionId || !processor) {
		return { ok: true, refundMinor, provider: 'none', voided }
	}
	const org = await loadRestaurantRefundOrg(access.organizationId)
	if (!org) return { ok: false, code: 'organization_not_found', status: 404 }
	const now = new Date().toISOString()
	const refund: OrderProviderRefund = {
		// Stable per card and amount, so a retry reaches the provider's own
		// idempotency and never refunds twice.
		refundId: `gcr_${input.cardId}_${refundMinor}`,
		orderId: `gc:${input.cardId}`,
		tabPaymentId: null,
		amountCents: refundMinor,
		currency,
		processor,
		sessionId,
		paymentId,
		status: 'pending',
		providerRefundId: null,
		createdAt: now,
		updatedAt: now,
	}
	try {
		const outcome = await issueRestaurantOrderProviderRefund(org, refund)
		if (outcome.status === 'failed') {
			return { ok: false, code: outcome.failureCode ?? 'refund_declined', status: 502 }
		}
		return {
			ok: true,
			refundMinor,
			provider: outcome.status === 'succeeded' ? 'done' : 'pending',
			voided,
		}
	} catch (error) {
		if (error instanceof RestaurantOrderRefundError) {
			return { ok: false, code: error.code, status: error.httpStatus }
		}
		throw error
	}
}
