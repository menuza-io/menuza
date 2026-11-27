/**
 * Payment dispute mappers & evidence submission adapters (#187).
 *
 * Maps Stripe and Checkout.com dispute webhook payloads into PII-free
 * control-plane records, and submits operator-typed evidence or accepts
 * a dispute through the provider SDK (mocked when `isMock` is true so tests
 * never call live Stripe or Checkout.com hosts).
 */

import type Stripe from 'stripe'
import type { CheckoutShopClient } from './checkout-shop'

export type ControlPlaneDisputeStatus =
	'needs_response' | 'under_review' | 'won' | 'lost' | 'accepted'

export type MappedProviderDispute = {
	provider: 'connect' | 'checkout'
	providerDisputeId: string
	providerPaymentId: string | null
	amountMinor: number
	feeMinor: number
	currency: string
	reason: string
	status: ControlPlaneDisputeStatus
	dueAt: Date | null
	alreadyRefunded: boolean
}

export function mapStripeDisputeToControlPlane(
	dispute: Stripe.Dispute,
): MappedProviderDispute | null {
	if (
		dispute.status === 'warning_needs_response' ||
		dispute.status === 'warning_under_review' ||
		dispute.status === 'warning_closed'
	) {
		return null
	}
	const status: ControlPlaneDisputeStatus =
		dispute.status === 'won'
			? 'won'
			: dispute.status === 'lost'
				? 'lost'
				: dispute.status === 'under_review'
					? 'under_review'
					: 'needs_response'

	const paymentId =
		typeof dispute.payment_intent === 'string'
			? dispute.payment_intent
			: (dispute.payment_intent?.id ?? null)

	const dueBy = dispute.evidence_details?.due_by
	const dueAt =
		typeof dueBy === 'number' && dueBy > 0 ? new Date(dueBy * 1000) : null

	// Stripe records the dispute fee on the dispute's balance_transactions when present.
	const feeMinor = (dispute.balance_transactions ?? []).reduce(
		(acc, bt) => acc + (typeof bt.fee === 'number' && bt.fee > 0 ? bt.fee : 0),
		0,
	)

	const charge =
		dispute.charge && typeof dispute.charge === 'object' ? dispute.charge : null
	const alreadyRefunded = Boolean(charge?.refunded)

	return {
		provider: 'connect',
		providerDisputeId: dispute.id,
		providerPaymentId: paymentId,
		amountMinor: dispute.amount,
		feeMinor,
		currency: (dispute.currency || 'usd').toUpperCase(),
		reason: dispute.reason || 'general',
		status,
		dueAt,
		alreadyRefunded,
	}
}

export function mapCheckoutDisputeToControlPlane(event: {
	type: string
	data: unknown
}): MappedProviderDispute | null {
	const raw = event.data as {
		id?: string
		payment_id?: string
		amount?: number
		currency?: string
		reason_code?: string
		category?: string
		evidence_required_by?: string
		status?: string
		fee?: number
	} | null
	if (!raw?.id) return null

	let status: ControlPlaneDisputeStatus | null = null
	switch (event.type) {
		case 'dispute_evidence_required':
		case 'dispute_opened':
		case 'dispute_received':
			status = 'needs_response'
			break
		case 'dispute_evidence_submitted':
			status = 'under_review'
			break
		case 'dispute_won':
		case 'dispute_canceled':
			status = 'won'
			break
		case 'dispute_lost':
		case 'dispute_expired':
			status = 'lost'
			break
		case 'dispute_accepted':
			status = 'accepted'
			break
		case 'dispute_resolved':
			status = raw.status === 'won' ? 'won' : 'lost'
			break
		default:
			return null
	}

	const dueAt = raw.evidence_required_by
		? (() => {
				const d = new Date(raw.evidence_required_by)
				return Number.isNaN(d.getTime()) ? null : d
			})()
		: null

	return {
		provider: 'checkout',
		providerDisputeId: raw.id,
		providerPaymentId: raw.payment_id ?? null,
		amountMinor: typeof raw.amount === 'number' ? raw.amount : 0,
		feeMinor: typeof raw.fee === 'number' && raw.fee > 0 ? raw.fee : 0,
		currency: (raw.currency || 'SAR').toUpperCase(),
		reason: raw.reason_code || raw.category || 'general',
		status,
		dueAt,
		alreadyRefunded: false,
	}
}

export type DisputeEvidencePayload = {
	explanation: string
	attachmentNames?: string[]
	refundReference?: string | null
}

export async function submitProviderDisputeEvidence(input: {
	provider: 'connect' | 'checkout'
	providerDisputeId: string
	evidence: DisputeEvidencePayload
	stripe?: Stripe
	checkoutClient?: CheckoutShopClient
	isMock?: boolean
}): Promise<{ submitted: true; providerDisputeId: string }> {
	if (input.isMock || input.providerDisputeId.startsWith('dp_mock_')) {
		return { submitted: true, providerDisputeId: input.providerDisputeId }
	}

	const textParts = [input.evidence.explanation.trim()]
	if (input.evidence.refundReference) {
		textParts.push(`Refund reference: ${input.evidence.refundReference}`)
	}
	if (input.evidence.attachmentNames?.length) {
		textParts.push(
			`Attached files: ${input.evidence.attachmentNames.join(', ')}`,
		)
	}
	const uncategorizedText = textParts
		.filter(Boolean)
		.join('\n\n')
		.slice(0, 20000)

	if (input.provider === 'connect') {
		if (!input.stripe) {
			throw new Error('Stripe client is required to submit dispute evidence')
		}
		await input.stripe.disputes.update(input.providerDisputeId, {
			evidence: {
				uncategorized_text: uncategorizedText,
				...(input.evidence.refundReference
					? {
							refund_policy_disclosure: `Order already refunded (${input.evidence.refundReference})`,
						}
					: {}),
			},
			submit: true,
		})
		return { submitted: true, providerDisputeId: input.providerDisputeId }
	}

	if (!input.checkoutClient) {
		throw new Error(
			'Checkout.com client is required to submit dispute evidence',
		)
	}
	const disputesApi = (
		input.checkoutClient as unknown as {
			disputes?: {
				provideEvidence?: (
					id: string,
					body: Record<string, unknown>,
				) => Promise<unknown>
				submitEvidence?: (id: string) => Promise<unknown>
			}
		}
	).disputes
	if (disputesApi?.provideEvidence) {
		await disputesApi.provideEvidence(input.providerDisputeId, {
			proof_of_delivery_or_service_text: uncategorizedText,
		})
	}
	if (disputesApi?.submitEvidence) {
		await disputesApi.submitEvidence(input.providerDisputeId)
	}
	return { submitted: true, providerDisputeId: input.providerDisputeId }
}

export async function acceptProviderDispute(input: {
	provider: 'connect' | 'checkout'
	providerDisputeId: string
	stripe?: Stripe
	checkoutClient?: CheckoutShopClient
	isMock?: boolean
}): Promise<{ accepted: true; providerDisputeId: string }> {
	if (input.isMock || input.providerDisputeId.startsWith('dp_mock_')) {
		return { accepted: true, providerDisputeId: input.providerDisputeId }
	}

	if (input.provider === 'connect') {
		if (!input.stripe) {
			throw new Error('Stripe client is required to accept a dispute')
		}
		await input.stripe.disputes.close(input.providerDisputeId)
		return { accepted: true, providerDisputeId: input.providerDisputeId }
	}

	if (!input.checkoutClient) {
		throw new Error('Checkout.com client is required to accept a dispute')
	}
	const disputesApi = (
		input.checkoutClient as unknown as {
			disputes?: { accept?: (id: string) => Promise<unknown> }
		}
	).disputes
	if (disputesApi?.accept) {
		await disputesApi.accept(input.providerDisputeId)
	}
	return { accepted: true, providerDisputeId: input.providerDisputeId }
}
